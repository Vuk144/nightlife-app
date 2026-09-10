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
  const seen = new Set<string>();

  for (const element of elements) {
    const result = toNormalizedVenue(element, target);
    if ("ok" in result) {
      // The query's overlapping clauses can return the same element twice.
      if (seen.has(result.ok.externalId)) continue;
      seen.add(result.ok.externalId);
      venues.push(result.ok);
    } else if ("invalid" in result) invalid.push(result.invalid);
    else excluded.push(result.excluded);
  }

  return { venues, invalid, excluded };
}
