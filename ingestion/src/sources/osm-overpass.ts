import type { Config } from "../config.ts";
import type { IngestionTarget } from "../targets.ts";
import type {
  ExcludedElement,
  InvalidElement,
  NormalizedVenue,
  OverpassElement,
  OverpassResponse,
} from "../types.ts";
import { toNormalizedVenue } from "../normalize.ts";
import {
  KAFANA_NAME_OVERPASS,
  SHISHA_NAME_OVERPASS,
  SPLAV_NAME_OVERPASS,
} from "../classify.ts";
import { rescueNameOverpass, rescueOsmRefs } from "../rescue.ts";

/** Overpass area ids are 3600000000 + the OSM relation id. */
const OVERPASS_AREA_OFFSET = 3_600_000_000;

/** Layer B base amenities, server-gated to require a nightlife/performance signal. */
const LAYER_B_AMENITIES = [
  "restaurant",
  "cafe",
  "theatre",
  "arts_centre",
  "community_centre",
  "social_centre",
  "events_venue",
].join("|");

/**
 * Build the read-only Overpass QL query for one target city (Recall Pass v2).
 *
 * Only explicit whitelisted values — never a bare `["amenity"]`. Layer B is
 * gated server-side (tag-pairs) so ordinary restaurants/cafes are never
 * downloaded. `classifyOsmElement` re-checks every element post-fetch and is
 * the source of truth for accept / exclude.
 *
 *   Layer A  amenity = nightclub|bar|pub|biergarten|music_venue,
 *            club = music|nightlife, karaoke, leisure=dance, brewpub
 *   Regional restaurant|bar|pub|cafe with a kafana/... name; splav names;
 *            shisha names
 *   Layer B  restaurant|cafe|theatre|arts_centre|community_centre|
 *            social_centre|events_venue | craft=brewery | club=social
 *            — only paired with a documented music/performance signal
 *   Layer C  each curated rescue entry, by name (and by osm id when confirmed)
 */
export function buildOverpassQuery(target: IngestionTarget): string {
  const areaId = OVERPASS_AREA_OFFSET + target.osmRelationId;
  const lines: string[] = [
    "[out:json][timeout:240];",
    `area(id:${areaId})->.bg;`,
    "(",
    "  // Layer A — nightlife by definition",
    '  nwr["amenity"="nightclub"](area.bg);',
    '  nwr["amenity"="bar"](area.bg);',
    '  nwr["amenity"="pub"](area.bg);',
    '  nwr["amenity"="biergarten"](area.bg);',
    '  nwr["amenity"="music_venue"](area.bg);',
    '  nwr["amenity"="karaoke_box"](area.bg);',
    '  nwr["club"~"^(music|nightlife|social)$"](area.bg);',
    '  nwr["karaoke"="yes"](area.bg);',
    '  nwr["leisure"~"^(dance|karaoke)$"](area.bg);',
    "  // Regional name layers — kafana / splav / shisha",
    `  nwr["amenity"~"^(restaurant|bar|pub|cafe)$"]["name"~"${KAFANA_NAME_OVERPASS}",i](area.bg);`,
    `  nwr["amenity"~"^(restaurant|bar|pub|nightclub)$"]["name"~"${SPLAV_NAME_OVERPASS}",i](area.bg);`,
    `  nwr["amenity"~"^(cafe|bar|pub|restaurant)$"]["name"~"${SHISHA_NAME_OVERPASS}",i](area.bg);`,
    `  nwr["amenity"~"^(cafe|restaurant)$"]["shisha"="yes"](area.bg);`,
    "  // Layer B — base category + a documented signal (server-gated)",
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["live_music"](area.bg);`,
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["music"~"^(live|dj)$"](area.bg);`,
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["music:live"="yes"](area.bg);`,
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["concert"="yes"](area.bg);`,
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["dancing"="yes"](area.bg);`,
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["dancefloor"="yes"](area.bg);`,
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["stage"="yes"](area.bg);`,
    `  nwr["amenity"~"^(${LAYER_B_AMENITIES})$"]["karaoke"="yes"](area.bg);`,
    '  nwr["amenity"="theatre"]["theatre:type"~"^(concert_hall|music|cabaret)$"](area.bg);',
    '  nwr["amenity"="theatre"]["theatre:genre"~"^(comedy|cabaret|stand_up)$"](area.bg);',
    '  nwr["amenity"="community_centre"]["community_centre"~"^(music|arts|youth_centre)$"](area.bg);',
    '  nwr["amenity"~"^(restaurant|cafe)$"]["bar"="yes"](area.bg);',
    '  nwr["amenity"~"^(restaurant|cafe|pub|bar)$"]["microbrewery"="yes"](area.bg);',
    '  nwr["amenity"~"^(restaurant|cafe|pub|bar)$"]["brewery"](area.bg);',
    '  nwr["amenity"~"^(restaurant|cafe|pub|bar)$"]["real_ale"="yes"](area.bg);',
    '  nwr["craft"="brewery"]["microbrewery"="yes"](area.bg);',
    '  nwr["craft"="brewery"]["taproom"="yes"](area.bg);',
    '  nwr["craft"="brewery"]["amenity"~"^(bar|pub)$"](area.bg);',
  ];

  // Layer C — curated rescue candidates
  const rescueNames = rescueNameOverpass(target.countryId, target.cityName);
  if (rescueNames) {
    lines.push("  // Layer C — curated rescue (by name)");
    lines.push(`  nwr["name"~"^(${rescueNames})$",i](area.bg);`);
  }
  const refs = rescueOsmRefs(target.countryId, target.cityName);
  for (const type of ["node", "way", "relation"] as const) {
    if (refs[type].length > 0) {
      lines.push(`  ${type}(id:${refs[type].join(",")});`);
    }
  }

  lines.push(");", "out tags center;");
  return lines.join("\n");
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST the query to Overpass, with polite retries (linear back-off) on
 * transient errors and timeouts. Throws on a definitive failure — the caller
 * must then abort the run and write nothing.
 */
export async function fetchOverpass(
  query: string,
  config: Config,
  options: { attempts?: number; timeoutMs?: number } = {},
): Promise<OverpassResponse> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 180_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(config.overpassUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": config.overpassUserAgent,
          Accept: "application/json",
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
          const backoff = 5_000 * attempt;
          console.warn(
            `  Overpass HTTP ${response.status}; retrying in ${backoff / 1000}s (attempt ${attempt}/${attempts})`,
          );
          await sleep(backoff);
          continue;
        }
        throw new Error(`Overpass request failed: HTTP ${response.status}`);
      }

      const payload = (await response.json()) as OverpassResponse & {
        remark?: string;
      };
      // Overloaded Overpass instances answer 200 with an error in `remark` and
      // no `elements`. Treat that as a transient failure, not an empty city —
      // a silent zero-result fetch must never look like a successful sync.
      if (typeof payload.remark === "string" && !Array.isArray(payload.elements)) {
        throw new Error(`Overpass returned an error remark: ${payload.remark}`);
      }
      if (!Array.isArray(payload.elements)) {
        throw new Error("Overpass response had no elements array");
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const backoff = 5_000 * attempt;
        console.warn(
          `  Overpass request error (${(error as Error).message}); retrying in ${backoff / 1000}s (attempt ${attempt}/${attempts})`,
        );
        await sleep(backoff);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `Overpass request failed after ${attempts} attempts: ${
      (lastError as Error)?.message ?? "unknown error"
    }`,
  );
}

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
