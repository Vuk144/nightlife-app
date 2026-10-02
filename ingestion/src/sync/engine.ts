/**
 * The generic synchronization engine.
 *
 * `planSync` runs ONE source through the whole pipeline and returns a `SyncPlan`
 * — a pure data structure describing every canonical insert / update / link,
 * every reconciliation transition, and every review item. It performs store
 * READS only; applying the plan (`store.apply`) is the NEXT task.
 *
 * The engine contains no source-specific parsing, no OSM logic, no GIGS
 * selectors, and no city / country / venue-name branches. Everything geographic
 * is resolved through `ConfigProvider`.
 */

import type { ConfigProvider, SourceConfig } from "./config.ts";
import { hashComparable } from "./canonical-hash.ts";
import { detectChange } from "./change-detection.ts";
import { resolveEventIdentity } from "./event-identity.ts";
import { profileFor } from "./normalization.ts";
import { planReconciliation } from "./reconcile.ts";
import { comparable, type CanonicalStore, type SourceLink } from "./store.ts";
import { toInstantMs } from "./time-zone.ts";
import {
  resolveCrossSourceIdentity,
  type CrossSourceIdentityResult,
  type CrossSourceVenueIdentity,
} from "./venue-cross-source-identity.ts";
import { resolveVenueIdentity, type VenueMatchCandidate } from "./venue-identity.ts";
import { validateRecord } from "./validation.ts";
import type {
  AdapterContext,
  CanonicalUpsert,
  ChangeStatus,
  IdentityOutcome,
  NormalizedRecord,
  ResolvedScope,
  ReviewItem,
  RunCompleteness,
  SourceAdapter,
  SourceStateSnapshot,
  StoredRecordState,
  SyncPlan,
  SyncRunStats,
  ValidationResult,
  VenueFields,
} from "./types.ts";

const ZERO_CHANGE_COUNTS: Record<ChangeStatus, number> = {
  NEW: 0,
  UPDATED: 0,
  UNCHANGED: 0,
  STALE: 0,
  MISSING: 0,
  GONE: 0,
  REJECTED: 0,
  NEEDS_REVIEW: 0,
};

export interface PlanSyncInput {
  adapter: SourceAdapter;
  source: SourceConfig;
  config: ConfigProvider;
  store: CanonicalStore;
  now: string;
  runId: string;
  limit?: number;
  /**
   * `"complete"` (default): the run sees the source's whole current record
   * set, so a stored record it did not see progresses through reconciliation.
   * `"partial"`: the run covers only part of the source (e.g. one event), so
   * only records it SAW take part in reconciliation — nothing else is touched.
   * A `limit` that cuts discovery short always makes the run partial.
   */
  completeness?: RunCompleteness;
  /**
   * Curated cross-source venue identities, checked for an event's venue hint
   * before the name tiers — same rule as `./event-venue-match.ts` (see
   * `./venue-cross-source-identity.ts`). Pass `CROSS_SOURCE_VENUE_IDENTITIES`;
   * omitted = none.
   */
  crossSourceIdentities?: CrossSourceVenueIdentity[];
}

