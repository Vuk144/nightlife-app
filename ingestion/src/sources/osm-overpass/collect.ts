import type { Config } from "../../config.ts";
import type { IngestionTarget } from "../../targets.ts";
import type {
  ExcludedElement,
  InvalidElement,
  NormalizedVenue,
} from "../../types.ts";
import { buildOverpassQuery } from "./query.ts";
import { fetchOverpass } from "./transport.ts";
import { parseOverpassVenues } from "./parse.ts";

/** Fetch + parse Overpass for one target city. */
export async function collectVenuesForTarget(
  target: IngestionTarget,
  config: Config,
): Promise<{
  venues: NormalizedVenue[];
  invalid: InvalidElement[];
  excluded: ExcludedElement[];
  fetched: number;
}> {
  const query = buildOverpassQuery(target);
  const response = await fetchOverpass(query, config);
  const { venues, invalid, excluded } = parseOverpassVenues(response, target);
  return {
    venues,
    invalid,
    excluded,
    fetched: venues.length + invalid.length + excluded.length,
  };
}
