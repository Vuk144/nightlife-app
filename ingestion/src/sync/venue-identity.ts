/**
 * Generic venue identity resolution.
 *
 * This is a thin, source-agnostic ADAPTER over the venue pipeline's existing
 * deterministic matcher (`../matching.ts#resolveMatch`, tiers 0-4). There is NO
 * parallel matcher and NO new matching rules here — only translation between
 * the generic record model and the matcher's inputs.
 *
 *   Tier 0  exact source key + external id
 *   Tier 1  strong external identity — Wikidata id, or a dedicated (non-platform)
 *           website domain
 *   Tier 2  same city + exact normalized name
 *   Tier 3  curated alias (country + city + name, from data) + a proximity guard
 *   Tier 4  new venue candidate
 *
 * Coordinates alone never merge two venues — proximity is only ever a guard on
 * an already-curated Tier 3 alias.
 *
 * City-agnostic: the caller passes the city and the city's venues; the matcher
 * body contains no city or country names.
 */

import { resolveMatch, type MatchContext } from "../matching.ts";
import type { ExistingVenue, NormalizedVenue } from "../types.ts";
import type { GeoPoint, IdentityOutcome, SourceRef } from "./types.ts";

export interface VenueIdentityInput {
  source: SourceRef;
  name: string;
  /** Normalized with the country's normalization profile (see `./normalization.ts`). */
  normalizedName: string;
  coordinates: GeoPoint | null;
  address: string | null;
  website: string | null;
  wikidata: string | null;
}

/** A canonical venue reduced to the fields the matcher needs. */
export interface VenueMatchCandidate {
  id: string;
  name: string;
  normalizedName: string;
  sourceKey: string | null;
  externalId: string | null;
  sourceUrl: string | null;
  coordinates: GeoPoint | null;
  coordinatesSource: string | null;
  address: string | null;
  website: string | null;
  wikidata: string | null;
}

export interface VenueIdentityRequest {
  incoming: VenueIdentityInput;
  scope: { countryCode: string; cityName: string };
  existingInCity: VenueMatchCandidate[];
}

/*
 * NOTE — curated venue aliases (Tier 3): `resolveMatch` reads the checked-in
 * `../aliases.ts#VENUE_ALIASES` table directly and the matcher API
 * (`MatchContext`) has no hook to override it. There is deliberately NO
 * `aliases` parameter on `VenueIdentityRequest`: passing one would have been
 * silently ignored. When aliases move to a `venue_aliases` DB row set (a
 * separate, later task), that task will thread the configured set through the
 * matcher itself — not through a dead field here.
 */

function toExistingVenue(c: VenueMatchCandidate): ExistingVenue {
  return {
    id: c.id,
    name: c.name,
    name_normalized: c.normalizedName,
    source_id: c.sourceKey,
    external_id: c.externalId,
    source_url: c.sourceUrl,
    latitude: c.coordinates?.latitude ?? null,
    longitude: c.coordinates?.longitude ?? null,
    coordinates_source: c.coordinatesSource,
    address: c.address,
    website: c.website,
    opening_hours: null,
    wikidata: c.wikidata,
  };
}

function toIncomingVenue(input: VenueIdentityInput): NormalizedVenue {
  return {
    externalId: input.source.externalId,
    osmType: "node",
    osmId: 0,
    sourceUrl: input.source.sourceUrl ?? "",
    name: input.name,
    nameNormalized: input.normalizedName,
    // NaN keeps the Tier 3 proximity guard from asserting a distance-based link
    // when we have no coordinates; a real point is passed through when present.
    latitude: input.coordinates?.latitude ?? Number.NaN,
    longitude: input.coordinates?.longitude ?? Number.NaN,
    address: input.address,
    website: input.website,
    openingHours: null,
    wikidata: input.wikidata,
  };
}

export function resolveVenueIdentity(req: VenueIdentityRequest): IdentityOutcome {
  const ctx: MatchContext = {
    target: {
      countryId: req.scope.countryCode,
      cityName: req.scope.cityName,
      osmRelationId: 0,
    },
    osmSourceId: req.incoming.source.sourceKey,
    existing: req.existingInCity.map(toExistingVenue),
    consumed: new Set<string>(),
  };

  const outcome = resolveMatch(toIncomingVenue(req.incoming), ctx);

  if (outcome.kind === "match") {
    return {
      entity: "venue",
      decision: "matched",
      tier: outcome.tier,
      canonicalId: outcome.venue.id,
      reasonCode: `venue-tier-${outcome.tier}`,
      note: outcome.note ?? `matched "${outcome.venue.name}" at tier ${outcome.tier}`,
    };
  }
  if (outcome.kind === "skip") {
    return {
      entity: "venue",
      decision: "ambiguous",
      tier: null,
      canonicalId: null,
      reasonCode: "venue-ambiguous",
      note: outcome.note,
    };
  }
  return {
    entity: "venue",
    decision: "new_candidate",
    tier: 4,
    canonicalId: null,
    reasonCode: "venue-new-candidate",
    note: outcome.note ?? "no existing venue matched",
  };
}