export async function planSync(input: PlanSyncInput): Promise<SyncPlan> {
  const { adapter, source, config, store, now, runId } = input;
  const cfg = config.load();
  // Wall-clock start — the ONLY non-deterministic value in the plan, and used
  // solely for `stats.durationMs`. `now` (the injected logical timestamp) is
  // kept for `run.startedAt` and every downstream comparison.
  const startedAtMs = Date.now();

  const stats: SyncRunStats = {
    discovered: 0,
    fetched: 0,
    fetchFailed: 0,
    parsed: 0,
    parseFailed: 0,
    byChangeStatus: { ...ZERO_CHANGE_COUNTS },
    venuesMatched: 0,
    venuesNew: 0,
    eventsMatched: 0,
    eventsNew: 0,
    reviewItems: 0,
    reconciled: false,
    reconciliationActions: 0,
    durationMs: 0,
    status: "ok",
    healthy: true,
    notes: [],
  };

  const upserts: CanonicalUpsert[] = [];
  const reviewItems: ReviewItem[] = [];
  const seenKeys = new Set<string>();
  const linkedVenueCache = new Map<string, NormalizedRecord | null>();
  const eventFirstCandidateKeys = new Set<string>();
  const claimedVenueIds = new Set<string>();

  const primaryCountry =
    config.country(source.scope.countries[0] ?? null) ??
    config.country(cfg.countries[0]?.code ?? null);

  const adapterCtx: AdapterContext = {
    defaultCountryCode: primaryCountry?.code ?? "",
    defaultTimeZone: primaryCountry?.defaultTimeZone ?? "UTC",
    scopeConfig: source.settings,
    userAgent: "nightlife-sync/0.1",
    cities: config.citiesInScope(source).map((c) => c.canonicalName),
    limit: input.limit ?? 0,
    verbose: false,
  };

  // ── discover ──────────────────────────────────────────────────────
  const refs = [];
  let completeness: RunCompleteness = input.completeness ?? "complete";
  try {
    for await (const ref of adapter.discover(adapterCtx)) {
      refs.push(ref);
      if (adapterCtx.limit > 0 && refs.length >= adapterCtx.limit) {
        // the source may hold more than we took — never reconcile as if complete
        completeness = "partial";
        break;
      }
    }
  } catch (error) {
    stats.status = "failed";
    stats.healthy = false;
    stats.notes.push(`discovery failed: ${(error as Error).message}`);
    return finish(stats, upserts, reviewItems, {
      reconciled: false,
      runStatus: "failed",
      actions: [],
      skippedReason: "discovery failed",
    }, input, startedAtMs, completeness);
  }
  stats.discovered = refs.length;

  // ── per item ──────────────────────────────────────────────────────
  for (const ref of refs) {
    let raw;
    try {
      raw = await adapter.fetch(ref, adapterCtx);
    } catch (error) {
      stats.fetchFailed++;
      stats.notes.push(`fetch failed (${ref.url ?? ref.externalId}): ${(error as Error).message}`);
      continue;
    }
    if (raw.status >= 400 || raw.status < 200) {
      stats.fetchFailed++;
      continue;
    }
    stats.fetched++;

    let parsed;
    try {
      parsed = adapter.parse(raw, adapterCtx);
    } catch (error) {
      stats.parseFailed++;
      stats.notes.push(`parse threw: ${(error as Error).message}`);
      continue;
    }
    if (!parsed.ok) {
      stats.parseFailed++;
      stats.notes.push(
        `parse failed (${ref.externalId ?? ref.url}): ${parsed.reason}${parsed.detail ? ` — ${parsed.detail}` : ""}`,
      );
      continue;
    }
    stats.parsed++;

    const reservedVenueIds = await reserveOwnedVenues(store, parsed.records);
    for (const record of parsed.records) {
      await processRecord(record, {
        adapter,
        adapterCtx,
        config,
        store,
        now,
        stats,
        upserts,
        reviewItems,
        seenKeys,
        linkedVenueCache,
        eventFirstCandidateKeys,
        claimedVenueIds,
        reservedVenueIds,
        crossSourceIdentities: input.crossSourceIdentities ?? [],
      });
    }
  }

  // ── health ────────────────────────────────────────────────────────
  if (stats.discovered === 0) {
    stats.status = "failed";
    stats.healthy = false;
    stats.notes.push("discovery returned no items");
  }
  const fetchFailRatio = stats.discovered > 0 ? stats.fetchFailed / stats.discovered : 0;
  const parseAttempts = stats.parsed + stats.parseFailed;
  const parseFailRatio = parseAttempts > 0 ? stats.parseFailed / parseAttempts : 0;
  if (fetchFailRatio >= 0.5 || parseFailRatio >= cfg.reconciliation.maxParseFailureRatio) {
    stats.status = stats.status === "failed" ? "failed" : "degraded";
    stats.healthy = false;
    stats.notes.push(
      `unhealthy run: fetchFail=${fetchFailRatio.toFixed(2)} parseFail=${parseFailRatio.toFixed(2)}`,
    );
  }

  // ── reconciliation ───────────────────────────────────────────────
  const sourceSnapshots = await buildSnapshots(store, source, now);
  // A venue in a city outside this run's scope was never asked for, so it is
  // not "missing" either: only in-scope venues take part in reconciliation.
  const scopedIds = source.kinds.includes("venue") ? await venueIdsInScope(store, input.config, source) : null;
  const allSnapshots = scopedIds
    ? sourceSnapshots.filter((s) => s.kind !== "venue" || seenKeys.has(s.key) || scopedIds.has(s.canonicalId))
    : sourceSnapshots;
  if (allSnapshots.length < sourceSnapshots.length) {
    stats.notes.push(
      `${sourceSnapshots.length - allSnapshots.length} stored venue(s) outside this run's cities were not reconciled`,
    );
  }
  // A partial run speaks only for the records it saw: a stored record outside
  // the run is not "missing", so it takes no part in reconciliation at all.
  const snapshots =
    completeness === "partial" ? allSnapshots.filter((s) => seenKeys.has(s.key)) : allSnapshots;
  if (snapshots.length < allSnapshots.length) {
    stats.notes.push(
      `partial run: ${allSnapshots.length - snapshots.length} stored record(s) not seen in this run were not reconciled`,
    );
  }
  // The snapshot guards judge a COMPLETE snapshot (a missing partition, a
  // collapse); a partial run is small by design and reconciles nothing unseen.
  if (adapter.capabilities.snapshotRefs && completeness === "complete") {
    guardSnapshotRun(stats, snapshots, seenKeys, cfg.reconciliation.minDiscoveryRatio);
  }
  const reconciliation = planReconciliation({
    runStatus: stats.status,
    healthy: stats.healthy,
    seenKeys,
    stored: snapshots,
    thresholds: cfg.reconciliation,
  });
  stats.reconciled = reconciliation.reconciled;
  stats.reconciliationActions = reconciliation.actions.filter(
    (a) => a.transition !== "no-op" && a.transition !== "keep-active",
  ).length;
  for (const a of reconciliation.actions) {
    if (a.transition === "mark-stale") stats.byChangeStatus.STALE++;
    if (a.transition === "mark-missing") stats.byChangeStatus.MISSING++;
    if (a.transition === "mark-gone") stats.byChangeStatus.GONE++;
  }

  return finish(stats, upserts, reviewItems, reconciliation, input, startedAtMs, completeness);
}

