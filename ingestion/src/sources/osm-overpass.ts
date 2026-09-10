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
  LAYER_B_AMENITIES as LAYER_B_AMENITY_SET,
  SHISHA_NAME_OVERPASS,
  SPLAV_NAME_OVERPASS,
} from "../classify.ts";
import { rescueNameOverpass, rescueOsmRefs } from "../rescue.ts";

/** Overpass area ids are 3600000000 + the OSM relation id. */
const OVERPASS_AREA_OFFSET = 3_600_000_000;

// ── Overpass QL framing ─────────────────────────────────────────────

/** Overpass server-side execution budget, seconds (`timeout:` in the settings line). */
const OVERPASS_SERVER_TIMEOUT_S = 240;

/** QL settings line — JSON output plus the server timeout. */
const OVERPASS_SETTINGS = `[out:json][timeout:${OVERPASS_SERVER_TIMEOUT_S}];`;

/** Name of the area set every clause is scoped to (`area(id:…)->.bg` / `(area.bg)`). */
const AREA_BINDING = "bg";

/** Clause suffix that scopes a match to the target city's area. */
const IN_AREA = `(area.${AREA_BINDING})`;

/** Opens / closes the Overpass union block. */
const UNION_OPEN = "(";
const UNION_CLOSE = ");";

/** Final statement — emit tags, plus a center point for ways / relations. */
const OVERPASS_OUT_STATEMENT = "out tags center;";

// ── QL fragment renderers (pure string builders) ────────────────────

type TagFilter =
  | { key: string }
  | { key: string; eq: string }
  | { key: string; matches: string; caseInsensitive?: boolean };

/** One Overpass tag filter: `["k"]`, `["k"="v"]`, or `["k"~"re"[,i]]`. */
function tagFilter(f: TagFilter): string {
  if ("eq" in f) return `["${f.key}"="${f.eq}"]`;
  if ("matches" in f) {
    return `["${f.key}"~"${f.matches}"${f.caseInsensitive ? ",i" : ""}]`;
  }
  return `["${f.key}"]`;
}

/** An anchored regex alternation, e.g. `^(a|b|c)$`. */
function anchoredAlt(values: readonly string[]): string {
  return `^(${values.join("|")})$`;
}

/** An explicit amenity whitelist filter — never a bare `["amenity"]`. */
function amenityIn(values: readonly string[]): string {
  return tagFilter({ key: "amenity", matches: anchoredAlt(values) });
}

/** One indented union line: `  nwr<filters>(area.bg);`. */
function areaClause(filters: string): string {
  return `  nwr${filters}${IN_AREA};`;
}

/** A `//` section header (union-indented) followed by its clauses. */
function section(title: string, clauses: readonly string[]): string[] {
  return [`  // ${title}`, ...clauses];
}

// ── Layer A — nightlife by definition ──────────────────────────────

/** Amenities that are a nightlife venue on their own (exact `amenity=` match). */
const LAYER_A_AMENITIES = [
  "nightclub",
  "bar",
  "pub",
  "biergarten",
  "music_venue",
  "karaoke_box",
] as const;

/** `club=` values that always denote a nightlife venue. */
const NIGHTLIFE_CLUB_VALUES = ["music", "nightlife", "social"] as const;

/** `leisure=` values that always denote a dance / performance venue. */
const NIGHTLIFE_LEISURE_VALUES = ["dance", "karaoke"] as const;

function layerAClauses(): string[] {
  return [
    ...LAYER_A_AMENITIES.map((value) =>
      areaClause(tagFilter({ key: "amenity", eq: value })),
    ),
    areaClause(tagFilter({ key: "club", matches: anchoredAlt(NIGHTLIFE_CLUB_VALUES) })),
    areaClause(tagFilter({ key: "karaoke", eq: "yes" })),
    areaClause(
      tagFilter({ key: "leisure", matches: anchoredAlt(NIGHTLIFE_LEISURE_VALUES) }),
    ),
  ];
}

// ── Regional name layers (Serbia / Balkans) ────────────────────────

/**
 * Base amenities + a curated case-insensitive name regex. The amenity set and
 * its order differ per layer, so each is spelled out. The name regexes are the
 * canonical vocab from classify.ts (still raw here — see audit B6).
 */
const REGIONAL_NAME_LAYERS: readonly {
  amenities: readonly string[];
  namePattern: string;
}[] = [
  { amenities: ["restaurant", "bar", "pub", "cafe"], namePattern: KAFANA_NAME_OVERPASS },
  { amenities: ["restaurant", "bar", "pub", "nightclub"], namePattern: SPLAV_NAME_OVERPASS },
  { amenities: ["cafe", "bar", "pub", "restaurant"], namePattern: SHISHA_NAME_OVERPASS },
];

/** Amenities for the standalone `shisha=yes` clause. */
const SHISHA_TAG_AMENITIES = ["cafe", "restaurant"] as const;

function regionalClauses(): string[] {
  return [
    ...REGIONAL_NAME_LAYERS.map(({ amenities, namePattern }) =>
      areaClause(
        amenityIn(amenities) +
          tagFilter({ key: "name", matches: namePattern, caseInsensitive: true }),
      ),
    ),
    areaClause(amenityIn(SHISHA_TAG_AMENITIES) + tagFilter({ key: "shisha", eq: "yes" })),
  ];
}

