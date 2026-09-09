/**
 * Generic nightlife data synchronization engine — core contract.
 *
 * This module defines the target architecture. It is the SEAM between:
 *
 *   source adapters   — everything source-specific (discovery, HTTP, HTML/JSON
 *                       parsing, source-side normalization). One per source.
 *   the sync engine   — everything generic (identity resolution, validation,
 *                       deduplication, change detection, canonicalization,
 *                       reconciliation, provenance, reporting). ONE engine.
 *   the canonical store — the persistence port (Supabase in production, an
 *                       in-memory double in tests). Writes are a LATER task.
 *
 * Nothing here contains a country name, a city name, a source name, or a venue
 * name as a branch. Geography, sources, aliases, scope, trust and scheduling
 * are all DATA — see `./config.ts`.
 *
 * Pipeline (see `./engine.ts#planSync`):
 *
 *   discover → fetch → parse → normalize      (adapter)
 *     → resolve scope → validate → resolve identity → deduplicate
 *     → detect changes → build canonical upserts        (engine, reads only)
 *     → plan reconciliation                             (engine, reads only)
 *     → SyncPlan                                        (pure data)
 *   [ next task: store.apply(plan) → Supabase → app refresh ]
 */

// ── primitives ─────────────────────────────────────────────────────────
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EntityKind = "venue" | "event";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export type RunStatus = "ok" | "degraded" | "failed";

// ── provenance ─────────────────────────────────────────────────────────
export interface SourceRef {
  /** Stable source key, e.g. "gigstix", "osm", "venue-website". */
  sourceKey: string;
  /** Stable id for this record ON that source. */
  externalId: string;
  /** Canonical URL of the record on the source, when it has one. */
  sourceUrl: string | null;
}

export interface Provenance extends SourceRef {
  /**
   * OPTIONAL, informational only — e.g. a raw source ETag or payload hash the
   * adapter happens to have. The engine does NOT use this for change detection:
   * it computes the canonical content hash itself from the shared comparable
   * representation (`./canonical-hash.ts#hashComparable` +
   * `./store.ts#comparable`). An adapter never needs to provide it, and a
   * source-specific hash would be meaningless to the engine.
   */
  contentHash?: string;
  /** Adapter's self-assessed extraction confidence, 0..1. */
  confidence: number;
  /** ISO-8601 — when the adapter fetched this. */
  fetchedAt: string;
  /** Verbatim source-reported values, kept for audit and later re-parsing. */
  reported: Record<string, JsonValue>;
}

// ── scope ──────────────────────────────────────────────────────────────
/** Raw geographic hints from the adapter. Resolved against config by the engine. */
export interface RawScope {
  /** ISO 3166-1 alpha-2 the adapter is confident about, else null. */
  countryCode: string | null;
  /** Free-text city / place string exactly as the source stated it, else null. */
  cityText: string | null;
  /** Coordinates the adapter already has, used only as a resolution hint. */
  coordinates: GeoPoint | null;
}

/** Scope after the engine resolves it against config. */
export interface ResolvedScope {
  countryCode: string | null;
  /** Canonical `cities.name`, else null when unresolved. */
  cityName: string | null;
  /** Canonical `cities.id`, else null when unresolved / store has no such row. */
  cityId: string | null;
  timeZone: string | null;
  /** The city is enabled for ingestion in config. */
  cityEnabled: boolean;
  /** The city permits event-first venue creation. */
  eventFirstEnabled: boolean;
  bounds: GeoBounds | null;
  /** Which config path resolved it, for the report. */
  resolvedVia: "country+city" | "city-alias" | "coordinates" | "unresolved";
}

// ── normalized records ────────────────────────────────────────────────
export interface VenueFields {
  name: string;
  /** Produced by the country's normalization profile (see `./normalization.ts`). */
  normalizedName: string;
  address: string | null;
  coordinates: GeoPoint | null;
  coordinatesSource: "source" | "geocoded" | "manual" | null;
  website: string | null;
  wikidata: string | null;
  /** Raw opening-hours string (e.g. OSM syntax) — maps to `venues.opening_hours`. */
  openingHours: string | null;
  // ── optional, map onto existing `venues` columns when a source supplies them ──
  /** Free-text description — `venues.description`. */
  description?: string | null;
  /** Structured local open time "HH:MM" — `venues.opening_time`. */
  openingTime?: string | null;
  /** Structured local close time "HH:MM" — `venues.closing_time`. */
  closingTime?: string | null;
  /** `venues.is_active`. Defaults to true when omitted. */
  isActive?: boolean;
}