/**
 * Extra health rules for a source whose refs are complete snapshots
 * (`SourceCapabilities.snapshotRefs`). The generic ratio rules above allow a
 * few failed pages; for a snapshot source one failed or empty ref is a whole
 * partition (e.g. a city) that would read as "all its records disappeared",
 * and a result far smaller than what was synced before is a collapse, not a
 * mass closure. Either makes the run unhealthy, so reconciliation is skipped.
 */
function guardSnapshotRun(
  stats: SyncRunStats,
  snapshots: SourceStateSnapshot[],
  seenKeys: Set<string>,
  minDiscoveryRatio: number,
): void {
  const unhealthy = (note: string) => {
    stats.status = stats.status === "failed" ? "failed" : "degraded";
    stats.healthy = false;
    stats.notes.push(note);
  };
  const failedRefs = stats.fetchFailed + stats.parseFailed;
  if (failedRefs > 0) {
    unhealthy(
      `snapshot source: ${failedRefs} of ${stats.discovered} refs failed or were empty — ` +
        `a whole partition is missing, reconciliation skipped`,
    );
  }
  // Baseline: stored records reconciliation could still act on.
  const baseline = snapshots.filter((s) => !s.frozen && !s.cancelled && s.sourceStatus !== "gone");
  const seen = baseline.filter((s) => seenKeys.has(s.key)).length;
  if (baseline.length > 0 && seen / baseline.length < minDiscoveryRatio) {
    unhealthy(
      `collapsed result: only ${seen} of ${baseline.length} previously synced records seen ` +
        `(< minDiscoveryRatio ${minDiscoveryRatio}) — reconciliation skipped`,
    );
  }
}

/**
 * The OPTIONAL members of `VenueFields` — the venue fields where the model
 * separates "source does not provide this" (`undefined`) from an explicit value.
 * Each name is also its `comparable()` key.
 */
const OPTIONAL_VENUE_FIELDS = [
  "address",
  "website",
  "wikidata",
  "openingHours",
  "description",
  "openingTime",
  "closingTime",
  "isActive",
] as const satisfies readonly (keyof VenueFields)[];