// ── Layer B — base category + a documented signal (server-gated) ────

/**
 * Layer B base-amenity gate. The list is the canonical `LAYER_B_AMENITIES`
 * Set from classify.ts (single source of truth); Set iteration preserves its
 * declared order, which is this alternation's order.
 */
const LAYER_B_AMENITY_FILTER = amenityIn([...LAYER_B_AMENITY_SET]);

/** Tag filters that count as a documented music / performance signal. */
const LAYER_B_SIGNAL_FILTERS: readonly string[] = [
  tagFilter({ key: "live_music" }),
  tagFilter({ key: "music", matches: "^(live|dj)$" }),
  tagFilter({ key: "music:live", eq: "yes" }),
  tagFilter({ key: "concert", eq: "yes" }),
  tagFilter({ key: "dancing", eq: "yes" }),
  tagFilter({ key: "dancefloor", eq: "yes" }),
  tagFilter({ key: "stage", eq: "yes" }),
  tagFilter({ key: "karaoke", eq: "yes" }),
];

/** Theatre / community-centre performance-signal clauses (self-contained filters). */
const LAYER_B_CULTURAL_CLAUSES: readonly string[] = [
  tagFilter({ key: "amenity", eq: "theatre" }) +
    tagFilter({ key: "theatre:type", matches: "^(concert_hall|music|cabaret)$" }),
  tagFilter({ key: "amenity", eq: "theatre" }) +
    tagFilter({ key: "theatre:genre", matches: "^(comedy|cabaret|stand_up)$" }),
  tagFilter({ key: "amenity", eq: "community_centre" }) +
    tagFilter({ key: "community_centre", matches: "^(music|arts|youth_centre)$" }),
];

/** Amenities that can carry a brewery / real-ale signal. */
const BREWERY_BASE_AMENITIES = ["restaurant", "cafe", "pub", "bar"] as const;

/** `craft=brewery` places that are also a public bar / pub. */
const BREWERY_TAPROOM_AMENITIES = ["bar", "pub"] as const;

/** "Has a bar" + brewery / taproom clauses (self-contained filters). */
const LAYER_B_DRINKS_CLAUSES: readonly string[] = [
  amenityIn(["restaurant", "cafe"]) + tagFilter({ key: "bar", eq: "yes" }),
  amenityIn(BREWERY_BASE_AMENITIES) + tagFilter({ key: "microbrewery", eq: "yes" }),
  amenityIn(BREWERY_BASE_AMENITIES) + tagFilter({ key: "brewery" }),
  amenityIn(BREWERY_BASE_AMENITIES) + tagFilter({ key: "real_ale", eq: "yes" }),
  tagFilter({ key: "craft", eq: "brewery" }) + tagFilter({ key: "microbrewery", eq: "yes" }),
  tagFilter({ key: "craft", eq: "brewery" }) + tagFilter({ key: "taproom", eq: "yes" }),
  tagFilter({ key: "craft", eq: "brewery" }) + amenityIn(BREWERY_TAPROOM_AMENITIES),
];

function layerBClauses(): string[] {
  return [
    ...LAYER_B_SIGNAL_FILTERS.map((signal) => areaClause(LAYER_B_AMENITY_FILTER + signal)),
    ...LAYER_B_CULTURAL_CLAUSES.map((filters) => areaClause(filters)),
    ...LAYER_B_DRINKS_CLAUSES.map((filters) => areaClause(filters)),
  ];
}

// ── Layer C — curated, city-specific rescue ────────────────────────

/**
 * Curated rescue candidates for one city: a case-insensitive name alternation
 * for ref-less entries (when any exist), plus explicit `id:` lookups for every
 * confirmed OSM object. Kept verbatim from the original inline implementation —
 * behavior is unchanged.
 */
function layerCClauses(target: IngestionTarget): string[] {
  const clauses: string[] = [];

  const rescueNames = rescueNameOverpass(target.countryId, target.cityName);
  if (rescueNames) {
    clauses.push("  // Layer C — curated rescue (by name)");
    clauses.push(`  nwr["name"~"^(${rescueNames})$",i](area.bg);`);
  }
  const refs = rescueOsmRefs(target.countryId, target.cityName);
  for (const type of ["node", "way", "relation"] as const) {
    if (refs[type].length > 0) {
      clauses.push(`  ${type}(id:${refs[type].join(",")});`);
    }
  }

  return clauses;
}

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
    OVERPASS_SETTINGS,
    `area(id:${areaId})->.${AREA_BINDING};`,
    UNION_OPEN,
    ...section("Layer A — nightlife by definition", layerAClauses()),
    ...section("Regional name layers — kafana / splav / shisha", regionalClauses()),
    ...section(
      "Layer B — base category + a documented signal (server-gated)",
      layerBClauses(),
    ),
    ...layerCClauses(target),
    UNION_CLOSE,
    OVERPASS_OUT_STATEMENT,
  ];

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
