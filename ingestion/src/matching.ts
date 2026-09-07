import type { ExistingVenue, NormalizedVenue } from "./types.ts";
import type { IngestionTarget } from "./targets.ts";
import { computeNameNormalized } from "./normalize.ts";
import { haversineMeters } from "./geo.ts";
import { apexDomain, findAlias, sameDedicatedDomain } from "./aliases.ts";

/** Tier 3: link when the OSM element is within this far of the aliased venue. */
export const TIER3_LINK_METERS = 300;
/** Tier 3: still link, but flag for review, between LINK and this distance. */
export const TIER3_REVIEW_METERS = 1000;
/** Tier 4 review: flag a new venue this close to a token-sharing existing one. */
export const NEW_NEAR_EXISTING_METERS = 150;
/** Tier 4 review: flag two new venues this close that share a name token. */
export const NEW_NEAR_NEW_METERS = 200;

export interface MatchContext {
  target: IngestionTarget;
  osmSourceId: string;
  existing: ExistingVenue[];
  /** ids of existing venues already linked earlier in this run. */
  consumed: Set<string>;
}

export type MatchOutcome =
  | { kind: "match"; tier: 0 | 1 | 2 | 3; venue: ExistingVenue; note?: string; review?: boolean }
  | { kind: "skip"; note: string }
  | { kind: "new"; note?: string; review?: boolean };

function coordsOf(v: {
  latitude: number | null;
  longitude: number | null;
}): { latitude: number; longitude: number } | null {
  return v.latitude != null && v.longitude != null
    ? { latitude: v.latitude, longitude: v.longitude }
    : null;
}

/**
 * Deterministic tiered matcher. Tiers are tried strictly in order 0 -> 4 and
 * the first hit wins.
 *
 * Coordinate proximity is used ONLY inside Tier 3, as a sanity check on a
 * curated alias — never to create a match on its own. Address is never a
 * matching signal. Two OSM elements in the same run are never matched to each
 * other; every match is against an existing database row.
 */
export function resolveMatch(
  incoming: NormalizedVenue,
  ctx: MatchContext,
): MatchOutcome {
  const free = (v: ExistingVenue): boolean => !ctx.consumed.has(v.id);

  // ---- Tier 0: same OSM object re-imported ------------------------------
  const t0 = ctx.existing.find(
    (v) =>
      free(v) &&
      v.source_id === ctx.osmSourceId &&
      v.external_id != null &&
      v.external_id === incoming.externalId,
  );
  if (t0) return { kind: "match", tier: 0, venue: t0 };

  // ---- Tier 1: shared canonical identifier -----------------------------
  if (incoming.wikidata) {
    const byQid = ctx.existing.find(
      (v) => free(v) && v.wikidata != null && v.wikidata === incoming.wikidata,
    );
    if (byQid) {
      return { kind: "match", tier: 1, venue: byQid, note: `wikidata ${incoming.wikidata}` };
    }
  }
  if (incoming.website) {
    const byDomain = ctx.existing.find(
      (v) => free(v) && sameDedicatedDomain(v.website, incoming.website),
    );
    if (byDomain) {
      return {
        kind: "match",
        tier: 1,
        venue: byDomain,
        note: `website domain ${apexDomain(incoming.website)}`,
      };
    }
  }

  // ---- Tier 2: exactly one exact name_normalized in the same city ------
  if (incoming.nameNormalized) {
    const exact = ctx.existing.filter(
      (v) =>
        free(v) &&
        v.name_normalized != null &&
        v.name_normalized === incoming.nameNormalized,
    );
    if (exact.length === 1) return { kind: "match", tier: 2, venue: exact[0] };
    if (exact.length > 1) {
      return {
        kind: "skip",
        note: `ambiguous: ${exact.length} existing venues share name_normalized="${incoming.nameNormalized}"`,
      };
    }
  }

  // ---- Tier 3: curated city-scoped alias, with the proximity guard -----
  const alias = findAlias(
    ctx.target.countryId,
    ctx.target.cityName,
    incoming.nameNormalized,
  );
  if (alias) {
    const canonKey = computeNameNormalized(alias.canonicalName);
    const canonMatches = ctx.existing.filter((v) => v.name_normalized === canonKey);

    if (canonMatches.length === 0) {
      return {
        kind: "new",
        note: `alias "${incoming.nameNormalized}" -> "${alias.canonicalName}", but no such venue in ${ctx.target.cityName}`,
        review: true,
      };
    }
    if (canonMatches.length > 1) {
      return {
        kind: "skip",
        note: `alias "${incoming.nameNormalized}" -> "${alias.canonicalName}" is ambiguous (${canonMatches.length} candidates)`,
      };
    }

    const canon = canonMatches[0];

    if (ctx.consumed.has(canon.id)) {
      return {
        kind: "new",
        note: `alias -> "${canon.name}", but it was already linked to another OSM element this run`,
        review: true,
      };
    }
    if (
      canon.source_id === ctx.osmSourceId &&
      canon.external_id != null &&
      canon.external_id !== incoming.externalId
    ) {
      return {
        kind: "new",
        note: `alias -> "${canon.name}", already linked to ${canon.external_id}`,
        review: true,
      };
    }

    const canonCoords = coordsOf(canon);
    if (!canonCoords) {
      return {
        kind: "match",
        tier: 3,
        venue: canon,
        note: `alias -> "${canon.name}" (existing venue has no coordinates to cross-check)`,
      };
    }

    const distance = Math.round(
      haversineMeters(
        { latitude: incoming.latitude, longitude: incoming.longitude },
        canonCoords,
      ),
    );
    if (distance <= TIER3_LINK_METERS) {
      return {
        kind: "match",
        tier: 3,
        venue: canon,
        note: `alias -> "${canon.name}" (${distance} m)`,
      };
    }
    if (distance <= TIER3_REVIEW_METERS) {
      return {
        kind: "match",
        tier: 3,
        venue: canon,
        note: `alias -> "${canon.name}" (${distance} m, over the ${TIER3_LINK_METERS} m guard)`,
        review: true,
      };
    }
    return {
      kind: "new",
      note: `alias -> "${canon.name}" but ${distance} m away (over ${TIER3_REVIEW_METERS} m) — not linked`,
      review: true,
    };
  }

  // ---- Tier 4: new venue ---------------------------------------------
  return { kind: "new" };
}