// ── one record through the pipeline ────────────────────────────────
interface ProcessCtx {
  adapter: SourceAdapter;
  adapterCtx: AdapterContext;
  config: ConfigProvider;
  store: CanonicalStore;
  now: string;
  stats: SyncRunStats;
  upserts: CanonicalUpsert[];
  reviewItems: ReviewItem[];
  seenKeys: Set<string>;
  linkedVenueCache: Map<string, NormalizedRecord | null>;
  /** `PlanSyncInput.crossSourceIdentities` ([] when omitted). */
  crossSourceIdentities: CrossSourceVenueIdentity[];
  /**
   * `sourceKey:externalId` of every event-first venue candidate already
   * decided this run. Several events at the same unknown venue name ONE
   * candidate — without this, each emitted its own insert (over-counting
   * `venuesNew`) or its own identical review item.
   */
  eventFirstCandidateKeys: Set<string>;
  /**
   * Existing venue ids already linked by a venue record earlier in this run.
   * One canonical venue is one real place: a later record matching it must
   * not link it too (the matcher's `consumed` set, shared for the whole run).
   */
  claimedVenueIds: Set<string>;
  /**
   * For the current parsed batch: existing venue id → the external id that
   * already owns it by exact source identity. The owner always gets its own
   * row, even when a weaker (e.g. same-name) match from another record in the
   * batch is processed first.
   */
  reservedVenueIds: Map<string, string>;
}

/** Existing venues owned (by exact source identity) by a venue record in `records`. */
async function reserveOwnedVenues(
  store: CanonicalStore,
  records: NormalizedRecord[],
): Promise<Map<string, string>> {
  const reserved = new Map<string, string>();
  for (const r of records) {
    if (r.kind !== "venue") continue;
    const owned = await store.getVenueBySource(r.provenance.sourceKey, r.provenance.externalId);
    if (owned) reserved.set(owned.id, r.provenance.externalId);
  }
  return reserved;
}

async function processRecord(input: NormalizedRecord, ctx: ProcessCtx): Promise<void> {
  const { config, store } = ctx;
  const key = `${input.provenance.sourceKey}:${input.provenance.externalId}`;
  ctx.seenKeys.add(key);

  const countryCfg = config.country(input.scope.countryCode);
  const profile = profileFor(countryCfg);

  // Fill the engine-derived `normalizedName` (a venue field) before anything
  // downstream reads it — it is NOT source data, so validation must see it set.
  const record: NormalizedRecord =
    input.kind === "venue" && !input.fields.normalizedName
      ? { ...input, fields: { ...input.fields, normalizedName: profile.normalizeName(input.fields.name) } }
      : input;
  const cityRes = config.resolveCity(record.scope.countryCode, record.scope.cityText);
  const cities = await store.listCities(record.scope.countryCode ?? undefined);
  const cityRow = cityRes
    ? cities.find((c) => c.name === cityRes.city.canonicalName)
    : undefined;

  const scope: ResolvedScope = {
    countryCode: record.scope.countryCode,
    cityName: cityRes?.city.canonicalName ?? null,
    cityId: cityRow?.id ?? null,
    timeZone: cityRes?.city.timeZone ?? countryCfg?.defaultTimeZone ?? null,
    cityEnabled: cityRes?.city.enabled ?? false,
    eventFirstEnabled: cityRes?.city.eventFirstEnabled ?? false,
    bounds: cityRes?.city.bounds ?? countryCfg?.bounds ?? null,
    resolvedVia: cityRes ? (cityRes.via === "alias" ? "city-alias" : "country+city") : "unresolved",
  };

  const validation = validateRecord({ record, scope, country: countryCfg });

  if (record.kind === "venue") {
    await processVenue(record, scope, validation, profile.normalizeName, ctx);
  } else {
    await processEvent(record, scope, validation, profile.normalizeName, ctx);
  }
}

