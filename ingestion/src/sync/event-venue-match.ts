/**
 * Event venue hint → an EXISTING canonical venue. Read-only: it never
 * creates a venue and never invents a canonical id.
 *
 * `matchEventVenue` is pure. It reuses the generic venue identity layer
 * (`./venue-identity.ts#matchVenue` → `../matching.ts#resolveMatch`, tiers
 * 0–3) unchanged, restricted to the event's city:
 *
 *   Tier 0  the source's own venue id (e.g. the GIGS venue slug) already
 *           linked to a canonical venue — exact
 *   Tier 1  a shared wikidata id / dedicated website domain
 *   Tier 2  exactly one venue in the city with the same normalized name
 *   Tier 3  a curated alias, with the proximity guard
 *
 * and reports one of three outcomes:
 *
 *   matched     one venue, confidently — the only outcome with a venue id
 *   review      plausible but not confident: several venues fit, or a
 *               curated-alias link beyond its distance guard
 *   unresolved  nothing to match on, no resolved city, or no existing venue
 *
 * `matchEventVenueInStore` (below) is the separate, read-only store adapter
 * that resolves the city through config and loads that city's venues.
 */

import { findAlias } from "../aliases.ts";
import { computeNameNormalized } from "../name.ts";
import type { ConfigProvider } from "./config.ts";
import type { NormalizedEvent } from "./event-contract.ts";
import { profileFor } from "./normalization.ts";
import type { CanonicalStore, CanonicalVenue } from "./store.ts";
import type { VenueLinkHint } from "./types.ts";
import { resolveCrossSourceIdentity, type CrossSourceVenueIdentity } from "./venue-cross-source-identity.ts";
import { matchVenue, type VenueMatchCandidate } from "./venue-identity.ts";

export type EventVenueCandidate = { id: string; name: string };

export type EventVenueMatch =
  | { status: "matched"; venueId: string; venueName: string; tier: 0 | 1 | 2 | 3; note: string }
  | {
      status: "review";
      reasonCode:
        | "venue-ambiguous"
        | "venue-alias-beyond-guard"
        | "venue-identity-conflict"
        | "venue-identity-target-missing";
      note: string;
      candidates: EventVenueCandidate[];
    }
  | {
      status: "unresolved";
      reasonCode: "no-venue-identity" | "city-unresolved" | "no-existing-venue";
      note: string;
    };

export interface EventVenueMatchInput {
  /** The event's source (e.g. "gigstix"): scopes the source venue id. */
  sourceKey: string;
  hint: VenueLinkHint | undefined;
  /** The event's city, already resolved to a canonical city; null = unresolved. */
  city: { countryCode: string; cityName: string } | null;
  /** Canonical venues to consider. Only those in `city` are ever matched. */
  venues: CanonicalVenue[];
  /** The country's name-normalization profile (see `./normalization.ts`). */
  normalizeName: (raw: string) => string;
  /**
   * Curated cross-source identities, checked before the name tiers (see
   * `./venue-cross-source-identity.ts`). Pass `CROSS_SOURCE_VENUE_IDENTITIES`;
   * omitted = none.
   */
  crossSourceIdentities?: CrossSourceVenueIdentity[];
}