export interface EventFields {
  title: string;
  description: string | null;
  /** Local wall-clock, no offset: "2026-10-30T23:00" or "2026-10-30". */
  startLocal: string;
  endLocal: string | null;
  doorsLocal: string | null;
  /**
   * IANA zone the local times are in. Authoritative when the source reliably
   * sets it; otherwise `null` and the engine resolves the zone from city-level
   * data (future canonical source: `cities.timezone`), falling back to
   * `AdapterContext.defaultTimeZone`.
   */
  timeZone: string | null;
  startPrecision: "datetime" | "date";
  /**
   * Source-reported lifecycle. `"scheduled"` means the source either said so or
   * said nothing — it is NEVER inferred, and a source that merely OMITS an
   * event never causes `"cancelled"`. Disappearance is handled by reconciliation
   * (`./reconcile.ts`), which likewise never cancels.
   */
  status: "scheduled" | "cancelled" | "postponed" | "rescheduled";
  promoter: string | null;
  ticketUrl: string | null;
  coverImageUrl: string | null;
  /** Performer names, in billing order. Empty when the source has none. */
  lineup: string[];
}

/** A venue the source names inside an event, before resolution to a canonical row. */
export interface VenueLinkHint {
  name: string;
  /** Stable venue id/slug on the SAME source, when available. */
  sourceVenueId: string | null;
  address: string | null;
  coordinates: GeoPoint | null;
  cityText: string | null;
}

export type NormalizedRecord =
  | {
      kind: "venue";
      provenance: Provenance;
      scope: RawScope;
      fields: VenueFields;
      links: Record<string, never>;
    }
  | {
      kind: "event";
      provenance: Provenance;
      scope: RawScope;
      fields: EventFields;
      links: { venue?: VenueLinkHint };
    };

// ── adapter contract ──────────────────────────────────────────────────
export interface SourceCapabilities {
  kinds: EntityKind[];
  discovery: "sitemap" | "index" | "api" | "feed" | "manual";
  givesExternalId: boolean;
  givesCoordinates: boolean;
  /** The source publishes its own venue pages (address / coordinates). */
  givesVenuePages: boolean;
  /** The source explicitly reports cancellations (so we may act on them). */
  emitsCancellations: boolean;
}

export interface AdapterContext {
  /** Default country the adapter operates in (from `SourceConfig` / country config). */
  defaultCountryCode: string;
  /**
   * FALLBACK IANA time zone for the source's region — a last resort only, never
   * authoritative for an event when city-level timezone data is available. The
   * engine resolves an event's zone in this order:
   *   1. `EventFields.timeZone` when the source reliably provides it;
   *   2. the resolved city's timezone (future canonical source: `cities.timezone`);
   *   3. this value.
   * An adapter should prefer to leave `EventFields.timeZone` unset (null) so the
   * engine can apply city-level data, unless the source is genuinely single-zone.
   */
  defaultTimeZone: string;
  /** Source-specific scope config, e.g. `{ osm: { relationId: 2728438 } }`. */
  scopeConfig: Record<string, JsonValue>;
  userAgent: string;
  /** Canonical city names in scope for this run — for adapters that can target. */
  cities: string[];
  /** Max items to process (0 = no cap). */
  limit: number;
  verbose: boolean;
}

export interface SourceItemRef {
  url: string | null;
  externalId: string | null;
  kindHint: EntityKind | null;
  lastModified: string | null;
}

export interface RawItem {
  ref: SourceItemRef;
  url: string;
  status: number;
  body: string;
  contentType: string | null;
  fetchedAt: string;
}

export type ParsedItem =
  | { ok: true; records: NormalizedRecord[] }
  | { ok: false; reason: string; detail?: string };

/**
 * Everything a source must implement, and nothing more. No method may write to
 * the store or depend on canonical state. `parse` must be pure (no I/O, no
 * clock, deterministic).
 */
export interface SourceAdapter {
  readonly key: string;
  readonly capabilities: SourceCapabilities;

  discover(ctx: AdapterContext): AsyncIterable<SourceItemRef>;
  fetch(ref: SourceItemRef, ctx: AdapterContext): Promise<RawItem>;
  parse(raw: RawItem, ctx: AdapterContext): ParsedItem;

  /**
   * Optional. Fetch + parse a linked entity the source hosts its own page for
   * (e.g. an event's venue). Best-effort: `null` on any failure.
   */
  fetchLinked?(
    kind: EntityKind,
    externalId: string,
    ctx: AdapterContext,
  ): Promise<NormalizedRecord | null>;
}

// ── validation ────────────────────────────────────────────────────────
export interface ValidationResult {
  outcome: "ok" | "rejected" | "needs_review";
  reasonCode: string | null;
  reasons: string[];
}

// ── identity resolution ───────────────────────────────────────────────
export interface IdentityOutcome {
  entity: EntityKind;
  decision: "matched" | "new_candidate" | "ambiguous";
  /** 0..4 for venues; 0..3 for events; null when not applicable. */
  tier: number | null;
  /** Canonical id when `matched`. */
  canonicalId: string | null;
  reasonCode: string;
  note: string;
}