async function processVenue(
  record2: Extract<NormalizedRecord, { kind: "venue" }>,
  scope: ResolvedScope,
  validation: ValidationResult,
  normalize: (s: string) => string,
  ctx: ProcessCtx,
): Promise<void> {
  const { store, now, stats } = ctx;
  const normalizedName = record2.fields.normalizedName;

  let identity: IdentityOutcome = {
    entity: "venue",
    decision: "new_candidate",
    tier: 4,
    canonicalId: null,
    reasonCode: "venue-new-candidate",
    note: "scope unresolved",
  };
  if (scope.cityId && scope.cityName && scope.countryCode) {
    const existing = (await store.listVenuesInCity(scope.cityId)).map((v) =>
      toVenueMatchCandidate(v, normalize),
    );
    const blocked = new Set(ctx.claimedVenueIds);
    for (const [id, owner] of ctx.reservedVenueIds) {
      if (owner !== record2.provenance.externalId) blocked.add(id);
    }
    identity = resolveVenueIdentity({
      incoming: {
        source: record2.provenance,
        name: record2.fields.name,
        normalizedName,
        coordinates: record2.fields.coordinates,
        // omitted and null are the same thing to the matcher
        address: record2.fields.address ?? null,
        website: record2.fields.website ?? null,
        wikidata: record2.fields.wikidata ?? null,
      },
      scope: { countryCode: scope.countryCode, cityName: scope.cityName },
      existingInCity: existing,
      consumed: blocked,
    });
  }

  const storedLink = await store.getSourceLink(
    "venue",
    record2.provenance.sourceKey,
    record2.provenance.externalId,
  );
  const venueComparable = comparable(record2);
  // Manual coordinates are never overwritten by a source (both stores enforce
  // it on write), so the source's coordinates can never be persisted there.
  // Compare what WOULD be persisted: the stored pin. Otherwise the difference
  // alone reads as UPDATED on every run. Every other field still compares.
  if (storedLink) {
    const current = await store.getVenueById(storedLink.canonicalId);
    if (current?.coordinatesSource === "manual") {
      venueComparable.lat = current.coordinates?.latitude ?? null;
      venueComparable.lon = current.coordinates?.longitude ?? null;
    }
    // Same rule for an OPTIONAL field the source does not provide at all
    // (`undefined`, e.g. OSM has no description / opening times): nothing is
    // written, so the stored value stands. An explicit `null` is a value the
    // source asserted and still compares.
    for (const key of OPTIONAL_VENUE_FIELDS) {
      if (record2.fields[key] === undefined) {
        venueComparable[key] = storedLink.comparableFields[key] ?? null;
      }
    }
  }
  const change = detectChange({
    // The hash is over the canonical comparable fields — not the adapter's raw
    // hash — so any store can reconstruct the same value from a persisted row.
    incoming: { contentHash: hashComparable(venueComparable), comparableFields: venueComparable },
    stored: storedLink ? toStoredState(storedLink) : null,
    validation,
    now,
  });
  stats.byChangeStatus[change.status]++;

  if (change.status === "REJECTED" || change.status === "NEEDS_REVIEW" || identity.decision === "ambiguous") {
    ctx.reviewItems.push({
      kind: "venue",
      reasonCode: change.status === "REJECTED" ? change.note : identity.reasonCode,
      reasons: [change.note, identity.note].filter(Boolean),
      record: record2,
      suggestedCanonicalId: identity.canonicalId,
    });
    stats.reviewItems++;
    return;
  }

  const { operation, canonicalId } = decideOperation(
    change.status,
    identity,
    storedLink?.canonicalId ?? null,
  );
  if (identity.decision === "matched") stats.venuesMatched++;
  else if (operation === "insert") stats.venuesNew++;
  // Only a record that actually gets an upsert claims its venue — a rejected
  // or held record above never blocks a later valid one.
  if (operation !== "insert" && canonicalId) ctx.claimedVenueIds.add(canonicalId);

  ctx.upserts.push({
    kind: "venue",
    operation,
    changeStatus: change.status,
    canonicalId,
    fieldDeltas: change.fieldDeltas,
    record: record2,
    identity,
  });
}

