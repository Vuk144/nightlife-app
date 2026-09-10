/**
 * The canonical store PORT.
 *
 * The engine talks to persistence only through this interface. Reads are used
 * by `planSync` (identity resolution, change detection, reconciliation input).
 *
 *   - `SupabaseCanonicalStore` (`./supabase-store.ts`) — production, writes to
 *     the CURRENT Supabase schema via the service-role client.
 *   - `InMemoryCanonicalStore` — a working double for tests, with a real
 *     `apply` so the "source changed → canonical changed → app read sees it"
 *     flow is proven end-to-end without a database.
 *
 * The engine MUST NOT import Supabase. All Supabase-specific code lives in the
 * `SupabaseCanonicalStore` implementation.
 */

import { hashComparable } from "./canonical-hash.ts";
import { eventInstantForComparison, normalizeTimeOfDay } from "./time-zone.ts";
import type {
  CanonicalUpsert,
  EntityKind,
  GeoPoint,
  JsonValue,
  ReconcileAction,
  SourceStatus,
  SyncApplyResult,
  SyncPlan,
} from "./types.ts";

export interface CityRecord {
  id: string;
  countryCode: string;
  name: string;
  timeZone: string | null;
}

export interface CanonicalVenue {
  id: string;
  cityId: string;
  cityName: string;
  countryCode: string;
  name: string;
  normalizedName: string;
  address: string | null;
  coordinates: GeoPoint | null;
  coordinatesSource: string | null;
  website: string | null;
  wikidata: string | null;
  openingHours: string | null;
  description: string | null;
  openingTime: string | null;
  closingTime: string | null;
  isActive: boolean;
  sourceKey: string | null;
  externalId: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The canonical comparable-field projection of a persisted venue. A
 * `CanonicalStore` uses this to reconstruct the change-detection hash from a
 * stored row (the current schema has no `content_hash` column). It MUST match
 * `comparable()` for a venue record field-for-field.
 */
export function venueComparable(v: CanonicalVenue): Record<string, JsonValue> {
  return {
    name: v.name,
    normalizedName: v.normalizedName,
    address: v.address,
    lat: v.coordinates?.latitude ?? null,
    lon: v.coordinates?.longitude ?? null,
    website: v.website,
    wikidata: v.wikidata,
    openingHours: v.openingHours,
    description: v.description,
    // Times persist as `HH:MM` (the store normalizes on write AND read); the
    // projection normalizes too so it never depends on how the row got its value.
    openingTime: normalizeTimeOfDay(v.openingTime),
    closingTime: normalizeTimeOfDay(v.closingTime),
    isActive: v.isActive,
  };
}

/** Canonical comparable-field projection of a persisted event. Matches `comparable()`. */
export function eventComparable(e: CanonicalEvent): Record<string, JsonValue> {
  return {
    title: e.title,
    // Mirror the persistence transform (`localToInstant`), NOT the wall-clock —
    // a bare `YYYY-MM-DD` is local midnight in `timeZone`, exactly as the store
    // wrote it to `events.start_at`.
    startInstant: eventInstantForComparison(e.startLocal, e.timeZone),
    endInstant: eventInstantForComparison(e.endLocal, e.timeZone),
    isCancelled: e.status === "cancelled",
    ticketUrl: e.ticketUrl,
    coverImageUrl: e.coverImageUrl,
    description: e.description,
  };
}

export interface CanonicalEvent {
  id: string;
  venueId: string;
  title: string;
  description: string | null;
  /**
   * The event's start. Depending on the store this is EITHER a local wall-clock
   * (`"2026-07-01T22:00"`, needs `timeZone` to resolve) OR an already-absolute
   * offset-bearing instant (`"2026-07-01T20:00:00+00:00"`, from `events.start_at`).
   * For any lifecycle / reconciliation / comparison decision, derive the
   * absolute instant with `toInstantMs(startLocal, timeZone)` — NEVER
   * `Date.parse(startLocal)`, which would apply the host process timezone to a
   * zone-less string.
   */
  startLocal: string;
  timeZone: string | null;
  endLocal: string | null;
  status: "scheduled" | "cancelled" | "postponed" | "rescheduled";
  ticketUrl: string | null;
  coverImageUrl: string | null;
  canonicalSourceKey: string;
  /** Provenance metadata — the source's canonical URL for this record. Never in the content hash. */
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceLink {
  id: string;
  kind: EntityKind;
  sourceKey: string;
  externalId: string;
  sourceUrl: string | null;
  canonicalId: string;
  contentHash: string;
  comparableFields: Record<string, JsonValue>;
  reported: Record<string, JsonValue>;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncedAt: string;
  sourceStatus: SourceStatus;
  consecutiveMisses: number;
}

export interface CanonicalStore {
  // ── reads ──────────────────────────────────────────────────────────
  listCities(countryCode?: string): Promise<CityRecord[]>;
  listVenuesInCity(cityId: string): Promise<CanonicalVenue[]>;
  getVenueBySource(sourceKey: string, externalId: string): Promise<CanonicalVenue | null>;
  getVenueById(id: string): Promise<CanonicalVenue | null>;
  getEventById(id: string): Promise<CanonicalEvent | null>;
  getEventBySource(sourceKey: string, externalId: string): Promise<CanonicalEvent | null>;
  findEventsAtVenueOnDate(venueId: string, localDate: string): Promise<CanonicalEvent[]>;
  getSourceLink(
    kind: EntityKind,
    sourceKey: string,
    externalId: string,
  ): Promise<SourceLink | null>;
  listSourceLinks(kind: EntityKind, sourceKey: string): Promise<SourceLink[]>;