export function matchEventVenue(input: EventVenueMatchInput): EventVenueMatch {
  const { hint, city, normalizeName } = input;
  const name = hint?.name?.trim() ?? "";
  const sourceVenueId = hint?.sourceVenueId?.trim() || null;
  if (!hint || (!name && !sourceVenueId)) {
    return { status: "unresolved", reasonCode: "no-venue-identity", note: "the event names no venue and no source venue id" };
  }
  if (!city) {
    return { status: "unresolved", reasonCode: "city-unresolved", note: "the event's city did not resolve; venues are only matched within a city" };
  }

  // The source's own venue id first: a curated cross-source identity (or a
  // conflict around that id) is authoritative over any name.
  const identity = resolveCrossSourceIdentity({
    sourceKey: input.sourceKey,
    externalId: sourceVenueId,
    city,
    identities: input.crossSourceIdentities ?? [],
    venues: input.venues,
  });
  if (identity.status === "matched") {
    return { status: "matched", venueId: identity.venueId, venueName: identity.venueName, tier: 0, note: identity.note };
  }
  if (identity.status === "review") return identity;

  // City scope: a same-named venue in another city is never a candidate.
  const inCity = input.venues.filter(
    (v) => v.countryCode.toUpperCase() === city.countryCode.toUpperCase() && v.cityName === city.cityName,
  );
  const candidates: VenueMatchCandidate[] = inCity.map((v) => ({
    id: v.id,
    name: v.name,
    // same rule as the engine: a NULL stored name_normalized is derived in memory
    normalizedName: v.normalizedName || normalizeName(v.name),
    sourceKey: v.sourceKey,
    externalId: v.externalId,
    sourceUrl: v.sourceUrl,
    coordinates: v.coordinates,
    coordinatesSource: v.coordinatesSource,
    address: v.address,
    website: v.website,
    wikidata: v.wikidata,
  }));

  const normalizedName = name ? normalizeName(name) : "";
  const outcome = matchVenue({
    incoming: {
      // same source-identity key as the engine's event path (./engine.ts)
      source: { sourceKey: input.sourceKey, externalId: sourceVenueId ?? `name:${normalizedName}`, sourceUrl: null },
      name,
      normalizedName,
      coordinates: hint.coordinates,
      address: hint.address,
      website: null,
      wikidata: null,
    },
    scope: city,
    existingInCity: candidates,
  });

  if (outcome.kind === "match") {
    const venue = { id: outcome.venue.id, name: outcome.venue.name };
    const note = outcome.note ?? `matched "${venue.name}" at tier ${outcome.tier}`;
    if (outcome.review) {
      return { status: "review", reasonCode: "venue-alias-beyond-guard", note, candidates: [venue] };
    }
    return { status: "matched", venueId: venue.id, venueName: venue.name, tier: outcome.tier, note };
  }
  if (outcome.kind === "skip") {
    return { status: "review", reasonCode: "venue-ambiguous", note: outcome.note, candidates: ambiguousCandidates(candidates, normalizedName, city) };
  }
  return { status: "unresolved", reasonCode: "no-existing-venue", note: outcome.note ?? "no existing venue matched" };
}

/** The venues behind an ambiguous result: same normalized name, else the curated alias's target name. */
function ambiguousCandidates(
  candidates: VenueMatchCandidate[],
  normalizedName: string,
  city: { countryCode: string; cityName: string },
): EventVenueCandidate[] {
  const alias = normalizedName ? findAlias(city.countryCode, city.cityName, normalizedName) : null;
  const keys = new Set([normalizedName, alias ? computeNameNormalized(alias.canonicalName) : ""].filter(Boolean));
  return candidates.filter((c) => keys.has(c.normalizedName)).map((c) => ({ id: c.id, name: c.name }));
}

// ── read-only store adapter (not pure) ──────────────────────────────────

/**
 * Resolve an event's city through config (data-driven, including
 * `CityConfig.nameAliases`, e.g. "Beograd" → Belgrade), load that city's
 * canonical venues from the store, and run `matchEventVenue`. Reads only.
 */
export async function matchEventVenueInStore(
  event: NormalizedEvent,
  deps: { config: ConfigProvider; store: CanonicalStore; crossSourceIdentities?: CrossSourceVenueIdentity[] },
): Promise<EventVenueMatch> {
  const countryCode = event.scope.countryCode;
  const hint = event.links.venue;
  const resolution = deps.config.resolveCity(countryCode, hint?.cityText || event.scope.cityText);
  const cityCountry = resolution?.city.countryCode ?? null;
  const cityRow = resolution && cityCountry
    ? (await deps.store.listCities(cityCountry)).find((c) => c.name === resolution.city.canonicalName)
    : undefined;

  const normalizeName = profileFor(deps.config.country(cityCountry ?? countryCode)).normalizeName;
  const base = {
    sourceKey: event.provenance.sourceKey,
    hint,
    normalizeName,
    crossSourceIdentities: deps.crossSourceIdentities,
  };
  if (!resolution || !cityCountry || !cityRow) return matchEventVenue({ ...base, city: null, venues: [] });

  return matchEventVenue({
    ...base,
    city: { countryCode: cityCountry, cityName: resolution.city.canonicalName },
    venues: await deps.store.listVenuesInCity(cityRow.id),
  });
}