// --- Review-only helpers (dry-run output; nothing is persisted) --------

/**
 * Category / descriptor words that many unrelated venues share. Two venues
 * whose ONLY common token is one of these are not look-alikes — "British Pub"
 * and "Corner Pub" are just both pubs. Distinctive tokens still flag.
 */
const GENERIC_TOKENS = new Set([
  "pub", "bar", "club", "klub", "cafe", "kafe", "caffe", "coffee",
  "kafana", "mehana", "meana", "birtija", "krcma", "taverna", "carda",
  "restoran", "restaurant", "bistro", "grill", "pizzeria", "pizza",
  "gastro", "lounge", "garden", "house", "haus", "room", "space",
  "wine", "vino", "pivo", "pivnica", "beer", "craft", "rakija", "rakijashnica",
  "the", "and", "of", "kod", "code",
  "1", "2", "3",
]);

function nameTokens(nameNormalized: string): Set<string> {
  return new Set(nameNormalized.split(" ").filter(Boolean));
}

/** A distinctive (non-generic) token shared by both names, if any. */
function sharedToken(a: string, b: string): string | null {
  const other = nameTokens(b);
  for (const token of nameTokens(a)) {
    if (other.has(token) && !GENERIC_TOKENS.has(token)) return token;
  }
  return null;
}

/**
 * Advisory notes for records the matcher decided to INSERT, so a human can
 * eyeball possible duplicates it deliberately did not merge. Purely
 * informational, keyed by externalId — never affects the insert decision.
 */
export function reviewNotesForNewVenues(
  newVenues: NormalizedVenue[],
  existing: ExistingVenue[],
): Map<string, string> {
  const notes = new Map<string, string>();
  const add = (key: string, message: string): void => {
    notes.set(key, notes.has(key) ? `${notes.get(key)}; ${message}` : message);
  };

  for (const incoming of newVenues) {
    for (const v of existing) {
      const coords = coordsOf(v);
      if (!coords || !v.name_normalized) continue;
      const token = sharedToken(incoming.nameNormalized, v.name_normalized);
      if (!token) continue;
      const distance = Math.round(
        haversineMeters(
          { latitude: incoming.latitude, longitude: incoming.longitude },
          coords,
        ),
      );
      if (distance <= NEW_NEAR_EXISTING_METERS) {
        add(
          incoming.externalId,
          `near existing "${v.name}" (${distance} m, shared "${token}")`,
        );
      }
    }
  }

  for (let i = 0; i < newVenues.length; i++) {
    for (let j = i + 1; j < newVenues.length; j++) {
      const a = newVenues[i];
      const b = newVenues[j];
      const token = sharedToken(a.nameNormalized, b.nameNormalized);
      if (!token) continue;
      const distance = Math.round(
        haversineMeters(
          { latitude: a.latitude, longitude: a.longitude },
          { latitude: b.latitude, longitude: b.longitude },
        ),
      );
      if (distance <= NEW_NEAR_NEW_METERS) {
        add(a.externalId, `similar to "${b.name}" (${distance} m, shared "${token}")`);
        add(b.externalId, `similar to "${a.name}" (${distance} m, shared "${token}")`);
      }
    }
  }

  return notes;
}
