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
  SourceAdapter,
  SourceStateSnapshot,
  StoredRecordState,
  SyncPlan,
  SyncRunStats,
  ValidationResult,
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
  try {
    for await (const ref of adapter.discover(adapterCtx)) {
      refs.push(ref);
      if (adapterCtx.limit > 0 && refs.length >= adapterCtx.limit) break;
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
    }, input, startedAtMs);
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
      continue;
    }
    stats.parsed++;

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
  const snapshots = await buildSnapshots(store, source, now);
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

  return finish(stats, upserts, reviewItems, reconciliation, input, startedAtMs);
}

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
  _normalize: (s: string) => string,
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
    const existing = (await store.listVenuesInCity(scope.cityId)).map(toVenueMatchCandidate);
    identity = resolveVenueIdentity({
      incoming: {
        source: record2.provenance,
        name: record2.fields.name,
        normalizedName,
        coordinates: record2.fields.coordinates,
        address: record2.fields.address,
        website: record2.fields.website,
        wikidata: record2.fields.wikidata,
      },
      scope: { countryCode: scope.countryCode, cityName: scope.cityName },
      existingInCity: existing,
    });
  }

  const storedLink = await store.getSourceLink(
    "venue",
    record2.provenance.sourceKey,
    record2.provenance.externalId,
  );
  const venueComparable = comparable(record2);
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

  if (hint && scope.cityId && scope.cityName && scope.countryCode) {
    let venueName = hint.name;
    let coordinates = hint.coordinates;
    let address = hint.address;
    let website: string | null = null;
    let wikidata: string | null = null;
    let venueExternalId = hint.sourceVenueId ?? `name:${normalize(hint.name)}`;

    // best-effort enrichment from the source's own venue page
    if (hint.sourceVenueId && adapter.fetchLinked && adapter.capabilities.givesVenuePages) {
      let linked = ctx.linkedVenueCache.get(hint.sourceVenueId);
      if (linked === undefined) {
        linked = await adapter.fetchLinked("venue", hint.sourceVenueId, adapterCtx);
        ctx.linkedVenueCache.set(hint.sourceVenueId, linked ?? null);
      }
      if (linked && linked.kind === "venue") {
        venueName = linked.fields.name || venueName;
        coordinates = linked.fields.coordinates ?? coordinates;
        address = linked.fields.address ?? address;
        website = linked.fields.website;
        wikidata = linked.fields.wikidata;
        venueExternalId = linked.provenance.externalId || venueExternalId;
      }
    }

    const existing = (await store.listVenuesInCity(scope.cityId)).map(toVenueMatchCandidate);
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

    if (venueIdentity.decision === "matched") {
      resolvedVenueId = venueIdentity.canonicalId;
      stats.venuesMatched++;
    } else if (venueIdentity.decision === "new_candidate" && validation.outcome === "ok") {
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

function toVenueMatchCandidate(v: import("./store.ts").CanonicalVenue): VenueMatchCandidate {
  return {
    id: v.id,
    name: v.name,
    normalizedName: v.normalizedName,
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
    },
    upserts,
    reconciliation,
    reviewItems,
    stats,
  };
}
