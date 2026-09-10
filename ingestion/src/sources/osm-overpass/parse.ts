import type { IngestionTarget } from "../../targets.ts";
import type {
  ExcludedElement,
  InvalidElement,
  NormalizedVenue,
  OverpassElement,
  OverpassResponse,
} from "../../types.ts";
import { toNormalizedVenue } from "../../normalize.ts";

/** Split an Overpass response into accepted venues, invalids and exclusions. */
export function parseOverpassVenues(
  response: OverpassResponse,
  target?: IngestionTarget,
): {
  venues: NormalizedVenue[];
  invalid: InvalidElement[];
  excluded: ExcludedElement[];
} {
  const elements: OverpassElement[] = Array.isArray(response.elements)
    ? response.elements
    : [];

  const venues: NormalizedVenue[] = [];
  const invalid: InvalidElement[] = [];
  const excluded: ExcludedElement[] = [];
  // The query's overlapping clauses can return the same OSM element more than
  // once. Deduplicate by source identity (`type/id`) across every bucket so a
  // repeat is reported once and cannot inflate the accepted / invalid /
  // excluded counts. An element with no resolvable identity ("(unknown)")
  // cannot be matched, so each such element is kept.
  const seen = new Set<string>();

  for (const element of elements) {
    const result = toNormalizedVenue(element, target);
    if ("ok" in result) {
      if (seen.has(result.ok.externalId)) continue;
      seen.add(result.ok.externalId);
      venues.push(result.ok);
    } else {
      const ref = "invalid" in result ? result.invalid.ref : result.excluded.ref;
      if (ref !== "(unknown)") {
        if (seen.has(ref)) continue;
        seen.add(ref);
      }
      if ("invalid" in result) invalid.push(result.invalid);
      else excluded.push(result.excluded);
    }
  }

  return { venues, invalid, excluded };
}
