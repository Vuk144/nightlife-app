import type { VenueCategory } from "./types.ts";
import type { IngestionTarget } from "./targets.ts";
import { computeNameNormalized } from "./name.ts";
import { findRescue } from "./rescue.ts";

/**
 * Recall Pass v2 — decides whether an OpenStreetMap element belongs in the
 * nightlife / music-discovery dataset, and assigns a transient `VenueCategory`
 * used ONLY for the dry-run summary. Nothing here is persisted.
 *
 * Order (first hit wins; hard exclusions always win over everything):
 *
 *   0. hard exclusions — lifecycle, shop, office, excluded amenities,
 *      lodging-only, elderly community centre, private/members without a signal
 *   1. Layer C — curated city rescue list (data, not code)
 *   2. Layer B name layers — kafana/mehana/... names; splav names; shisha names
 *   3. Layer A — automatic global nightlife categories
 *   4. Layer B — signal-gated ambiguous categories, with strong/medium/weak tiers
 *   5. otherwise — excluded
 *
 * Music information is OPTIONAL: Layer A never requires a signal. A signal is
 * only ever *additional evidence* for an ambiguous Layer B category; it is
 * never used to reject a Layer A venue. No rule uses opening hours or the
 * time of day — nightlife events happen at any hour.
 */

export const CATEGORY_LABELS: Record<VenueCategory, string> = {
  nightclub: "music / nightclub",
  concert_hall: "concert hall / music-performance venue",
  bar: "bar",
  pub_brewery: "pub / brewery / beer venue",
  kafana: "kafana / traditional nightlife",
  nightlife_venue: "signal-gated nightlife venue (restaurant / cafe / cultural)",
  other_nightlife: "other accepted nightlife category",
};

// ── Regional name layers (Serbia / Balkans-specific) ───────────────────

/**
 * Escape one string so it matches literally inside a regex. Applied to each
 * regional vocabulary term BEFORE the terms are `|`-joined into a
 * `*_NAME_OVERPASS` alternation for the Overpass `~"…"` operator, so a term
 * with a regex metacharacter can never change the pattern's meaning (audit B6).
 * The `|` between terms stays intentional alternation.
 *
 * `rescue.ts` keeps its own escaper for the Layer C rescue names — deliberately
 * not shared (that path is unchanged).
 */
export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const KAFANA_TERMS = [
  "kafana", "кафана", "Кафана",
  "mehana", "meana", "механа", "Механа",
  "birtija", "биртија", "Биртија",
  "krčma", "krcma", "крчма", "Крчма",
  "taverna", "таверна", "Таверна",
  "čarda", "carda", "чарда", "Чарда",
];
export const KAFANA_NAME_OVERPASS = KAFANA_TERMS.map(escapeRegexLiteral).join("|");
export const KAFANA_NAME_REGEX = new RegExp(KAFANA_TERMS.join("|"), "i");

const SPLAV_TERMS = ["splav", "сплав", "Сплав"];
export const SPLAV_NAME_OVERPASS = SPLAV_TERMS.map(escapeRegexLiteral).join("|");
export const SPLAV_NAME_REGEX = new RegExp(SPLAV_TERMS.join("|"), "i");

const SHISHA_TERMS = ["shisha", "hookah", "nargila", "nargile", "narghile", "наргил", "наргил"];
export const SHISHA_NAME_OVERPASS = SHISHA_TERMS.map(escapeRegexLiteral).join("|");
export const SHISHA_NAME_REGEX = new RegExp(SHISHA_TERMS.join("|"), "i");

const NAME_BASE_AMENITIES = new Set(["restaurant", "bar", "pub", "cafe"]);

// ── Layer B base categories ──────────────────────────────────────────
/**
 * Canonical Layer B base-amenity list — the single source of truth.
 * `classifyOsmElement` uses it to accept post-fetch; `sources/osm-overpass.ts`
 * consumes the same set to server-gate the Layer B query clauses. Insertion
 * order is the query's alternation order, so keep it stable.
 */
export const LAYER_B_AMENITIES = new Set([
  "restaurant",
  "cafe",
  "theatre",
  "arts_centre",
  "community_centre",
  "social_centre",
  "events_venue",
]);

// ── Hard exclusions ────────────────────────────────────────────────
const LIFECYCLE_PREFIXES = [
  "disused:", "abandoned:", "was:", "removed:", "razed:",
  "demolished:", "construction:", "proposed:",
];

const EXCLUDED_AMENITIES = new Set([
  "fast_food", "food_court", "ice_cream", "bbq",
  "cinema", "conference_centre", "exhibition_centre", "events_centre",
  "casino", "gambling", "adult_gaming_centre",
  "stripclub", "swingerclub", "brothel", "love_hotel",
  "social_facility", "vending_machine",
]);

