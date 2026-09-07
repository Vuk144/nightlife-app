/** Raw element as returned by the Overpass API `out tags center;` form. */
export interface OverpassElement {
  type: "node" | "way" | "relation" | string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements?: OverpassElement[];
}

/**
 * Transient venue category, assigned during ingestion from the OSM tags and
 * used ONLY for the dry-run summary. It is never written to the database —
 * the proper `venue_type` system comes later. It is optional so that a venue
 * created through the future EVENT-FIRST path (which does not run the OSM
 * classifier) does not need to fabricate one.
 */
export type VenueCategory =
  | "nightclub"
  | "concert_hall"
  | "bar"
  | "pub_brewery"
  | "kafana"
  | "nightlife_venue"
  | "other_nightlife";

/**
 * A source venue after normalization — ready to match and upsert. The same
 * shape is reusable by non-OSM sources (event-first, web enrichment): only
 * the identity/coordinate fields matter for matching + upsert; everything
 * marked "transient" is for the dry-run report only.
 */
export interface NormalizedVenue {
  /** e.g. "node/123456" — OSM type prefix + id (types share an id space). */
  externalId: string;
  osmType: "node" | "way" | "relation";
  osmId: number;
  sourceUrl: string;
  name: string;
  nameNormalized: string;
  latitude: number;
  longitude: number;
  address: string | null;
  website: string | null;
  openingHours: string | null;
  wikidata: string | null;
  /** Transient — dry-run summary only, never persisted. */
  category?: VenueCategory;
  /** Transient — how the classifier accepted it (e.g. "Layer A: amenity=bar"). */
  acceptedVia?: string;
  /** Transient — accepted via the curated city rescue list. */
  rescued?: boolean;
  /** Transient — accepted on a medium signal / rescue; worth a human look. */
  review?: boolean;
}

export interface InvalidElement {
  /** "node/123" etc., or "(unknown)" when the element has no usable ref. */
  ref: string;
  reason: string;
}

/** An element deliberately filtered out as not-nightlife / not-a-venue. */
export interface ExcludedElement {
  ref: string;
  name: string;
  reason: string;
}

export interface IngestSummary {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  invalid: number;
  excluded: number;
}

/** The columns of `venues` the ingestion runner reads and manages. */
export interface ExistingVenue {
  id: string;
  name: string;
  name_normalized: string | null;
  source_id: string | null;
  external_id: string | null;
  source_url: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinates_source: string | null;
  address: string | null;
  website: string | null;
  opening_hours: string | null;
  wikidata: string | null;
}

export type VenueActionKind =
  | "insert"
  | "update"
  | "unchanged"
  | "skip"
  | "invalid"
  | "excluded";

/** One line of the per-venue plan the runner reports for each element. */
export interface VenueAction {
  kind: VenueActionKind;
  name: string;
  externalId: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  /** Tier + rationale for a match; reason for a skip/invalid/excluded; hints for insert. */
  note?: string;
  /** Advisory only — printed in the dry-run output, never persisted. */
  review?: boolean;
  /** Transient category for accepted venues (insert/update/unchanged). */
  category?: VenueCategory;
}

export interface IngestResult {
  summary: IngestSummary;
  actions: VenueAction[];
}
