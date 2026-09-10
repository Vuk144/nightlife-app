/**
 * SupabaseCanonicalStore — the production `CanonicalStore`, writing to the
 * CURRENT Supabase schema (no `event_sources`, no `sync_runs`, no
 * `venue_ingest_staging`, no reconciliation-state columns).
 *
 * Design rules honoured here:
 *
 *  - The engine never imports Supabase. All Supabase-specific code is here.
 *  - Every Supabase call's `error` is checked; failures halt `apply` loudly
 *    with a context-rich `SyncApplyError` and skip all remaining work +
 *    reconciliation. No silent continue-after-partial-failure.
 *  - Writes are explicit per operation (insert / update / link-only). No blanket
 *    "upsert everything".
 *  - Idempotent: identity is `(source_id, external_id)` — the existing UNIQUE
 *    constraint on both `venues` and `events`. A repeated record never inserts
 *    twice.
 *  - Updates target the row by primary key, set ONLY positively-asserted fields
 *    (never write `null` over a non-null canonical value — the model cannot
 *    distinguish "source omitted" from "source says null"), preserve unrelated
 *    fields, and bump `updated_at` / `last_synced_at`.
 *  - Never hard-deletes. Never cancels an event because it disappeared.
 *  - Anything the current schema cannot represent is left unpersisted and
 *    recorded in `SyncApplyResult.deferred`.
 *
 * NOT transactional: supabase-js issues one PostgREST request per call and
 * cannot wrap them in a DB transaction. See the STEP 2 report, section K.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { hashComparable } from "./canonical-hash.ts";
import { comparable, eventComparable, venueComparable } from "./store.ts";
import type {
  CanonicalStore,
  CanonicalEvent,
  CanonicalVenue,
  CityRecord,
  SourceLink,
} from "./store.ts";
import { localToInstant, normalizeTimeOfDay } from "./time-zone.ts";
import type {
  CanonicalUpsert,
  EntityKind,
  JsonValue,
  ReconcileAction,
  SyncApplyError,
  SyncApplyResult,
  SyncPlan,
} from "./types.ts";

const VENUE_COLS =
  "id, city_id, name, description, address, latitude, longitude, opening_time, closing_time, is_active, name_normalized, coordinates_source, website, opening_hours, wikidata, source_id, external_id, source_url, last_synced_at, created_at, updated_at";
const EVENT_COLS =
  "id, venue_id, title, description, start_at, end_at, cover_image_url, ticket_url, is_cancelled, source_id, external_id, source_url, last_synced_at, created_at, updated_at";

type Row = Record<string, unknown>;

class HaltError extends Error {
  constructor(readonly apply: SyncApplyError) {
    super(apply.message);
  }
}

export interface SupabaseCanonicalStoreOptions {
  /** Create a `data_sources` row on demand for an unknown source key. Default true. */
  autoCreateSources?: boolean;
  /** `data_sources.type` used for auto-created rows. Default "api". */
  autoSourceType?: string;
  /** Injectable clock, for deterministic tests. */
  now?: () => string;
}

export class SupabaseCanonicalStore implements CanonicalStore {
  private readonly db: SupabaseClient;
  private readonly autoCreateSources: boolean;
  private readonly autoSourceType: string;
  private readonly now: () => string;
  private readonly sourceIdByKey = new Map<string, string>();
  private readonly sourceKeyById = new Map<string, string>();