async function processEvent(
  input: Extract<NormalizedRecord, { kind: "event" }>,
  scope: ResolvedScope,
  validation: ValidationResult,
  normalize: (s: string) => string,
  ctx: ProcessCtx,
): Promise<void> {
  const { adapter, adapterCtx, config, store, now, stats } = ctx;
  // The store needs a time zone to compute `events.start_at` (an instant) from
  // the local wall-clock. Default it from config (city → country) when the
  // adapter did not set one.
  const record: Extract<NormalizedRecord, { kind: "event" }> =
    input.fields.timeZone || !scope.timeZone
      ? input
      : { ...input, fields: { ...input.fields, timeZone: scope.timeZone } };
  const p = record.provenance;

  // 1. resolve the venue link
  let resolvedVenueId: string | null = null;
  let venueIdentity: IdentityOutcome | null = null;
  const hint = record.links.venue;

  // The source's own venue id first: a curated cross-source identity (or a
  // conflict around that id) is authoritative over any name — the same rule
  // as `./event-venue-match.ts#matchEventVenue`.
  const crossSource = await eventVenueSourceIdentity(record, scope, ctx);
  if (crossSource.status === "matched") {
    resolvedVenueId = crossSource.venueId;
    venueIdentity = {
      entity: "venue",
      decision: "matched",
      tier: 0,
      canonicalId: crossSource.venueId,
      reasonCode: "venue-source-identity",
      note: crossSource.note,
    };
    stats.venuesMatched++;
  } else if (crossSource.status === "review") {
    ctx.reviewItems.push({
      kind: "venue",
      reasonCode: crossSource.reasonCode,
      reasons: [crossSource.note],
      record: { ...record },
      suggestedCanonicalId: crossSource.candidates[0]?.id ?? null,
    });
    stats.reviewItems++;
  }

  if (crossSource.status === "none" && hint && scope.cityId && scope.cityName && scope.countryCode) {
    let venueName = hint.name;
    let coordinates = hint.coordinates;
    let address = hint.address;
    let website: string | null = null;
    let wikidata: string | null = null;
    // `||`, not `??`: an empty-string id is as absent as a null one (the
    // enrichment guard below already treats it that way).
    let venueExternalId = hint.sourceVenueId || `name:${normalize(hint.name)}`;

    // best-effort enrichment from the source's own venue page
    if (hint.sourceVenueId && adapter.fetchLinked && adapter.capabilities.givesVenuePages) {
      let linked = ctx.linkedVenueCache.get(hint.sourceVenueId);
      if (linked === undefined) {
        linked = await adapter.fetchLinked("venue", hint.sourceVenueId, adapterCtx);
        ctx.linkedVenueCache.set(hint.sourceVenueId, linked ?? null);
      }
      if (linked && linked.kind === "venue") {
        venueName = linked.fields.name?.trim() ? linked.fields.name : venueName;
        coordinates = linked.fields.coordinates ?? coordinates;
        address = linked.fields.address ?? address;
        website = linked.fields.website ?? null;
        wikidata = linked.fields.wikidata ?? null;
        venueExternalId = linked.provenance.externalId || venueExternalId;
      }
    }

    const existing = (await store.listVenuesInCity(scope.cityId)).map((v) =>
      toVenueMatchCandidate(v, normalize),
    );
    venueIdentity = resolveVenueIdentity({
      incoming: {
        source: { sourceKey: p.sourceKey, externalId: venueExternalId, sourceUrl: null },
        name: venueName,
        normalizedName: normalize(venueName),
        coordinates,
        address,
        website,
        wikidata,
      },
      scope: { countryCode: scope.countryCode, cityName: scope.cityName },
      existingInCity: existing,
    });

    const candidateKey = `${p.sourceKey}:${venueExternalId}`;
    if (venueIdentity.decision === "matched") {
      resolvedVenueId = venueIdentity.canonicalId;
      stats.venuesMatched++;
    } else if (
      venueIdentity.decision === "new_candidate" &&
      validation.outcome === "ok" &&
      !ctx.eventFirstCandidateKeys.has(candidateKey)
    ) {
      ctx.eventFirstCandidateKeys.add(candidateKey);
      // emit an event-first venue candidate
      const venueRecord: Extract<NormalizedRecord, { kind: "venue" }> = {
        kind: "venue",
        provenance: {
          ...p,
          externalId: venueExternalId,
          contentHash: p.contentHash,
        },
        scope: { ...record.scope, cityText: scope.cityName },
        fields: {
          name: venueName,
          normalizedName: normalize(venueName),
          address,
          coordinates,
          coordinatesSource: coordinates ? "source" : null,
          website,
          wikidata,
          openingHours: null,
        },
        links: {},
      };
      // The event's own validation only screens the hint for placeholders; the
      // candidate (whose name may also come from the linked venue page) must
      // pass the same venue rules as a venue-first record — e.g. never an
      // empty `normalizedName` match key, never a 1-character name.
      const candidateValidation = validateRecord({
        record: venueRecord,
        scope,
        country: config.country(venueRecord.scope.countryCode),
      });
      if (candidateValidation.outcome !== "ok") {
        ctx.reviewItems.push({
          kind: "venue",
          reasonCode: candidateValidation.reasonCode ?? "event-first-venue-invalid",
          reasons: candidateValidation.reasons,
          record: venueRecord,
          suggestedCanonicalId: null,
        });
        stats.reviewItems++;
      } else {
        ctx.upserts.push({
          kind: "venue",
          operation: scope.eventFirstEnabled ? "insert" : "skip",
          changeStatus: "NEW",
          canonicalId: null,
          fieldDeltas: [],
          record: venueRecord,
          identity: venueIdentity,
        });
        if (scope.eventFirstEnabled) stats.venuesNew++;
        else {
          ctx.reviewItems.push({
            kind: "venue",
            reasonCode: "city-not-event-first-enabled",
            reasons: [`${scope.cityName} does not permit event-first venue creation`],
            record: venueRecord,
            suggestedCanonicalId: null,
          });
          stats.reviewItems++;
        }
      }
    } else if (venueIdentity.decision === "ambiguous") {
      ctx.reviewItems.push({
        kind: "venue",
        reasonCode: venueIdentity.reasonCode,
        reasons: [venueIdentity.note],
        record: { ...record },
        suggestedCanonicalId: venueIdentity.canonicalId,
      });
      stats.reviewItems++;
    }
  }

  // 2. event identity
  const localDate = record.fields.startLocal.slice(0, 10);
  const eventBySource = await store.getEventBySource(p.sourceKey, p.externalId);
  const eventLink = await store.getSourceLink("event", p.sourceKey, p.externalId);
  const candidates = resolvedVenueId
    ? (await store.findEventsAtVenueOnDate(resolvedVenueId, localDate)).map((e) => ({
        id: e.id,
        venueId: e.venueId,
        title: e.title,
        startLocal: e.startLocal,
        ticketUrl: e.ticketUrl,
        promoter: null,
      }))
    : [];

  const eventIdentity = resolveEventIdentity({
    incoming: {
      source: p,
      title: record.fields.title,
      startLocal: record.fields.startLocal,
      ticketUrl: record.fields.ticketUrl,
      promoter: record.fields.promoter,
      lineup: record.fields.lineup,
      venueName: hint?.name ?? "",
    },
    resolvedVenueId,
    existingBySource: eventBySource ? { canonicalId: eventBySource.id } : null,
    existingLink: eventLink ? { canonicalId: eventLink.canonicalId } : null,
    candidates,
  });

  // 3. change detection
  const eventComparable = comparable(record);
  const change = detectChange({
    incoming: { contentHash: hashComparable(eventComparable), comparableFields: eventComparable },
    stored: eventLink ? toStoredState(eventLink) : null,
    validation,
    now,
  });
  stats.byChangeStatus[change.status]++;

  if (change.status === "REJECTED" || change.status === "NEEDS_REVIEW" || eventIdentity.decision === "ambiguous") {
    ctx.reviewItems.push({
      kind: "event",
      reasonCode: change.status === "REJECTED" ? change.note : eventIdentity.reasonCode,
      reasons: [change.note, eventIdentity.note].filter(Boolean),
      record: { ...record },
      suggestedCanonicalId: eventIdentity.canonicalId,
    });
    stats.reviewItems++;
    return;
  }

  const { operation, canonicalId } = decideOperation(
    change.status,
    eventIdentity,
    eventLink?.canonicalId ?? null,
  );
  if (eventIdentity.decision === "matched") stats.eventsMatched++;
  else if (operation === "insert") stats.eventsNew++;

  ctx.upserts.push({
    kind: "event",
    operation,
    changeStatus: change.status,
    canonicalId,
    fieldDeltas: change.fieldDeltas,
    record: { ...record },
    identity: eventIdentity,
    resolvedVenueId,
  });
}