  // ── writes: implemented in the NEXT task ───────────────────────────
  apply(plan: SyncPlan, opts: { commit: boolean }): Promise<SyncApplyResult>;
}

// ─────────────────────────────────────────────────────────────────────
//  In-memory double
// ─────────────────────────────────────────────────────────────────────

export interface InMemorySeed {
  cities?: CityRecord[];
  venues?: CanonicalVenue[];
  events?: CanonicalEvent[];
  sourceLinks?: SourceLink[];
}

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;
const dateOf = (value: string): string => value.slice(0, 10);

/**
 * Deep copy at the persistence boundary. A record the store hands back — or
 * stores — must never alias the caller's object, another internal record, or a
 * seed object; otherwise a mutation on either side crosses the boundary and
 * `SupabaseCanonicalStore` (which round-trips every value through PostgREST
 * JSON) would not behave the same. All the store's data types are plain,
 * JSON-shaped values, so `structuredClone` is exact.
 */
const snapshot = <T>(value: T): T => structuredClone(value);

/**
 * Comparable-field projection — the fields that matter for "did the canonical
 * data change". A `CanonicalStore` must be able to reconstruct the SAME shape
 * from a persisted row, so this only contains fields the current schema stores.
 */
export function comparable(record: CanonicalUpsert["record"]): Record<string, JsonValue> {
  if (record.kind === "venue") {
    const f = record.fields;
    return {
      name: f.name,
      normalizedName: f.normalizedName,
      address: f.address,
      lat: f.coordinates?.latitude ?? null,
      lon: f.coordinates?.longitude ?? null,
      website: f.website,
      wikidata: f.wikidata,
      openingHours: f.openingHours,
      description: f.description ?? null,
      // The store persists (and reconstructs) times as `HH:MM` via
      // `normalizeTimeOfDay`; the comparable must use the SAME shape or a source
      // that emits e.g. `"20:00:00"` loops UPDATED forever against the `"20:00"`
      // that was stored.
      openingTime: normalizeTimeOfDay(f.openingTime),
      closingTime: normalizeTimeOfDay(f.closingTime),
      isActive: f.isActive ?? true,
    };
  }
  const f = record.fields;
  // Only fields the CURRENT `events` schema can persist AND reconstruct.
  // `promoter` / lineup have no column; the local start is reduced to the SAME
  // absolute instant `events.start_at` stores (see `eventInstantForComparison`).
  return {
    title: f.title,
    startInstant: eventInstantForComparison(f.startLocal, f.timeZone),
    endInstant: eventInstantForComparison(f.endLocal, f.timeZone),
    isCancelled: f.status === "cancelled",
    ticketUrl: f.ticketUrl,
    coverImageUrl: f.coverImageUrl,
    description: f.description,
  };
}

export class InMemoryCanonicalStore implements CanonicalStore {
  cities: CityRecord[];
  venues: CanonicalVenue[];
  events: CanonicalEvent[];
  links: SourceLink[];
  readonly applied: SyncApplyResult[] = [];