  constructor(client: SupabaseClient, opts: SupabaseCanonicalStoreOptions = {}) {
    this.db = client;
    this.autoCreateSources = opts.autoCreateSources ?? true;
    this.autoSourceType = opts.autoSourceType ?? "api";
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // ──────────────────────────────────────────────────────────────────
  //  data_sources resolution
  // ──────────────────────────────────────────────────────────────────
  private async sourceId(sourceKey: string, forWrite: boolean): Promise<string | null> {
    const cached = this.sourceIdByKey.get(sourceKey);
    if (cached) return cached;

    const found = await this.db
      .from("data_sources")
      .select("id, name")
      .eq("name", sourceKey)
      .maybeSingle();
    this.throwOnError(found.error, {
      operation: "read",
      kind: null,
      canonicalId: null,
      sourceKey,
      externalId: null,
      supabaseOp: "data_sources.select",
    });
    if (found.data?.id) {
      const id = String(found.data.id);
      this.cacheSource(sourceKey, id);
      return id;
    }
    if (!forWrite || !this.autoCreateSources) return null;

    const created = await this.db
      .from("data_sources")
      .insert({ name: sourceKey, type: this.autoSourceType })
      .select("id")
      .single();
    this.throwOnError(created.error, {
      operation: "insert",
      kind: null,
      canonicalId: null,
      sourceKey,
      externalId: null,
      supabaseOp: "data_sources.insert",
    });
    const id = String(created.data!.id);
    this.cacheSource(sourceKey, id);
    return id;
  }

  private cacheSource(key: string, id: string): void {
    this.sourceIdByKey.set(key, id);
    this.sourceKeyById.set(id, key);
  }

  private async sourceKeyForId(id: string | null): Promise<string | null> {
    if (!id) return null;
    if (this.sourceKeyById.has(id)) return this.sourceKeyById.get(id)!;
    const res = await this.db.from("data_sources").select("id, name").eq("id", id).maybeSingle();
    this.throwOnError(res.error, {
      operation: "read",
      kind: null,
      canonicalId: null,
      sourceKey: null,
      externalId: null,
      supabaseOp: "data_sources.select",
    });
    if (res.data?.name) {
      this.cacheSource(String(res.data.name), id);
      return String(res.data.name);
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────────────
  //  reads
  // ──────────────────────────────────────────────────────────────────
  async listCities(countryCode?: string): Promise<CityRecord[]> {
    let q = this.db.from("cities").select("id, country_id, name");
    if (countryCode) q = q.eq("country_id", countryCode);
    const { data, error } = await q;
    this.throwOnError(error, ctx("read", null, null, null, null, "cities.select"));
    return (data ?? []).map((r: Row) => ({
      id: String(r.id),
      countryCode: String(r.country_id),
      name: String(r.name),
      timeZone: null, // current schema has no cities.timezone
    }));
  }

  async listVenuesInCity(cityId: string): Promise<CanonicalVenue[]> {
    const { data, error } = await this.db
      .from("venues")
      .select(`${VENUE_COLS}, cities(name, country_id)`)
      .eq("city_id", cityId);
    this.throwOnError(error, ctx("read", "venue", null, null, null, "venues.select"));
    const out: CanonicalVenue[] = [];
    for (const r of data ?? []) out.push(await this.venueRowToCanonical(r as Row));
    return out;
  }

  async getVenueBySource(sourceKey: string, externalId: string): Promise<CanonicalVenue | null> {
    const sid = await this.sourceId(sourceKey, false);
    if (!sid) return null;
    const { data, error } = await this.db
      .from("venues")
      .select(`${VENUE_COLS}, cities(name, country_id)`)
      .eq("source_id", sid)
      .eq("external_id", externalId)
      .maybeSingle();
    this.throwOnError(error, ctx("read", "venue", null, sourceKey, externalId, "venues.select"));
    return data ? this.venueRowToCanonical(data as Row) : null;
  }

  async getVenueById(id: string): Promise<CanonicalVenue | null> {
    const { data, error } = await this.db
      .from("venues")
      .select(`${VENUE_COLS}, cities(name, country_id)`)
      .eq("id", id)
      .maybeSingle();
    this.throwOnError(error, ctx("read", "venue", id, null, null, "venues.select"));
    return data ? this.venueRowToCanonical(data as Row) : null;
  }

  async getEventById(id: string): Promise<CanonicalEvent | null> {
    const { data, error } = await this.db
      .from("events")
      .select(EVENT_COLS)
      .eq("id", id)
      .maybeSingle();
    this.throwOnError(error, ctx("read", "event", id, null, null, "events.select"));
    return data ? eventRowToCanonical(data as Row) : null;
  }

  async getEventBySource(sourceKey: string, externalId: string): Promise<CanonicalEvent | null> {
    const sid = await this.sourceId(sourceKey, false);
    if (!sid) return null;
    const { data, error } = await this.db
      .from("events")
      .select(EVENT_COLS)
      .eq("source_id", sid)
      .eq("external_id", externalId)
      .maybeSingle();
    this.throwOnError(error, ctx("read", "event", null, sourceKey, externalId, "events.select"));
    return data ? eventRowToCanonical(data as Row) : null;
  }

  /**
   * Tier-2 dedup candidate pool: canonical events at `venueId` that *could*
   * share the incoming event's LOCAL calendar date.
   *
   * `events.start_at` is an absolute instant and the current schema has no
   * per-event / per-city time zone, so an exact local-date query is impossible.
   * A single UTC calendar day would MISS a same-local-date event whose instant
   * falls in the neighbouring UTC day (any non-zero zone offset shifts the
   * boundary — e.g. 01:00 in Europe/Belgrade is the previous day in UTC).
   *
   * So this over-fetches a ±1 UTC-day window (max real zone offset is ±14h) and
   * lets the precise, deterministic `compareEvents` in `event-identity.ts` do
   * the actual matching (it requires venue equality + a close start time +
   * strong title/ticket corroboration, so surplus candidates a full day apart
   * can never reach the "automatic" band). Over-fetching is safe; missing a
   * candidate would silently create a duplicate canonical event.
   *
   * NOTE: this is intentionally WIDER than `InMemoryCanonicalStore`'s exact
   * local-date filter — a superset, never a subset.
   */
  async findEventsAtVenueOnDate(venueId: string, localDate: string): Promise<CanonicalEvent[]> {
    const day = localDate.slice(0, 10);
    const from = new Date(`${day}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(`${day}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 2);
    const { data, error } = await this.db
      .from("events")
      .select(EVENT_COLS)
      .eq("venue_id", venueId)
      .gte("start_at", from.toISOString())
      .lt("start_at", to.toISOString());
    this.throwOnError(error, ctx("read", "event", null, null, null, "events.select"));
    return (data ?? []).map((r: Row) => eventRowToCanonical(r));
  }

  async getSourceLink(
    kind: EntityKind,
    sourceKey: string,
    externalId: string,
  ): Promise<SourceLink | null> {
    if (kind === "venue") {
      const v = await this.getVenueBySource(sourceKey, externalId);
      if (!v) return null;
      return this.synthLink("venue", sourceKey, externalId, v.id, venueComparable(v), v, v.sourceUrl);
    }
    const e = await this.getEventBySource(sourceKey, externalId);
    if (!e) return null;
    return this.synthLink("event", sourceKey, externalId, e.id, eventComparable(e), e, e.sourceUrl);
  }

  async listSourceLinks(kind: EntityKind, sourceKey: string): Promise<SourceLink[]> {
    const sid = await this.sourceId(sourceKey, false);
    if (!sid) return [];
    if (kind === "venue") {
      const { data, error } = await this.db
        .from("venues")
        .select(`${VENUE_COLS}, cities(name, country_id)`)
        .eq("source_id", sid);
      this.throwOnError(error, ctx("read", "venue", null, sourceKey, null, "venues.select"));
      const links: SourceLink[] = [];
      for (const r of data ?? []) {
        const v = await this.venueRowToCanonical(r as Row);
        links.push(
          this.synthLink("venue", sourceKey, v.externalId ?? "", v.id, venueComparable(v), v, v.sourceUrl),
        );
      }
      return links;
    }
    const { data, error } = await this.db.from("events").select(EVENT_COLS).eq("source_id", sid);
    this.throwOnError(error, ctx("read", "event", null, sourceKey, null, "events.select"));
    return (data ?? []).map((r: Row) => {
      const e = eventRowToCanonical(r);
      return this.synthLink("event", sourceKey, extId(r), e.id, eventComparable(e), e, e.sourceUrl);
    });
  }

  private synthLink(
    kind: EntityKind,
    sourceKey: string,
    externalId: string,
    canonicalId: string,
    fields: Record<string, JsonValue>,
    row: { createdAt: string; updatedAt: string },
    sourceUrl: string | null,
  ): SourceLink {
    // The current schema has one inline provenance timestamp (`last_synced_at`)
    // and no content hash / status columns. We reconstruct `contentHash` from
    // the canonical fields so change detection still works. `sourceUrl` is
    // provenance metadata reconstructed from the persisted row (`venues` /
    // `events` `source_url`), NOT part of `contentHash`.
    return {
      id: `${kind}:${sourceKey}:${externalId}`,
      kind,
      sourceKey,
      externalId,
      sourceUrl,
      canonicalId,
      contentHash: hashComparable(fields),
      comparableFields: fields,
      reported: {},
      firstSeenAt: row.createdAt,
      lastSeenAt: row.updatedAt,
      lastSyncedAt: row.updatedAt,
      sourceStatus: "active", // no lifecycle column in the current schema
      consecutiveMisses: 0,
    };
  }

  private async venueRowToCanonical(r: Row): Promise<CanonicalVenue> {
    const embedded = r.cities as Row | null | undefined;
    const str = (v: unknown): string | null => (v == null ? null : String(v));
    return {
      id: String(r.id),
      cityId: String(r.city_id),
      cityName: embedded ? String(embedded.name) : "",
      countryCode: embedded ? String(embedded.country_id) : "",
      name: String(r.name),
      normalizedName: str(r.name_normalized) ?? "",
      address: str(r.address),
      coordinates:
        r.latitude != null && r.longitude != null
          ? { latitude: Number(r.latitude), longitude: Number(r.longitude) }
          : null,
      coordinatesSource: str(r.coordinates_source),
      website: str(r.website),
      wikidata: str(r.wikidata),
      openingHours: str(r.opening_hours),
      description: str(r.description),
      openingTime: normalizeTimeOfDay(str(r.opening_time)),
      closingTime: normalizeTimeOfDay(str(r.closing_time)),
      isActive: r.is_active !== false,
      sourceKey: await this.sourceKeyForId(str(r.source_id)),
      externalId: str(r.external_id),
      sourceUrl: str(r.source_url),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  apply
  // ──────────────────────────────────────────────────────────────────
  async apply(plan: SyncPlan, opts: { commit: boolean }): Promise<SyncApplyResult> {
    const result: SyncApplyResult = {
      committed: false,
      inserted: 0,
      updated: 0,
      linked: 0,
      reconciled: 0,
      skipped: 0,
      deferred: [],
      notes: [],
      error: null,
    };

    // Deterministic order: venues before events (FK), then insert < update <
    // link-only, then by external id.
    const rank = (u: CanonicalUpsert): number =>
      (u.kind === "venue" ? 0 : 100) +
      ({ insert: 0, update: 1, "link-only": 2, skip: 3 }[u.operation] ?? 9);
    const ordered = [...plan.upserts].sort(
      (a, b) => rank(a) - rank(b) || a.record.provenance.externalId.localeCompare(b.record.provenance.externalId),
    );

    if (!opts.commit) {
      result.notes.push("dry apply — no writes issued");
      for (const u of ordered) {
        if (u.operation === "skip") result.skipped++;
        else if (u.operation === "insert") result.inserted++;
        else if (u.operation === "update") result.updated++;
        else result.linked++;
      }
      return result;
    }

    try {
      for (const u of ordered) {
        if (u.operation === "skip") {
          result.skipped++;
          continue;
        }
        if (u.kind === "venue") await this.applyVenue(u, result);
        else await this.applyEvent(u, result);
      }

      if (!plan.reconciliation.reconciled) {
        result.notes.push(
          `reconciliation skipped: ${plan.reconciliation.skippedReason ?? "run not healthy"}`,
        );
      } else {
        for (const a of plan.reconciliation.actions) this.planReconcileAction(a, result);
      }

      result.committed = true;
      return result;
    } catch (err) {
      if (err instanceof HaltError) {
        result.error = err.apply;
        result.notes.push(
          "apply halted on first failure — remaining operations and reconciliation NOT attempted",
        );
        return result;
      }
      throw err;
    }
  }

  private async applyVenue(u: CanonicalUpsert, result: SyncApplyResult): Promise<void> {
    if (u.record.kind !== "venue") return;
    const p = u.record.provenance;
    const now = this.now();

    // idempotency: a record already persisted for this (source, external_id)
    // is an update, never a second insert.
    const existing = await this.getVenueBySource(p.sourceKey, p.externalId);

    if (u.operation === "insert" || (u.operation === "update" && !u.canonicalId)) {
      if (existing) {
        await this.updateVenueRow(existing.id, u, result, now, "insert→update (already persisted)");
        return;
      }
      await this.insertVenueRow(u, result, now);
      return;
    }

    if (u.operation === "update" && u.canonicalId) {
      await this.updateVenueRow(u.canonicalId, u, result, now, null);
      return;
    }

    if (u.operation === "link-only" && u.canonicalId) {
      await this.linkVenue(u.canonicalId, u, result, now);
      return;
    }
  }

  private async insertVenueRow(
    u: CanonicalUpsert,
    result: SyncApplyResult,
    now: string,
  ): Promise<void> {
    if (u.record.kind !== "venue") return;
    const f = u.record.fields;
    const p = u.record.provenance;
    // Resolve the city (a pure read) BEFORE touching `data_sources`: if the
    // insert is going to be deferred, it must persist nothing — creating a
    // `data_sources` row for a venue we never write is a wasteful side effect
    // and inconsistent with every other write path, which only calls
    // `sourceId(…, forWrite=true)` once it is committed to writing.
    const cityId = await this.resolveCityId(u.record.scope.countryCode, u.record.scope.cityText);
    if (!cityId) {
      result.deferred.push(
        `venue insert deferred: city "${u.record.scope.cityText}" (${u.record.scope.countryCode}) not in cities table — a source must not create cities`,
      );
      return;
    }
    const sid = await this.sourceId(p.sourceKey, true);
    const row: Row = {
      city_id: cityId,
      name: f.name,
      name_normalized: f.normalizedName || null,
      description: f.description ?? null,
      address: f.address,
      latitude: f.coordinates?.latitude ?? null,
      longitude: f.coordinates?.longitude ?? null,
      coordinates_source: f.coordinatesSource ?? (f.coordinates ? "source" : null),
      opening_time: normalizeTimeOfDay(f.openingTime),
      closing_time: normalizeTimeOfDay(f.closingTime),
      opening_hours: f.openingHours,
      website: f.website,
      wikidata: f.wikidata,
      is_active: f.isActive ?? true,
      source_id: sid,
      external_id: p.externalId,
      source_url: p.sourceUrl,
      last_synced_at: now,
    };
    const res = await this.db.from("venues").insert(row).select("id").single();
    this.throwOnError(
      res.error,
      ctx("insert", "venue", null, p.sourceKey, p.externalId, "venues.insert"),
    );
    result.inserted++;
    result.notes.push(`venue inserted: ${f.name} (${res.data!.id})`);
  }

  private async updateVenueRow(
    canonicalId: string,
    u: CanonicalUpsert,
    result: SyncApplyResult,
    now: string,
    note: string | null,
  ): Promise<void> {
    if (u.record.kind !== "venue") return;
    const f = u.record.fields;
    const p = u.record.provenance;
    const current = await this.getVenueById(canonicalId);
    if (!current) {
      result.deferred.push(`venue update deferred: row ${canonicalId} not found`);
      return;
    }

    const patch: Row = { updated_at: now, last_synced_at: now };
    // positive assertions only — never null a non-null canonical value
    setIf(patch, "name", f.name);
    setIf(patch, "name_normalized", f.normalizedName || null);
    setIf(patch, "address", f.address);
    setIf(patch, "description", f.description ?? null);
    setIf(patch, "website", f.website);
    setIf(patch, "wikidata", f.wikidata);
    setIf(patch, "opening_hours", f.openingHours);
    setIf(patch, "opening_time", normalizeTimeOfDay(f.openingTime));
    setIf(patch, "closing_time", normalizeTimeOfDay(f.closingTime));
    if (f.isActive != null) patch.is_active = f.isActive; // boolean is a positive assertion
    if (f.coordinates && current.coordinatesSource !== "manual") {
      patch.latitude = f.coordinates.latitude;
      patch.longitude = f.coordinates.longitude;
      patch.coordinates_source = f.coordinatesSource ?? "source";
    }
    // `source_url` is provenance metadata, NOT canonical content (never in the
    // content hash). A re-sync from the owning source may refresh it; an
    // omitted / null URL must not erase an existing one (`setIf` skips null).
    setIf(patch, "source_url", p.sourceUrl);
    // claim provenance if the row is unowned
    if (current.sourceKey == null) {
      patch.source_id = await this.sourceId(p.sourceKey, true);
      patch.external_id = p.externalId;
    } else if (current.sourceKey !== p.sourceKey) {
      result.deferred.push(
        `venue ${canonicalId} field update from "${p.sourceKey}" not applied — row owned by "${current.sourceKey}"; multi-source field ownership requires event_sources/venue_sources`,
      );
      return;
    }

    const res = await this.db.from("venues").update(patch).eq("id", canonicalId).select("id").single();
    this.throwOnError(
      res.error,
      ctx("update", "venue", canonicalId, p.sourceKey, p.externalId, "venues.update"),
    );
    result.updated++;
    result.notes.push(`venue updated: ${canonicalId}${note ? ` [${note}]` : ""}`);
  }

  private async linkVenue(
    canonicalId: string,
    u: CanonicalUpsert,
    result: SyncApplyResult,
    now: string,
  ): Promise<void> {
    if (u.record.kind !== "venue") return;
    const p = u.record.provenance;
    const current = await this.getVenueById(canonicalId);
    if (!current) {
      result.deferred.push(`venue link deferred: row ${canonicalId} not found`);
      return;
    }
    if (current.sourceKey == null) {
      const patch: Row = {
        source_id: await this.sourceId(p.sourceKey, true),
        external_id: p.externalId,
        last_synced_at: now,
      };
      setIf(patch, "source_url", p.sourceUrl); // never null over an existing URL
      const res = await this.db
        .from("venues")
        .update(patch)
        .eq("id", canonicalId)
        .select("id")
        .single();
      this.throwOnError(
        res.error,
        ctx("link-only", "venue", canonicalId, p.sourceKey, p.externalId, "venues.update"),
      );
      result.linked++;
      result.notes.push(`venue ${canonicalId}: provenance claimed by "${p.sourceKey}" (no content change)`);
      return;
    }
    if (current.sourceKey === p.sourceKey) {
      // same source re-confirming — refresh the provenance timestamp, and the
      // provenance URL ONLY when it genuinely changed (metadata, not content;
      // an unchanged / null URL must leave the row — and this write — untouched).
      const patch: Row = { last_synced_at: now };
      if (p.sourceUrl != null && p.sourceUrl !== current.sourceUrl) {
        patch.source_url = p.sourceUrl;
      }
      const res = await this.db
        .from("venues")
        .update(patch)
        .eq("id", canonicalId)
        .select("id")
        .single();
      this.throwOnError(
        res.error,
        ctx("link-only", "venue", canonicalId, p.sourceKey, p.externalId, "venues.update"),
      );
      result.linked++;
      return;
    }
    result.deferred.push(
      `venue ${canonicalId}: second source "${p.sourceKey}" link not persisted — row owned by "${current.sourceKey}"; multi-source links require venue_sources`,
    );
  }

  private async applyEvent(u: CanonicalUpsert, result: SyncApplyResult): Promise<void> {
    if (u.record.kind !== "event") return;
    const p = u.record.provenance;
    const f = u.record.fields;
    const now = this.now();
    const venueId = u.resolvedVenueId ?? null;

    if (!venueId) {
      result.deferred.push(
        `event ${p.sourceKey}:${p.externalId} deferred: event-first unresolved venue requires event_ingest_staging or equivalent future schema (no fake canonical venue is created)`,
      );
      return;
    }
    if (!f.timeZone) {
      result.deferred.push(
        `event ${p.sourceKey}:${p.externalId} deferred: cannot compute events.start_at without a time zone`,
      );
      return;
    }
    const startAt = localToInstant(f.startLocal, f.timeZone);
    if (!startAt) {
      result.deferred.push(`event ${p.sourceKey}:${p.externalId} deferred: unparseable startLocal "${f.startLocal}"`);
      return;
    }
    const endAt = f.endLocal ? localToInstant(f.endLocal, f.timeZone) : null;
    const existing = await this.getEventBySource(p.sourceKey, p.externalId);

    if ((u.operation === "insert" || (u.operation === "update" && !u.canonicalId)) && !existing) {
      const sid = await this.sourceId(p.sourceKey, true);
      const row: Row = {
        venue_id: venueId,
        title: f.title,
        description: f.description,
        start_at: startAt,
        end_at: endAt,
        cover_image_url: f.coverImageUrl,
        ticket_url: f.ticketUrl,
        is_cancelled: f.status === "cancelled",
        source_id: sid,
        external_id: p.externalId,
        source_url: p.sourceUrl,
        last_synced_at: now,
      };
      const res = await this.db.from("events").insert(row).select("id").single();
      this.throwOnError(
        res.error,
        ctx("insert", "event", null, p.sourceKey, p.externalId, "events.insert"),
      );
      result.inserted++;
      result.notes.push(`event inserted: ${f.title} (${res.data!.id})`);
      if (f.status === "postponed" || f.status === "rescheduled") {
        result.deferred.push(
          `event ${res.data!.id}: status "${f.status}" flattened to scheduled — current schema only has is_cancelled`,
        );
      }
      return;
    }

    const targetId = existing?.id ?? u.canonicalId;
    if (u.operation === "link-only") {
      await this.linkEvent(targetId, u, result, now);
      return;
    }
    if (!targetId) {
      result.deferred.push(`event ${p.sourceKey}:${p.externalId} deferred: update with no canonical id`);
      return;
    }

    // update
    const current = existing ?? (await this.getEventById(targetId));
    if (!current) {
      result.deferred.push(`event update deferred: row ${targetId} not found`);
      return;
    }

    // Ownership guard — parity with `updateVenueRow`. `existing` was matched by
    // THIS run's own (source, external_id), so it is unambiguously this source's
    // row. But `targetId` can also come from `u.canonicalId` — a tier-2
    // cross-source identity match — and a source must NEVER silently overwrite a
    // canonical event owned by another source.
    let ownerKey: string | null = p.sourceKey;
    if (!existing) {
      ownerKey = await this.sourceKeyForId((await this.rawEventProvenance(targetId)).sourceId);
      if (ownerKey != null && ownerKey !== p.sourceKey) {
        result.deferred.push(
          `event ${targetId} field update from "${p.sourceKey}" not applied — row owned by "${ownerKey}"; multi-source event ownership requires the future event_sources schema`,
        );
        return;
      }
    }

    const patch: Row = { updated_at: now, last_synced_at: now };
    setIf(patch, "title", f.title);
    setIf(patch, "description", f.description);
    setIf(patch, "ticket_url", f.ticketUrl);
    setIf(patch, "cover_image_url", f.coverImageUrl);
    // `source_url` is provenance metadata, not canonical content (never hashed).
    // A re-sync may refresh it; an omitted / null URL must not erase it.
    setIf(patch, "source_url", p.sourceUrl);
    // Claim provenance for an unowned canonical event (app-created, or a tier-2
    // match to an orphan row) — same as `linkEvent` does.
    if (ownerKey == null) {
      patch.source_id = await this.sourceId(p.sourceKey, true);
      patch.external_id = p.externalId;
    }
    // The engine re-resolved the canonical venue this run. `events.venue_id` is
    // NOT NULL but mutable, and `venueId` is guaranteed non-null here (the
    // earlier `!venueId` guard returns). Keeps parity with the in-memory store.
    patch.venue_id = venueId;
    patch.start_at = startAt;
    if (endAt) patch.end_at = endAt;
    if (f.status === "cancelled") patch.is_cancelled = true;
    // an event does NOT get un-cancelled just because a later snapshot omits it

    const res = await this.db.from("events").update(patch).eq("id", targetId).select("id").single();
    this.throwOnError(
      res.error,
      ctx("update", "event", targetId, p.sourceKey, p.externalId, "events.update"),
    );
    result.updated++;
    result.notes.push(`event updated: ${targetId}`);
    // Consistency with the INSERT path: the current schema can only persist
    // is_cancelled, so a "postponed" / "rescheduled" status is flattened to
    // scheduled — record it rather than silently dropping the distinction.
    if (f.status === "postponed" || f.status === "rescheduled") {
      result.deferred.push(
        `event ${targetId}: status "${f.status}" flattened to scheduled — current schema only has is_cancelled`,
      );
    }
  }

  private async linkEvent(
    canonicalId: string | null,
    u: CanonicalUpsert,
    result: SyncApplyResult,
    now: string,
  ): Promise<void> {
    const p = u.record.provenance;
    if (!canonicalId) {
      result.deferred.push(`event link deferred: no canonical id for ${p.sourceKey}:${p.externalId}`);
      return;
    }
    const current = await this.getEventById(canonicalId);
    if (!current) {
      result.deferred.push(`event link deferred: row ${canonicalId} not found`);
      return;
    }
    const currentProv = await this.rawEventProvenance(canonicalId);
    const currentSourceKey = await this.sourceKeyForId(currentProv.sourceId);
    if (currentSourceKey == null) {
      const patch: Row = {
        source_id: await this.sourceId(p.sourceKey, true),
        external_id: p.externalId,
        last_synced_at: now,
      };
      setIf(patch, "source_url", p.sourceUrl); // never null over an existing URL
      const res = await this.db
        .from("events")
        .update(patch)
        .eq("id", canonicalId)
        .select("id")
        .single();
      this.throwOnError(
        res.error,
        ctx("link-only", "event", canonicalId, p.sourceKey, p.externalId, "events.update"),
      );
      result.linked++;
      return;
    }
    if (currentSourceKey === p.sourceKey) {
      // same source re-confirming — refresh the timestamp, and the provenance
      // URL ONLY when it genuinely changed (metadata, not content; an unchanged
      // or null URL must not touch the row or this write).
      const patch: Row = { last_synced_at: now };
      if (p.sourceUrl != null && p.sourceUrl !== currentProv.sourceUrl) {
        patch.source_url = p.sourceUrl;
      }
      const res = await this.db
        .from("events")
        .update(patch)
        .eq("id", canonicalId)
        .select("id")
        .single();
      this.throwOnError(
        res.error,
        ctx("link-only", "event", canonicalId, p.sourceKey, p.externalId, "events.update"),
      );
      result.linked++;
      return;
    }
    result.deferred.push(
      `event ${canonicalId}: second source "${p.sourceKey}" link not persisted — row owned by "${currentSourceKey}"; multi-source event links require event_sources`,
    );
  }

  private async rawEventProvenance(
    id: string,
  ): Promise<{ sourceId: string | null; sourceUrl: string | null }> {
    const { data, error } = await this.db
      .from("events")
      .select("source_id, source_url")
      .eq("id", id)
      .maybeSingle();
    this.throwOnError(error, ctx("read", "event", id, null, null, "events.select"));
    return {
      sourceId: data?.source_id == null ? null : String(data.source_id),
      sourceUrl: data?.source_url == null ? null : String(data.source_url),
    };
  }

  private planReconcileAction(a: ReconcileAction, result: SyncApplyResult): void {
    if (a.transition === "no-op" || a.transition === "keep-active") {
      // "keep-active" rows were already touched (last_synced_at) by their upsert.
      return;
    }
    // mark-stale / mark-missing / mark-gone
    result.deferred.push(
      `reconciliation ${a.transition} for ${a.kind} ${a.key} NOT persisted — current schema has no source_status / consecutive_misses column. No hard delete, no cancellation.`,
    );
  }

  private async resolveCityId(
    countryCode: string | null,
    cityText: string | null,
  ): Promise<string | null> {
    if (!cityText) return null;
    let q = this.db.from("cities").select("id, country_id, name").eq("name", cityText);
    if (countryCode) q = q.eq("country_id", countryCode);
    const { data, error } = await q;
    this.throwOnError(error, ctx("read", "venue", null, null, null, "cities.select"));
    const rows = (data ?? []) as Row[];
    return rows.length === 1 ? String(rows[0].id) : null;
  }

  private throwOnError(
    error: { message?: string; code?: string } | null,
    where: Omit<SyncApplyError, "message" | "code">,
  ): void {
    if (!error) return;
    throw new HaltError({
      ...where,
      message: error.message ?? "unknown Supabase error",
      code: error.code ?? null,
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────
function setIf(patch: Row, key: string, value: unknown): void {
  if (value !== null && value !== undefined) patch[key] = value;
}

function extId(r: Row): string {
  return r.external_id == null ? "" : String(r.external_id);
}

function ctx(
  operation: SyncApplyError["operation"],
  kind: EntityKind | null,
  canonicalId: string | null,
  sourceKey: string | null,
  externalId: string | null,
  supabaseOp: string,
): Omit<SyncApplyError, "message" | "code"> {
  return { operation, kind, canonicalId, sourceKey, externalId, supabaseOp };
}

/**
 * TIMEZONE LIMITATION (current schema): an incoming event's local wall-clock +
 * IANA zone are collapsed into the absolute `events.start_at` / `events.end_at`
 * instants on write. The schema has NO per-event / per-city timezone column, so
 * the original zone CANNOT be reconstructed on read — `timeZone` is honestly
 * `null` and `startLocal` / `endLocal` are the offset-bearing instant strings.
 *
 * This is deterministic and machine-independent: `comparable()` /
 * `eventComparable()` compare `toComparableInstant(<offset-bearing string>, null)`
 * which resolves via the explicit offset (never `Date.parse` of a zone-less
 * string, never the host process zone). Change detection therefore works off the
 * persisted instant, and a re-sync of the same event reads back UNCHANGED.
 */
function eventRowToCanonical(r: Row): CanonicalEvent {
  return {
    id: String(r.id),
    venueId: String(r.venue_id),
    title: String(r.title),
    description: r.description == null ? null : String(r.description),
    startLocal: String(r.start_at), // an absolute instant — see TIMEZONE LIMITATION above
    timeZone: null, // NOT reconstructable from the current schema — never a stale guess
    endLocal: r.end_at == null ? null : String(r.end_at),
    status: r.is_cancelled === true ? "cancelled" : "scheduled",
    ticketUrl: r.ticket_url == null ? null : String(r.ticket_url),
    coverImageUrl: r.cover_image_url == null ? null : String(r.cover_image_url),
    canonicalSourceKey: "",
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Re-export so callers can build a comparable for an incoming record. */
export { comparable };
