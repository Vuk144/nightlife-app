import type { IngestionTarget } from "../../targets.ts";
import {
  KAFANA_NAME_OVERPASS,
  LAYER_B_AMENITIES as LAYER_B_AMENITY_SET,
  PERFORMANCE_NAME_OVERPASS,
  SHISHA_NAME_OVERPASS,
  SPLAV_NAME_OVERPASS,
} from "../../classify.ts";
import { rescueNameOverpass, rescueOsmRefs } from "../../rescue.ts";

/** Overpass area ids are 3600000000 + the OSM relation id. */
const OVERPASS_AREA_OFFSET = 3_600_000_000;

// ── Overpass QL framing ─────────────────────────────────────────────

/**
 * Overpass server-side execution budget, seconds (`timeout:` in the settings
 * line). Exported so the transport layer can keep its client abort timeout
 * strictly longer than this — see `transport.ts#DEFAULT_CLIENT_TIMEOUT_MS`.
 */
export const OVERPASS_SERVER_TIMEOUT_S = 240;

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

/**
 * One Overpass tag filter: `["k"]`, `["k"="v"]`, or `["k"~"re"[,i]]`.
 *
 * `matches` is interpolated into the `~"…"` regex position **verbatim** — it is
 * NOT escaped, because callers pass deliberate regex: `^(a|b)$` alternations
 * here, the pre-escaped `*_NAME_OVERPASS` vocab from the regional layers, and
 * `^(escaped)$` from Layer C. Escaping a literal is the caller's job — see
 * `classify.ts#escapeRegexLiteral` (audit B6).
 *
 * Exported for the B6 tests.
 */
export function tagFilter(f: TagFilter): string {
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

/**
 * `club=` values that always denote a nightlife venue — the classifier's Layer
 * A (`classify.ts#CLUB_LAYER_A` + `club=nightlife`). `club=social` is NOT one of
 * them: the classifier gates it on a signal (Layer B), so it is fetched as a
 * Layer B base below.
 */
const NIGHTLIFE_CLUB_VALUES = ["music", "nightlife"] as const;

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
 * Base amenities + a curated case-insensitive name pattern. The amenity set and
 * its order differ per layer, so each is spelled out. Each `namePattern` is a
 * `*_NAME_OVERPASS` alternation from classify.ts — every term already
 * regex-escaped, `|`-joined (audit B6).
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

/**
 * Tag filters for every strong / medium signal `classify.ts#nightlifeSignal`
 * accepts on a Layer B base amenity — each one paired with the Layer B amenity
 * gate. A signal the classifier accepts but this list omits is an object the
 * classifier would accept that discovery never fetches (e.g. a "Comedy Club"
 * name on a community_centre), so keep the two in step
 * (`test/osm-overpass-alignment.test.ts`).
 */
const LAYER_B_SIGNAL_FILTERS: readonly string[] = [
  tagFilter({ key: "live_music" }),
  tagFilter({ key: "music", matches: "^(live|dj)$" }),
  tagFilter({ key: "music:live", eq: "yes" }),
  tagFilter({ key: "concert", eq: "yes" }),
  tagFilter({ key: "dancing", eq: "yes" }),
  tagFilter({ key: "dancefloor", eq: "yes" }),
  tagFilter({ key: "stage", eq: "yes" }),
  tagFilter({ key: "karaoke", eq: "yes" }),
  tagFilter({ key: "dj", eq: "yes" }),
  tagFilter({ key: "concerts", eq: "yes" }),
  tagFilter({ key: "disco", eq: "yes" }),
  tagFilter({ key: "nightclub", eq: "yes" }),
  tagFilter({ key: "theatre:type", matches: "^(concert_hall|music|cabaret)$" }),
  tagFilter({ key: "theatre:genre", matches: "^(comedy|cabaret|stand_up)$" }),
  tagFilter({ key: "community_centre", matches: "^(music|arts|youth_centre)$" }),
  tagFilter({ key: "microbrewery", eq: "yes" }),
  tagFilter({ key: "brewery" }),
  tagFilter({ key: "real_ale", eq: "yes" }),
  tagFilter({ key: "name", matches: PERFORMANCE_NAME_OVERPASS, caseInsensitive: true }),
];

/**
 * Layer B bases that are not an amenity: `craft=brewery` and `club=social`.
 * The classifier accepts them only with a signal, but a signal can be ANY of
 * the above, and both sets are tiny, so each is fetched whole and gated
 * post-fetch by `classifyOsmElement`.
 */
const LAYER_B_NON_AMENITY_BASES: readonly string[] = [
  tagFilter({ key: "craft", eq: "brewery" }),
  tagFilter({ key: "club", eq: "social" }),
];

/** "Has a bar" on a restaurant / cafe (medium on a restaurant; weak, re-checked, on a cafe). */
const LAYER_B_DRINKS_CLAUSES: readonly string[] = [
  amenityIn(["restaurant", "cafe"]) + tagFilter({ key: "bar", eq: "yes" }),
];

function layerBClauses(): string[] {
  return [
    ...LAYER_B_SIGNAL_FILTERS.map((signal) => areaClause(LAYER_B_AMENITY_FILTER + signal)),
    ...LAYER_B_NON_AMENITY_BASES.map((filters) => areaClause(filters)),
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
