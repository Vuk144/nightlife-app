/**
 * Curated cross-source venue identities: "venue X on source S is canonical
 * venue V" — keyed by the source's own venue id, never by a display name.
 *
 *   canonical venue
 *     ├── OpenStreetMap identity   (its owning link: venues.source_id/external_id)
 *     ├── GIGS TIX identity        (curated here)
 *     └── any other source later   (curated here)
 *
 * A venue row carries ONE owning source link (Tier 0 in `../matching.ts`).
 * Every other source's id for the same place is declared here, as data,
 * scoped to a country + city, until it moves into a database table.
 *
 * `resolveCrossSourceIdentity` is pure. It only answers when a curated
 * identity applies (or the source id is linked to more than one venue); in
 * every other case it returns `none` and the caller's normal matching runs.
 */

import type { CanonicalVenue } from "./store.ts";

/**
 * How a curated identity points at its canonical venue:
 *   - `venueId`: the canonical row id (what a future table would store), or
 *   - `sourceKey` + `externalId`: an identity the canonical row already
 *     carries as its owning link (stable across renames and environments).
 */
export type CanonicalVenueRef = { venueId: string } | { sourceKey: string; externalId: string };

export interface CrossSourceVenueIdentity {
  countryCode: string;
  /** Canonical `cities.name`. The identity never applies outside this city. */
  cityName: string;
  /** The source that uses `externalId` for this venue (e.g. "gigstix"). */
  sourceKey: string;
  /** The source's own venue id (e.g. the GIGS venue slug). */
  externalId: string;
  canonical: CanonicalVenueRef;
  note?: string;
}

/** The curated identities in use. Data only — the resolver below is generic. */
export const CROSS_SOURCE_VENUE_IDENTITIES: CrossSourceVenueIdentity[] = [
  {
    countryCode: "RS",
    cityName: "Belgrade",
    sourceKey: "gigstix",
    externalId: "drugstore",
    canonical: { sourceKey: "OpenStreetMap", externalId: "node/5302622223" },
    note: 'GIGS TIX "Drugstore" = the OSM venue now named "Драгстор".',
  },
  {
    countryCode: "RS",
    cityName: "Belgrade",
    sourceKey: "gigstix",
    externalId: "kst",
    canonical: { sourceKey: "OpenStreetMap", externalId: "node/4162210293" },
    note: 'GIGS TIX "KST" = the OSM venue now named "Клуб студената технике".',
  },
  {
    countryCode: "RS",
    cityName: "Belgrade",
    sourceKey: "gigstix",
    externalId: "barrel-house",
    canonical: { sourceKey: "OpenStreetMap", externalId: "node/12068261369" },
    note: 'GIGS TIX "Barrel house" (Žorža Klemansoa 19) is part of the OSM venue "Belgrade Urban Distillery" at the same address.',
  },
  {
    countryCode: "RS",
    cityName: "Belgrade",
    sourceKey: "gigstix",
    externalId: "nova-zappa-barka",
    canonical: { sourceKey: "OpenStreetMap", externalId: "way/1446216912" },
    note: "GIGS TIX Nova Zappa Barka = the OSM venue Zappa Barka (same physical venue; confirmed by product owner).",
  },
];

export type CrossSourceIdentityResult =
  | { status: "matched"; venueId: string; venueName: string; note: string }
  | {
      status: "review";
      reasonCode: "venue-identity-conflict" | "venue-identity-target-missing";
      note: string;
      candidates: { id: string; name: string }[];
    }
  | { status: "none" };

export interface CrossSourceIdentityInput {
  sourceKey: string;
  /** The source's venue id; without one there is nothing to resolve. */
  externalId: string | null;
  city: { countryCode: string; cityName: string };
  identities: CrossSourceVenueIdentity[];
  /** Canonical venue candidates. Only those in `city` are ever returned. */
  venues: CanonicalVenue[];
}

const sameCountry = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

function refersTo(ref: CanonicalVenueRef, v: CanonicalVenue): boolean {
  return "venueId" in ref
    ? v.id === ref.venueId
    : v.sourceKey === ref.sourceKey && v.externalId === ref.externalId;
}

export function resolveCrossSourceIdentity(input: CrossSourceIdentityInput): CrossSourceIdentityResult {
  const externalId = input.externalId?.trim();
  if (!externalId) return { status: "none" };
  const { city } = input;

  const inCity = input.venues.filter((v) => sameCountry(v.countryCode, city.countryCode) && v.cityName === city.cityName);
  const applicable = input.identities.filter(
    (i) =>
      i.sourceKey === input.sourceKey &&
      i.externalId === externalId &&
      sameCountry(i.countryCode, city.countryCode) &&
      i.cityName === city.cityName,
  );
  // venues already linked to this exact source id (their owning link)
  const linked = inCity.filter((v) => v.sourceKey === input.sourceKey && v.externalId === externalId);

  if (applicable.length === 0 && linked.length <= 1) return { status: "none" };

  const key = `${input.sourceKey}:${externalId}`;
  const found = new Map<string, CanonicalVenue>(linked.map((v) => [v.id, v]));
  for (const identity of applicable) {
    const targets = inCity.filter((v) => refersTo(identity.canonical, v));
    if (targets.length !== 1) {
      return {
        status: "review",
        reasonCode: targets.length === 0 ? "venue-identity-target-missing" : "venue-identity-conflict",
        note:
          targets.length === 0
            ? `curated identity ${key} points at no venue in ${city.cityName}`
            : `curated identity ${key} points at ${targets.length} venues in ${city.cityName}`,
        candidates: targets.map((v) => ({ id: v.id, name: v.name })),
      };
    }
    found.set(targets[0].id, targets[0]);
  }

  const venues = [...found.values()];
  if (venues.length > 1) {
    return {
      status: "review",
      reasonCode: "venue-identity-conflict",
      note: `${key} identifies ${venues.length} different venues in ${city.cityName}`,
      candidates: venues.map((v) => ({ id: v.id, name: v.name })),
    };
  }
  const [venue] = venues;
  return { status: "matched", venueId: venue.id, venueName: venue.name, note: `${key} is "${venue.name}" (source identity)` };
}