  constructor(seed: InMemorySeed = {}) {
    // Snapshot the seed: the store owns its rows outright, so mutating a seed
    // object after construction must not reach into store state (and vice
    // versa, once `apply` starts mutating rows in place).
    this.cities = (seed.cities ?? []).map((c) => snapshot(c));
    this.venues = (seed.venues ?? []).map((v) => snapshot(v));
    this.events = (seed.events ?? []).map((e) => snapshot(e));
    this.links = (seed.sourceLinks ?? []).map((l) => snapshot(l));
  }

  async listCities(countryCode?: string): Promise<CityRecord[]> {
    const rows = countryCode
      ? this.cities.filter((c) => c.countryCode.toUpperCase() === countryCode.toUpperCase())
      : this.cities;
    return rows.map((c) => snapshot(c));
  }

  async listVenuesInCity(cityId: string): Promise<CanonicalVenue[]> {
    return this.venues.filter((v) => v.cityId === cityId).map((v) => snapshot(v));
  }

  async getVenueBySource(sourceKey: string, externalId: string): Promise<CanonicalVenue | null> {
    const v = this.venues.find((x) => x.sourceKey === sourceKey && x.externalId === externalId);
    return v ? snapshot(v) : null;
  }

  async getVenueById(id: string): Promise<CanonicalVenue | null> {
    const v = this.venues.find((x) => x.id === id);
    return v ? snapshot(v) : null;
  }

  async getEventById(id: string): Promise<CanonicalEvent | null> {
    const e = this.events.find((x) => x.id === id);
    return e ? snapshot(e) : null;
  }

  async getEventBySource(sourceKey: string, externalId: string): Promise<CanonicalEvent | null> {
    const link = this.links.find(
      (l) => l.kind === "event" && l.sourceKey === sourceKey && l.externalId === externalId,
    );
    const e = link ? this.events.find((x) => x.id === link.canonicalId) : undefined;
    return e ? snapshot(e) : null;
  }

  async findEventsAtVenueOnDate(venueId: string, date: string): Promise<CanonicalEvent[]> {
    return this.events
      .filter((e) => e.venueId === venueId && dateOf(e.startLocal) === dateOf(date))
      .map((e) => snapshot(e));
  }

  async getSourceLink(
    kind: EntityKind,
    sourceKey: string,
    externalId: string,
  ): Promise<SourceLink | null> {
    const link = this.links.find(
      (l) => l.kind === kind && l.sourceKey === sourceKey && l.externalId === externalId,
    );
    return link ? snapshot(this.linkFromPersistedRow(link)) : null;
  }

  async listSourceLinks(kind: EntityKind, sourceKey: string): Promise<SourceLink[]> {
    return this.links
      .filter((l) => l.kind === kind && l.sourceKey === sourceKey)
      .map((l) => snapshot(this.linkFromPersistedRow(l)));
  }

