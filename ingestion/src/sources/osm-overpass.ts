/**
 * OSM / Overpass venue ingestion adapter — public entry point.
 *
 * The implementation is split into focused modules under `osm-overpass/`:
 *   - query.ts     — Overpass QL query construction for one IngestionTarget
 *   - transport.ts — the Overpass HTTP POST + retry / timeout logic
 *   - parse.ts     — OverpassResponse → NormalizedVenue / invalid / excluded
 *   - collect.ts   — build → fetch → parse orchestration for one target
 *
 * This barrel re-exports only the four functions the ingestion pipeline uses;
 * consumers import from here and never from the sub-modules.
 */
export { buildOverpassQuery } from "./osm-overpass/query.ts";
export { fetchOverpass } from "./osm-overpass/transport.ts";
export { parseOverpassVenues } from "./osm-overpass/parse.ts";
export { collectVenuesForTarget } from "./osm-overpass/collect.ts";
