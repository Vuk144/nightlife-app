/**
 * Source-agnostic event ingestion types.
 *
 * The three-stage adapter contract (`discover` -> `fetch` -> `parse`) is the
 * only thing a new source has to implement. Adapters never touch Supabase and
 * never see the database: they turn source-specific data into a common
 * `NormalizedEvent`, and the engine owns everything after that.
 *
 * Two things adapters are explicitly NOT responsible for:
 *
 *  - Change-detection hashing. The generic sync engine computes the canonical
 *    content hash itself, from the shared comparable representation (see
 *    `../sync/canonical-hash.ts#hashComparable` + `../sync/change-detection.ts`).
 *    An adapter never provides a hash, and a source-specific hash would be
 *    meaningless to the engine.
 *  - Time-zone authority. Local times are LOCAL wall-clock strings; converting
 *    to a canonical UTC instant is the engine's job. `NormalizedEvent.timeZone`
 *    is only set when the source RELIABLY states it (see its doc); otherwise the
 *    engine resolves the zone from city-level data.
 */

/** One event discovered on a source, before it is fetched. */
export interface EventRef {
  /** Absolute URL of the event detail page / resource. */
  url: string;
  /** Source-native slug or id, when discovery already reveals one. */
  ref?: string;
  /** `<lastmod>` (or equivalent) as an ISO-8601 string, when the source gives one. */
  lastmod?: string;
}

/** The raw, unparsed payload for one event. */
export interface RawEvent {
  ref: EventRef;
  /** Final URL after any redirects. */
  url: string;
  /** HTTP status of the response that produced `body`. */
  status: number;
  /** Response body — HTML or JSON text, exactly as received. */
  body: string;
  /** Lower-cased `content-type`, when present. */
  contentType?: string;
  /** When the fetch completed (ISO-8601). Not used by pure parsing. */
  fetchedAt: string;
}

export type StartPrecision = "datetime" | "date";

/** A venue as named by an event source — not yet resolved to our `venues` row. */
export interface NormalizedVenueRef {
  name: string;
  address?: string;
  lat?: number;
  lon?: number;
  /** Stable id/slug for the venue on this source, when the source exposes one. */
  sourceVenueId?: string;
  /** Free-text city/place as stated by the source (drives city derivation). */
  city?: string;
}

export interface NormalizedPerformer {
  name: string;
  headliner?: boolean;
}

/**
 * A source-agnostic event. Produced by `parse()`, consumed by the engine.
 * Optional fields are left undefined when the source does not reliably provide
 * them — they are never invented or inferred from weak text.
 */
export interface NormalizedEvent {
  /** Stable identifier for this event ON THIS SOURCE. */
  externalId: string;
  /** Canonical URL of the event on the source. */
  sourceUrl: string;

  title: string;
  description?: string;

  /** Local wall-clock start, no offset: `"2026-10-30T23:00"` or `"2026-10-30"`. */
  startLocal: string;
  endLocal?: string;
  doorsLocal?: string;
  /**
   * IANA zone the local times are in. Set this ONLY when the source reliably
   * tells you, or the source is unambiguously single-zone (e.g. a national
   * ticketing platform). When set it is AUTHORITATIVE for this event. When
   * unset, the engine resolves the zone from city-level data — the future
   * canonical source of truth is per-city timezone data (`cities.timezone`),
   * not a source-wide default. Prefer leaving this unset over guessing.
   */
  timeZone?: string;
  startPrecision: StartPrecision;

  venue: NormalizedVenueRef;
  lineup?: NormalizedPerformer[];
  promoter?: string;
  ticketUrl?: string;
  coverImageUrl?: string;

  /**
   * Source-reported lifecycle. UNSET means the source did not say — it does
   * NOT imply `"scheduled"` and it NEVER implies cancellation. A source must
   * only report `"cancelled"` / `"postponed"` on an EXPLICIT signal, never
   * because the event was omitted from a listing.
   */
  status?: "scheduled" | "cancelled" | "postponed" | "rescheduled";

  /** Verbatim source-reported fields, kept for provenance and debugging. */
  reported: Record<string, unknown>;
}

/** Why `parse()` could not produce a `NormalizedEvent`. */
export interface ParseFailure {
  ok: false;
  /** Short reason code, e.g. `"missing-title"`, `"unparseable-date"`. */
  reason: string;
  /** Optional human-readable detail. */
  detail?: string;
}

export type ParseResult = { ok: true; event: NormalizedEvent } | ParseFailure;

/** Run scope + shared settings handed to every adapter call. Read-only. */
export interface SourceContext {
  /** ISO 3166-1 alpha-2 codes this run is scoped to (empty = source default). */
  countries: string[];
  /** City names this run is scoped to (empty = everything the source covers). */
  cities: string[];
  /**
   * FALLBACK IANA time zone for the source's region — a last resort only.
   * It must NEVER be treated as authoritative for an event when a city-specific
   * timezone is available. Precedence for an event's zone is:
   *   1. `NormalizedEvent.timeZone` when the source reliably provides it;
   *   2. city-level timezone data (future canonical source: `cities.timezone`);
   *   3. this value.
   * Adapters should prefer to leave `NormalizedEvent.timeZone` unset rather
   * than stamp this fallback, unless the source is genuinely single-zone.
   */
  defaultTimeZone: string;
  /** Descriptive User-Agent for every outbound request. */
  userAgent: string;
  /** Base URL of the source (allows pointing tests / mirrors elsewhere). */
  baseUrl: string;
  /** Max events to process this run (0 = no cap). */
  limit: number;
  /** Verbose logging. */
  verbose: boolean;
}

export interface SourceCapabilities {
  discovery: "sitemap" | "index" | "api" | "feed" | "manual";
  givesVenueId: boolean;
  givesLineup: boolean;
  givesPromoter: boolean;
  /** The source publishes its own venue pages (name / address / coordinates). */
  givesVenuePages: boolean;
}

/**
 * A venue as the SOURCE itself describes it, from the source's own venue page —
 * used to enrich an event-first venue candidate with a real location. Never a
 * database row.
 */
export interface SourceVenue {
  /** Stable venue id on the source. */
  externalId: string;
  sourceUrl: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  /** City text exactly as the source states it. */
  city: string | null;
}

/**
 * The contract every event source implements. No method may write to Supabase
 * or depend on database state; `parse()` must additionally be pure (no I/O, no
 * clock, deterministic).
 */
export interface EventSourceAdapter {
  /** Stable key, e.g. `"gigstix"` — matches a future `data_sources.adapter`. */
  readonly key: string;
  readonly capabilities: SourceCapabilities;

  /** Enumerate candidate events in scope, cheaply. */
  discover(ctx: SourceContext): AsyncIterable<EventRef>;

  /** Retrieve one event's raw payload, with retry/back-off. */
  fetch(ref: EventRef, ctx: SourceContext): Promise<RawEvent>;

  /** Turn a raw payload into a `NormalizedEvent`. Pure and deterministic. */
  parse(raw: RawEvent, ctx: SourceContext): ParseResult;

  /**
   * Optional. Fetch + parse the source's own venue page for one
   * `sourceVenueId`, to enrich an event-first venue candidate with a real
   * address / coordinates. Returns `null` when the source has no such page or
   * the fetch fails — enrichment is best-effort, never fatal.
   */
  fetchSourceVenue?(
    sourceVenueId: string,
    ctx: SourceContext,
  ): Promise<SourceVenue | null>;
}