// ── helpers ───────────────────────────────────────────────────────
/** `resolveCrossSourceIdentity` for an event's venue hint; `none` when there are no curated identities. */
async function eventVenueSourceIdentity(
  record: Extract<NormalizedRecord, { kind: "event" }>,
  scope: ResolvedScope,
  ctx: ProcessCtx,
): Promise<CrossSourceIdentityResult> {
  const hint = record.links.venue;
  if (!hint?.sourceVenueId || ctx.crossSourceIdentities.length === 0) return { status: "none" };
  if (!scope.cityId || !scope.cityName || !scope.countryCode) return { status: "none" };
  return resolveCrossSourceIdentity({
    sourceKey: record.provenance.sourceKey,
    externalId: hint.sourceVenueId,
    city: { countryCode: scope.countryCode, cityName: scope.cityName },
    identities: ctx.crossSourceIdentities,
    venues: await ctx.store.listVenuesInCity(scope.cityId),
  });
}

function decideOperation(
  status: ChangeStatus,
  identity: IdentityOutcome,
  storedCanonicalId: string | null,
): { operation: CanonicalUpsert["operation"]; canonicalId: string | null } {
  const canonicalId = storedCanonicalId ?? identity.canonicalId;
  if (status === "NEW") {
    return identity.decision === "matched"
      ? { operation: "link-only", canonicalId }
      : { operation: "insert", canonicalId: null };
  }
  if (status === "UNCHANGED") return { operation: "link-only", canonicalId };
  if (status === "UPDATED") return { operation: "update", canonicalId };
  return { operation: "skip", canonicalId };
}