  /**
   * Parity with `SupabaseCanonicalStore.getSourceLink`: the change-detection
   * projection a store hands back MUST be reconstructed from the persisted
   * canonical row (via `venueComparable()` / `eventComparable()`), never replayed
   * from whatever the link cached at write time. Otherwise a comparable field
   * that `applyVenue()` / `applyEvent()` fails to persist would still hash-match
   * the next incoming record — the gap would hide here as UNCHANGED, while
   * production (which always rebuilds from the row) loops UPDATED forever.
   *
   * Lifecycle fields (`sourceStatus`, `consecutiveMisses`, the timestamps) stay
   * exactly as the link holds them — the current real schema has no column for
   * those, so the in-memory link is legitimately their source of truth.
   */
  private linkFromPersistedRow(link: SourceLink): SourceLink {
    if (link.kind === "venue") {
      const v = this.venues.find((x) => x.id === link.canonicalId);
      if (!v) return link;
      const projection = venueComparable(v);
      return { ...link, comparableFields: projection, contentHash: hashComparable(projection) };
    }
    const e = this.events.find((x) => x.id === link.canonicalId);
    if (!e) return link;
    const projection = eventComparable(e);
    return { ...link, comparableFields: projection, contentHash: hashComparable(projection) };
  }

  /**
   * Reference persistence — mutates the in-memory model so a test can re-read
   * and assert what "the app" would see. The Supabase version (next task) does
   * the same transitions transactionally.
   */
  async apply(plan: SyncPlan, opts: { commit: boolean }): Promise<SyncApplyResult> {
    const result: SyncApplyResult = {
      committed: opts.commit,
      inserted: 0,
      updated: 0,
      linked: 0,
      reconciled: 0,
      skipped: 0,
      deferred: [],
      notes: [],
      error: null,
    };
    if (!opts.commit) {
      result.notes.push("dry apply — nothing written");
      this.applied.push(result);
      return result;
    }
    const now = plan.run.startedAt;

    for (const up of plan.upserts) {
      if (up.operation === "skip") {
        result.skipped++;
      } else if (up.kind === "venue") {
        this.applyVenue(up, now, result);
      } else {
        this.applyEvent(up, now, result);
      }
    }

    if (plan.reconciliation.reconciled) {
      for (const a of plan.reconciliation.actions) this.applyReconcile(a, result);
    }

    this.applied.push(result);
    return result;
  }