const LODGING_TOURISM = new Set([
  "hotel", "hostel", "guest_house", "motel", "apartment",
  "chalet", "resort", "camp_site", "caravan_site",
]);

const ELDERLY_COMMUNITY_CENTRE = new Set([
  "for_the_elderly", "senior", "senior_citizens", "retirement", "refugee", "child_care",
]);

const PRIVATE_ACCESS = new Set(["private", "no", "members", "permit"]);
const NEGATIVE = new Set(["no", "none", "never", "0", "false"]);

/** `club` values Layer A accepts outright. `club=social` is Layer-B-gated. */
const CLUB_LAYER_A = new Set(["music", "nightlife"]);

function lower(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
function truthy(value: string | undefined): boolean {
  const v = lower(value);
  return v.length > 0 && !NEGATIVE.has(v);
}

// ── Signal detection with strength tiers ──────────────────────────────
export type SignalStrength = "strong" | "medium" | "weak" | "none";
export type SignalKind =
  | "music" | "performance" | "dance" | "brewery" | "bar" | "shisha";

export interface SignalResult {
  strength: SignalStrength;
  kind: SignalKind | null;
  reason: string | null;
}

const STRENGTH_RANK: Record<SignalStrength, number> = {
  none: 0, weak: 1, medium: 2, strong: 3,
};

const NAME_PERFORMANCE_REGEX =
  /\b(jazz club|blues club|music club|live music|open mic|comedy club|stand[- ]?up|kabare|cabaret|koncert|nastup)\b/i;

/**
 * The strongest documented nightlife / music / performance signal on an
 * element's tags. `amenity` and `name` shape a couple of context-sensitive
 * rules (e.g. `bar=yes` is medium on a restaurant, weak on a cafe).
 */
export function nightlifeSignal(
  tags: Record<string, string>,
  amenity: string,
  name: string,
): SignalResult {
  let best: SignalResult = { strength: "none", kind: null, reason: null };
  const consider = (strength: SignalStrength, kind: SignalKind, reason: string): void => {
    if (STRENGTH_RANK[strength] > STRENGTH_RANK[best.strength]) {
      best = { strength, kind, reason };
    }
  };

  // strong — explicit music / performance / dance / brewery function
  if (truthy(tags.live_music)) consider("strong", "music", `live_music=${tags.live_music}`);
  if (lower(tags.music) === "live") consider("strong", "music", "music=live");
  if (lower(tags["music:live"]) === "yes") consider("strong", "music", "music:live=yes");
  if (lower(tags.music) === "dj" || lower(tags.dj) === "yes") consider("strong", "music", "dj");
  if (lower(tags.karaoke) === "yes") consider("strong", "music", "karaoke=yes");
  if (lower(tags.concert) === "yes" || lower(tags.concerts) === "yes") {
    consider("strong", "performance", "concert=yes");
  }
  if (["concert_hall", "music", "cabaret"].includes(lower(tags["theatre:type"]))) {
    consider("strong", "performance", `theatre:type=${tags["theatre:type"]}`);
  }
  if (["music", "arts"].includes(lower(tags.community_centre))) {
    consider("strong", "performance", `community_centre=${tags.community_centre}`);
  }
  if (lower(tags.dancing) === "yes" || lower(tags.disco) === "yes") {
    consider("strong", "dance", tags.dancing ? "dancing=yes" : "disco=yes");
  }
  if (lower(tags.microbrewery) === "yes") consider("strong", "brewery", "microbrewery=yes");
  if (truthy(tags.brewery)) consider("strong", "brewery", `brewery=${tags.brewery}`);
  if (lower(tags.real_ale) === "yes") consider("strong", "brewery", "real_ale=yes");
  if (lower(tags.craft) === "brewery" && lower(tags.taproom) === "yes") {
    consider("strong", "brewery", "craft=brewery + taproom=yes");
  }

  // medium — accept, but flag for a human look
  if (lower(tags.bar) === "yes" && amenity === "restaurant") {
    consider("medium", "bar", "bar=yes (restaurant)");
  }
  if (lower(tags.dancefloor) === "yes") consider("medium", "dance", "dancefloor=yes");
  if (lower(tags.nightclub) === "yes") consider("medium", "music", "nightclub=yes");
  if (lower(tags.stage) === "yes") consider("medium", "performance", "stage=yes");
  if (["comedy", "cabaret", "stand_up"].includes(lower(tags["theatre:genre"]))) {
    consider("medium", "performance", `theatre:genre=${tags["theatre:genre"]}`);
  }
  // `community_centre=youth_centre` is NOT a signal on its own — a youth centre
  // that is a genuine music venue carries `community_centre=music` (strong) or
  // `live_music`, or is a curated Layer C rescue (e.g. Dom omladine).
  if (NAME_PERFORMANCE_REGEX.test(name)) {
    consider("medium", "performance", "name indicates a music/performance venue");
  }
  if (
    SHISHA_NAME_REGEX.test(name) &&
    (amenity === "cafe" || amenity === "pub" || amenity === "bar")
  ) {
    consider("medium", "shisha", "name indicates a shisha lounge");
  }

  // weak — never enough on its own
  if (lower(tags.bar) === "yes" && amenity === "cafe") {
    consider("weak", "bar", "bar=yes (cafe)");
  }
  if (truthy(tags.shisha) || truthy(tags.hookah) || lower(tags.smoking) === "shisha") {
    consider("weak", "shisha", "shisha tag");
  }
  if (lower(tags.alcohol) === "yes" || lower(tags.cocktails) === "yes") {
    consider("weak", "bar", "serves alcohol");
  }
  if (lower(tags.outdoor_seating) === "yes" || truthy(tags.smoking)) {
    consider("weak", "bar", "outdoor seating / smoking");
  }

  return best;
}

// ── Result type ─────────────────────────────────────────────────────
export type ClassifyResult =
  | {
      accepted: true;
      category: VenueCategory;
      /** Human-readable acceptance path, for the dry-run report. */
      via: string;
      rescued?: boolean;
      /** Accepted on a medium signal or rescue — worth a human look. */
      review?: boolean;
    }
  | { accepted: false; reason: string };

const PERFORMANCE_AMENITIES = new Set(["theatre", "arts_centre", "events_venue"]);

function categoryForSignal(kind: SignalKind | null, amenity: string): VenueCategory {
  if (kind === "brewery") return "pub_brewery";
  if (kind === "dance") return "other_nightlife";
  if (kind === "shisha") return "other_nightlife";
  // A cultural / performance venue with a music or performance signal is a
  // concert / music-performance venue.
  if ((kind === "performance" || kind === "music") && PERFORMANCE_AMENITIES.has(amenity)) {
    return "concert_hall";
  }
  return "nightlife_venue";
}

/**
 * @param tags   the element's OSM tags
 * @param ref    "node/123" etc. — only used for a confirmed rescue `osmRef`
 * @param target the ingestion target — only used to scope the rescue list
 */
export function classifyOsmElement(
  tags: Record<string, string>,
  ref?: string,
  target?: IngestionTarget,
): ClassifyResult {
  const keys = Object.keys(tags);

  // 0. hard exclusions — win over everything, including a rescue entry
  const lifecycleKey = keys.find((key) =>
    LIFECYCLE_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  if (lifecycleKey) return { accepted: false, reason: `lifecycle tag "${lifecycleKey}"` };
  if (lower(tags.disused) === "yes" || lower(tags.abandoned) === "yes") {
    return { accepted: false, reason: "disused / abandoned" };
  }

  const amenity = lower(tags.amenity);
  const club = lower(tags.club);
  const craft = lower(tags.craft);
  const leisure = lower(tags.leisure);
  const name = tags.name ?? "";

  // `shop=no` / `office=no` are OSM NEGATIONS ("explicitly not a shop/office"),
  // not exclusions — `truthy()` filters the no/none/false/0 family.
  if (truthy(tags.shop)) return { accepted: false, reason: `shop=${tags.shop}` };
  if (truthy(tags.office)) return { accepted: false, reason: `office=${tags.office}` };
  if (amenity && EXCLUDED_AMENITIES.has(amenity)) {
    return { accepted: false, reason: `amenity=${amenity}` };
  }
  if (tags.tourism && LODGING_TOURISM.has(lower(tags.tourism)) && !amenity && !club) {
    return { accepted: false, reason: `primarily lodging (tourism=${tags.tourism})` };
  }
  if (
    amenity === "community_centre" &&
    ELDERLY_COMMUNITY_CENTRE.has(lower(tags.community_centre))
  ) {
    return { accepted: false, reason: `community_centre=${tags.community_centre}` };
  }

  const signal = nightlifeSignal(tags, amenity, name);
  const hasPublicSignal =
    STRENGTH_RANK[signal.strength] >= STRENGTH_RANK.medium ||
    CLUB_LAYER_A.has(club);

  const access = lower(tags.access);
  if (access && PRIVATE_ACCESS.has(access) && !hasPublicSignal) {
    return { accepted: false, reason: `access=${access} with no public nightlife signal` };
  }

  // 1. Layer C — curated city rescue (only if we have both a ref and a target)
  if (ref && target) {
    const rescue = findRescue(
      target.countryId,
      target.cityName,
      ref,
      computeNameNormalized(name),
    );
    if (rescue) {
      return {
        accepted: true,
        category: rescue.category,
        via: `Layer C rescue: ${rescue.name}`,
        rescued: true,
        review: true,
      };
    }
  }

  // 2. regional name layers
  if (NAME_BASE_AMENITIES.has(amenity) && KAFANA_NAME_REGEX.test(name)) {
    return { accepted: true, category: "kafana", via: "Band C: traditional-nightlife name" };
  }
  if (SPLAV_NAME_REGEX.test(name)) {
    if (amenity === "bar" || amenity === "pub" || amenity === "nightclub") {
      return {
        accepted: true,
        category: amenity === "nightclub" ? "nightclub" : "other_nightlife",
        via: `Band C: splav (${amenity})`,
      };
    }
    // A splav RESTAURANT enters only with a meaningful nightlife signal — a
    // real signal tag, or a drinking-venue word in the name. Otherwise it is
    // treated as an ordinary floating restaurant (add to Layer C if it turns
    // out to be a known river-nightlife venue).
    if (amenity === "restaurant") {
      const strongEnough = STRENGTH_RANK[signal.strength] >= STRENGTH_RANK.medium;
      const drinkingVenueName = /\b(bar|club|klub|cocktail|koktel|caffe)\b/i.test(name);
      if (strongEnough || drinkingVenueName) {
        return {
          accepted: true,
          category: "other_nightlife",
          via: `Band C: splav restaurant + ${
            strongEnough ? (signal.reason ?? "a signal") : "drinking-venue name"
          } — verify`,
          review: true,
        };
      }
      return {
        accepted: false,
        reason: "splav restaurant with no nightlife signal (add to Layer C if a known venue)",
      };
    }
  }

  // 3. Layer A — automatic
  if (amenity === "nightclub" || amenity === "music_venue") {
    return { accepted: true, category: "nightclub", via: `Layer A: amenity=${amenity}` };
  }
  if (club === "music") {
    return { accepted: true, category: "nightclub", via: "Layer A: club=music" };
  }
  if (amenity === "bar") {
    return {
      accepted: true,
      category: signal.kind === "brewery" ? "pub_brewery" : "bar",
      via: "Layer A: amenity=bar",
    };
  }
  if (amenity === "pub" || amenity === "biergarten") {
    return { accepted: true, category: "pub_brewery", via: `Layer A: amenity=${amenity}` };
  }
  if (craft === "brewery" && (amenity === "bar" || amenity === "pub")) {
    return { accepted: true, category: "pub_brewery", via: "Layer A: brewpub" };
  }
  if (club === "nightlife") {
    return { accepted: true, category: "other_nightlife", via: "Layer A: club=nightlife" };
  }
  if (
    lower(tags.karaoke) === "yes" ||
    amenity === "karaoke_box" ||
    leisure === "karaoke"
  ) {
    return { accepted: true, category: "other_nightlife", via: "Layer A: karaoke" };
  }
  if (leisure === "dance") {
    if (lower(tags["dance:teaching"]) === "yes") {
      return { accepted: false, reason: "leisure=dance is a teaching school" };
    }
    return { accepted: true, category: "other_nightlife", via: "Layer A: leisure=dance" };
  }

  // 4. Layer B — signal-gated ambiguous categories
  const layerBEligible =
    LAYER_B_AMENITIES.has(amenity) || craft === "brewery" || club === "social";

  if (layerBEligible) {
    if (signal.strength === "strong") {
      return {
        accepted: true,
        category: categoryForSignal(signal.kind, amenity),
        via: `Layer B strong: ${signal.reason}`,
      };
    }
    if (signal.strength === "medium") {
      return {
        accepted: true,
        category: categoryForSignal(signal.kind, amenity),
        via: `Layer B medium: ${signal.reason}`,
        review: true,
      };
    }
    const base = amenity || (club ? `club=${club}` : "craft=brewery");
    return {
      accepted: false,
      reason:
        signal.strength === "weak"
          ? `${base} with only a weak signal (${signal.reason})`
          : `${base} without a documented nightlife signal`,
    };
  }

  // 5. fallthrough
  return {
    accepted: false,
    reason: amenity
      ? `amenity=${amenity} not in scope`
      : club
        ? `club=${club} not in scope`
        : "no whitelisted nightlife tag",
  };
}
