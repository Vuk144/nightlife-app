import type {
  ExcludedElement,
  InvalidElement,
  NormalizedVenue,
  OverpassElement,
} from "./types.ts";
import type { IngestionTarget } from "./targets.ts";
import { classifyOsmElement } from "./classify.ts";
import { normalizeName } from "./name.ts";

// Re-exported for backward compatibility — canonical home is ./name.ts
export { normalizeName, computeNameNormalized } from "./name.ts";

/**
 * OSM keys tried, in order, when the primary `name` tag is absent — recovers
 * venues that carry only a localised or alternate name. Still a real name, so
 * the false-positive risk of the fallback is nil.
 */
const NAME_FALLBACK_KEYS = [
  "name",
  "name:sr",
  "name:sr-Latn",
  "name:en",
  "int_name",
  "official_name",
  "alt_name",
  "loc_name",
  "brand",
] as const;

function resolveName(tags: Record<string, string>): string | undefined {
  for (const key of NAME_FALLBACK_KEYS) {
    const value = tags[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Node -> lat/lon; way/relation -> center.lat/lon. Range-checked. */
export function extractCoordinates(
  element: OverpassElement,
): { lat: number; lon: number } | null {
  const lat = element.type === "node" ? element.lat : element.center?.lat;
  const lon = element.type === "node" ? element.lon : element.center?.lon;

  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

/** Assemble a single address string from OSM `addr:*` tags, or null. */
export function extractAddress(tags: Record<string, string>): string | null {
  const street = tags["addr:street"]?.trim();
  const house = tags["addr:housenumber"]?.trim();
  const postcode = tags["addr:postcode"]?.trim();
  const city = tags["addr:city"]?.trim();

  const line1 = [street, house].filter(Boolean).join(" ").trim();
  const line2 = [postcode, city].filter(Boolean).join(" ").trim();
  const full = [line1, line2].filter(Boolean).join(", ").trim();

  return full.length > 0 ? full : null;
}

function cleanTag(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Turn one Overpass element into a NormalizedVenue, or report why it was not
 * kept:
 *   - `invalid`  — unusable data (bad type, missing name, missing/invalid
 *                  coordinates). Coordinates are never fabricated.
 *   - `excluded` — usable, but deliberately filtered out as not-nightlife /
 *                  not-a-venue by `classifyOsmElement`.
 */
export function toNormalizedVenue(
  element: OverpassElement,
  target?: IngestionTarget,
):
  | { ok: NormalizedVenue }
  | { invalid: InvalidElement }
  | { excluded: ExcludedElement } {
  const ref =
    element && element.type && typeof element.id === "number"
      ? `${element.type}/${element.id}`
      : "(unknown)";

  if (
    element.type !== "node" &&
    element.type !== "way" &&
    element.type !== "relation"
  ) {
    return { invalid: { ref, reason: `unsupported element type "${element.type}"` } };
  }

  const tags = element.tags ?? {};

  const name = resolveName(tags);
  if (!name) return { invalid: { ref, reason: "missing name tag" } };

  const coords = extractCoordinates(element);
  if (!coords) return { invalid: { ref, reason: "missing or invalid coordinates" } };

  const classification = classifyOsmElement(tags, ref, target);
  if (!classification.accepted) {
    return { excluded: { ref, name, reason: classification.reason } };
  }

  const nameNormalized =
    normalizeName(name) || name.toLowerCase().replace(/\s+/g, " ").trim();

  return {
    ok: {
      externalId: ref,
      osmType: element.type,
      osmId: element.id,
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      name,
      nameNormalized,
      latitude: coords.lat,
      longitude: coords.lon,
      address: extractAddress(tags),
      website: cleanTag(tags.website) ?? cleanTag(tags["contact:website"]),
      openingHours: cleanTag(tags.opening_hours),
      wikidata: cleanTag(tags.wikidata),
      category: classification.category,
      acceptedVia: classification.via,
      rescued: classification.rescued === true,
      review: classification.review === true,
    },
  };
}