  private applyVenue(up: CanonicalUpsert, now: string, result: SyncApplyResult): void {
    if (up.record.kind !== "venue") return;
    const f = up.record.fields;
    const p = up.record.provenance;

    // Idempotency parity with `SupabaseCanonicalStore`: a row already persisted
    // for this (source, external_id) is an update, never a second insert — so
    // re-applying the same plan does not duplicate.
    const persisted = this.venues.find(
      (v) => v.sourceKey != null && v.sourceKey === p.sourceKey && v.externalId === p.externalId,
    );
    const operation = up.operation === "insert" && persisted ? "update" : up.operation;
    const targetId = persisted?.id ?? up.canonicalId ?? null;

    if (operation === "insert") {
      // Parity with `SupabaseCanonicalStore.insertVenueRow`: a source must not
      // create cities. If the record's city text does not resolve to a known
      // `cities` row, the real store DEFERS the insert — so must this one,
      // rather than persisting a venue with a dangling `cityId`.
      const cityId = this.cityIdFor(up.record.scope.cityText);
      if (!cityId) {
        result.deferred.push(
          `venue insert deferred: city "${up.record.scope.cityText ?? ""}" ` +
            `(${up.record.scope.countryCode ?? "?"}) not in cities — a source must not create cities`,
        );
        return;
      }
      const id = nextId("venue");
      this.venues.push({
        id,
        cityId,
        cityName: up.record.scope.cityText ?? "",
        countryCode: up.record.scope.countryCode ?? "",
        name: f.name,
        normalizedName: f.normalizedName,
        address: f.address,
        coordinates: snapshot(f.coordinates),
        coordinatesSource: f.coordinatesSource,
        website: f.website,
        wikidata: f.wikidata,
        openingHours: f.openingHours,
        description: f.description ?? null,
        // Parity with `SupabaseCanonicalStore.insertVenueRow`: times land as `HH:MM`.
        openingTime: normalizeTimeOfDay(f.openingTime),
        closingTime: normalizeTimeOfDay(f.closingTime),
        isActive: f.isActive ?? true,
        sourceKey: p.sourceKey,
        externalId: p.externalId,
        sourceUrl: p.sourceUrl,
        createdAt: now,
        updatedAt: now,
      });
      this.upsertLink("venue", up, id, now);
      result.inserted++;
      return;
    }
    if (operation === "update" && targetId) {
      const v = this.venues.find((x) => x.id === targetId);
      if (!v) {
        // Parity with `SupabaseCanonicalStore.updateVenueRow` ("row not found").
        // A link to a canonical row that does not exist must NOT be written.
        result.deferred.push(`venue update deferred: row ${targetId} not found`);
        return;
      }
      // Apply only positive assertions (non-null). A source cannot null a
      // canonical value in the current model (omitted vs explicit-null is
      // indistinguishable). Mirrors `SupabaseCanonicalStore.updateVenueRow`.
      if (f.name) v.name = f.name;
      if (f.normalizedName) v.normalizedName = f.normalizedName;
      if (f.address) v.address = f.address;
      if (f.coordinates && v.coordinatesSource !== "manual") {
        v.coordinates = snapshot(f.coordinates);
        v.coordinatesSource = f.coordinatesSource;
      }
      if (f.website) v.website = f.website;
      if (f.wikidata) v.wikidata = f.wikidata;
      if (f.openingHours) v.openingHours = f.openingHours;
      if (f.description != null) v.description = f.description;
      // Parity with `SupabaseCanonicalStore.updateVenueRow`: normalize to `HH:MM`,
      // and a value that does not parse is not a positive assertion (skip it).
      const normOpening = normalizeTimeOfDay(f.openingTime);
      if (normOpening != null) v.openingTime = normOpening;
      const normClosing = normalizeTimeOfDay(f.closingTime);
      if (normClosing != null) v.closingTime = normClosing;
      if (f.isActive != null) v.isActive = f.isActive;
      v.updatedAt = now;
      result.updated++;
      this.upsertLink("venue", up, targetId, now);
      return;
    }
    if (operation === "link-only" && targetId) {
      if (!this.venues.some((x) => x.id === targetId)) {
        result.deferred.push(`venue link deferred: row ${targetId} not found`);
        return;
      }
      this.upsertLink("venue", up, targetId, now);
      result.linked++;
    }
  }