// ── change detection ──────────────────────────────────────────────────
export type ChangeStatus =
  | "NEW"
  | "UPDATED"
  | "UNCHANGED"
  | "STALE"
  | "MISSING"
  | "GONE"
  | "REJECTED"
  | "NEEDS_REVIEW";

export type SourceStatus = "active" | "stale" | "missing" | "gone";

export interface FieldDelta {
  field: string;
  /**
   * Value before. The key is OMITTED (not `null`) when the field was ABSENT
   * from the stored comparable map — absence and an explicit `null` are
   * distinct (see `../sync/change-detection.ts#diffComparable`).
   */
  from?: JsonValue;
  /** Value after. Key OMITTED when the field is now ABSENT. */
  to?: JsonValue;
}

export interface StoredRecordState {
  canonicalId: string;
  contentHash: string;
  comparableFields: Record<string, JsonValue>;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncedAt: string;
  sourceStatus: SourceStatus;
  consecutiveMisses: number;
}

export interface ChangeResult {
  status: ChangeStatus;
  contentHashChanged: boolean;
  fieldDeltas: FieldDelta[];
  firstSeenAt: string;
  lastSeenAt: string;
  note: string;
}

// ── reconciliation ────────────────────────────────────────────────────
export interface ReconciliationThresholds {
  staleAfterMisses: number;
  missingAfterMisses: number;
  goneAfterMisses: number;
  /** Min fraction of the trailing-average discovery count for a healthy run. */
  minDiscoveryRatio: number;
  /** Max parse-failure fraction before a run is unhealthy. */
  maxParseFailureRatio: number;
}

export interface SourceStateSnapshot {
  key: string; // "sourceKey:externalId"
  sourceKey: string;
  externalId: string;
  canonicalId: string;
  kind: EntityKind;
  sourceStatus: SourceStatus;
  consecutiveMisses: number;
  /** Events in the past are frozen — never reconciled, always retained. */
  frozen: boolean;
  /** Already explicitly cancelled. */
  cancelled: boolean;
}

export type ReconcileTransition =
  | "keep-active"
  | "mark-stale"
  | "mark-missing"
  | "mark-gone"
  | "no-op";

export interface ReconcileAction {
  key: string;
  canonicalId: string;
  kind: EntityKind;
  from: SourceStatus;
  transition: ReconcileTransition;
  misses: number;
  note: string;
}

export interface ReconciliationPlan {
  reconciled: boolean;
  runStatus: RunStatus;
  actions: ReconcileAction[];
  skippedReason: string | null;
}

// ── the plan (pure output) ────────────────────────────────────────────
export interface CanonicalUpsert {
  kind: EntityKind;
  operation: "insert" | "update" | "link-only" | "skip";
  changeStatus: ChangeStatus;
  /** Target canonical id for update / link-only. */
  canonicalId: string | null;
  fieldDeltas: FieldDelta[];
  record: NormalizedRecord;
  identity: IdentityOutcome;
  /** For an event: the resolved venue id (from the venue identity pass). */
  resolvedVenueId?: string | null;
}

export interface ReviewItem {
  kind: EntityKind;
  reasonCode: string;
  reasons: string[];
  record: NormalizedRecord;
  suggestedCanonicalId: string | null;
}

export interface SyncRunContext {
  runId: string;
  sourceKey: string;
  startedAt: string;
  mode: "plan" | "apply";
  scope: { countries: string[]; cities: string[] };
}

export interface SyncRunStats {
  discovered: number;
  fetched: number;
  fetchFailed: number;
  parsed: number;
  parseFailed: number;
  byChangeStatus: Record<ChangeStatus, number>;
  venuesMatched: number;
  venuesNew: number;
  eventsMatched: number;
  eventsNew: number;
  reviewItems: number;
  reconciled: boolean;
  reconciliationActions: number;
  durationMs: number;
  status: RunStatus;
  healthy: boolean;
  notes: string[];
}

export interface SyncPlan {
  run: SyncRunContext;
  upserts: CanonicalUpsert[];
  reconciliation: ReconciliationPlan;
  reviewItems: ReviewItem[];
  stats: SyncRunStats;
}

/** Context-rich failure from a `CanonicalStore.apply` operation. */
export interface SyncApplyError {
  operation: "read" | "insert" | "update" | "link-only" | "reconcile";
  kind: EntityKind | null;
  canonicalId: string | null;
  sourceKey: string | null;
  externalId: string | null;
  /** e.g. "venues.insert", "events.update", "data_sources.select". */
  supabaseOp: string;
  message: string;
  code: string | null;
}

export interface SyncApplyResult {
  committed: boolean;
  inserted: number;
  updated: number;
  linked: number;
  reconciled: number;
  skipped: number;
  /** Operations the CURRENT schema cannot safely persist (each with a reason). */
  deferred: string[];
  notes: string[];
  /**
   * Set when apply stopped on a failure. The sequence is deterministic and
   * halts loudly — remaining upserts and all reconciliation are NOT attempted.
   */
  error: SyncApplyError | null;
}