function toVenueMatchCandidate(
  v: import("./store.ts").CanonicalVenue,
  normalize: (s: string) => string,
): VenueMatchCandidate {
  return {
    id: v.id,
    name: v.name,
    // A row whose stored name_normalized is NULL (read as "", e.g. a hand-seeded
    // venue) would never match by name. Derive it in memory with the country's
    // profile — nothing is written here; an explicit UPDATE writes it.
    normalizedName: v.normalizedName || normalize(v.name),
    sourceKey: v.sourceKey,
    externalId: v.externalId,
    sourceUrl: v.sourceUrl,
    coordinates: v.coordinates,
    coordinatesSource: v.coordinatesSource,
    address: v.address,
    website: v.website,
    wikidata: v.wikidata,
  };
}

function toStoredState(link: SourceLink): StoredRecordState {
  return {
    canonicalId: link.canonicalId,
    contentHash: link.contentHash,
    comparableFields: link.comparableFields,
    firstSeenAt: link.firstSeenAt,
    lastSeenAt: link.lastSeenAt,
    lastSyncedAt: link.lastSyncedAt,
    sourceStatus: link.sourceStatus,
    consecutiveMisses: link.consecutiveMisses,
  };
}

/** Ids of every stored venue in the cities this run covers (`citiesInScope`). */
async function venueIdsInScope(
  store: CanonicalStore,
  config: PlanSyncInput["config"],
  source: SourceConfig,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const city of config.citiesInScope(source)) {
    const row = (await store.listCities(city.countryCode)).find((c) => c.name === city.canonicalName);
    if (!row) continue;
    for (const v of await store.listVenuesInCity(row.id)) ids.add(v.id);
  }
  return ids;
}

async function buildSnapshots(
  store: CanonicalStore,
  source: SourceConfig,
  now: string,
): Promise<SourceStateSnapshot[]> {
  const snapshots: SourceStateSnapshot[] = [];
  // `now` is compared as an absolute instant — timezone-independent.
  const nowMs = toInstantMs(now, null);
  for (const kind of source.kinds) {
    const links = await store.listSourceLinks(kind, source.key);
    for (const link of links) {
      let frozen = false;
      let cancelled = false;
      if (kind === "event") {
        const ev = await store.getEventById(link.canonicalId);
        if (ev) {
          // Past/frozen is decided on the event's ABSOLUTE start instant, not
          // its local wall-clock. `CanonicalEvent.startLocal` may be a local
          // time (needs `timeZone`) or an already-absolute offset-bearing
          // string; `toInstantMs` resolves either without touching the host
          // process timezone.
          const startMs = toInstantMs(ev.startLocal, ev.timeZone);
          frozen = startMs != null && nowMs != null && startMs < nowMs;
          cancelled = ev.status === "cancelled";
        }
      }
      snapshots.push({
        key: `${link.sourceKey}:${link.externalId}`,
        sourceKey: link.sourceKey,
        externalId: link.externalId,
        canonicalId: link.canonicalId,
        kind,
        sourceStatus: link.sourceStatus,
        consecutiveMisses: link.consecutiveMisses,
        frozen,
        cancelled,
      });
    }
  }
  return snapshots;
}

function finish(
  stats: SyncRunStats,
  upserts: CanonicalUpsert[],
  reviewItems: ReviewItem[],
  reconciliation: SyncPlan["reconciliation"],
  input: PlanSyncInput,
  startedAtMs: number,
  completeness: RunCompleteness,
): SyncPlan {
  stats.durationMs = Math.max(0, Date.now() - startedAtMs);
  return {
    run: {
      runId: input.runId,
      sourceKey: input.source.key,
      startedAt: input.now,
      mode: "plan",
      scope: {
        countries: input.source.scope.countries,
        cities: input.source.scope.cities,
      },
      completeness,
    },
    upserts,
    reconciliation,
    reviewItems,
    stats,
  };
}