  private applyEvent(up: CanonicalUpsert, now: string, result: SyncApplyResult): void {
    if (up.record.kind !== "event") return;
    const f = up.record.fields;
    const p = up.record.provenance;
    const venueId = up.resolvedVenueId ?? null;

    // Idempotency parity with `SupabaseCanonicalStore`: an event already
    // persisted for this (source, external_id) is an update, never a 2nd insert.
    const persistedLink = this.links.find(
      (l) => l.kind === "event" && l.sourceKey === p.sourceKey && l.externalId === p.externalId,
    );
    const persisted = persistedLink
      ? (this.events.find((e) => e.id === persistedLink.canonicalId) ?? null)
      : null;
    const operation = up.operation === "insert" && persisted ? "update" : up.operation;
    const targetId = persisted?.id ?? up.canonicalId ?? null;

    if (operation === "insert") {
      if (!venueId) {
        result.skipped++;
        result.notes.push(`event ${p.externalId}: no resolved venue — not inserted`);
        return;
      }
      if (!this.venues.some((v) => v.id === venueId)) {
        // `events.venue_id` is a NOT NULL FK — Postgres would reject this insert
        // and `SupabaseCanonicalStore.apply` would halt. Do not persist an event
        // that points at a venue this store does not have.
        result.deferred.push(`event insert deferred: resolved venue ${venueId} not found`);
        return;
      }
      const id = nextId("event");
      this.events.push({
        id,
        venueId,
        title: f.title,
        description: f.description,
        startLocal: f.startLocal,
        timeZone: f.timeZone,
        endLocal: f.endLocal,
        status: f.status,
        ticketUrl: f.ticketUrl,
        coverImageUrl: f.coverImageUrl,
        canonicalSourceKey: p.sourceKey,
        sourceUrl: p.sourceUrl,
        createdAt: now,
        updatedAt: now,
      });
      this.upsertLink("event", up, id, now);
      result.inserted++;
      return;
    }
    if (operation === "update" && targetId) {
      const e = this.events.find((x) => x.id === targetId);
      if (!e) {
        // Parity with `SupabaseCanonicalStore.applyEvent` ("row not found").
        result.deferred.push(`event update deferred: row ${targetId} not found`);
        return;
      }
      // Positive assertions only (see `applyVenue`). Every field in
      // `eventComparable()` that the current schema persists must land here,
      // or a detected UPDATE would not survive a read — and re-planning from
      // a reconstructed row would loop UPDATED forever.
      e.title = f.title;
      e.description = f.description ?? e.description;
      e.startLocal = f.startLocal;
      // `startInstant`/`endInstant` in the comparable projection derive from
      // `timeZone` too — a corrected zone must not be left behind.
      if (f.timeZone) e.timeZone = f.timeZone;
      e.endLocal = f.endLocal ?? e.endLocal;
      // Parity with `SupabaseCanonicalStore.applyEvent`: an explicit cancel
      // persists, but a later non-cancel snapshot must NEVER un-cancel.
      if (f.status === "cancelled") e.status = "cancelled";
      e.ticketUrl = f.ticketUrl ?? e.ticketUrl;
      e.coverImageUrl = f.coverImageUrl ?? e.coverImageUrl;
      // The engine re-resolved the canonical venue this run; `events.venue_id`
      // is NOT NULL but mutable. Never null it (event-first may be unresolved),
      // and never point it at a venue this store does not have.
      if (venueId && this.venues.some((v) => v.id === venueId)) e.venueId = venueId;
      e.updatedAt = now;
      result.updated++;
      this.upsertLink("event", up, targetId, now);
      return;
    }
    if (operation === "link-only" && targetId) {
      if (!this.events.some((x) => x.id === targetId)) {
        result.deferred.push(`event link deferred: row ${targetId} not found`);
        return;
      }
      this.upsertLink("event", up, targetId, now);
      result.linked++;
    }
  }

  private applyReconcile(a: ReconcileAction, result: SyncApplyResult): void {
    const target = this.links.find(
      (l) => `${l.sourceKey}:${l.externalId}` === a.key && l.kind === a.kind,
    );
    if (!target || a.transition === "no-op") return;
    if (a.transition === "keep-active") {
      target.sourceStatus = "active";
      target.consecutiveMisses = 0;
    } else {
      target.sourceStatus =
        a.transition === "mark-stale"
          ? "stale"
          : a.transition === "mark-missing"
            ? "missing"
            : "gone";
      target.consecutiveMisses = a.misses;
    }
    result.reconciled++;
  }

  private upsertLink(
    kind: EntityKind,
    up: CanonicalUpsert,
    canonicalId: string,
    now: string,
  ): void {
    const p = up.record.provenance;
    const fields = comparable(up.record);
    const contentHash = hashComparable(fields);
    const existing = this.links.find(
      (l) => l.kind === kind && l.sourceKey === p.sourceKey && l.externalId === p.externalId,
    );
    if (existing) {
      Object.assign(existing, {
        canonicalId,
        contentHash,
        comparableFields: fields,
        reported: snapshot(p.reported),
        lastSeenAt: now,
        lastSyncedAt: now,
        sourceStatus: "active" as SourceStatus,
        consecutiveMisses: 0,
      });
      return;
    }
    this.links.push({
      id: nextId("link"),
      kind,
      sourceKey: p.sourceKey,
      externalId: p.externalId,
      sourceUrl: p.sourceUrl,
      canonicalId,
      contentHash,
      comparableFields: fields,
      reported: snapshot(p.reported),
      firstSeenAt: now,
      lastSeenAt: now,
      lastSyncedAt: now,
      sourceStatus: "active",
      consecutiveMisses: 0,
    });
  }

  private cityIdFor(cityText: string | null): string {
    return this.cities.find((c) => c.name === (cityText ?? ""))?.id ?? "";
  }
}
