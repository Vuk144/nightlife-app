/**
 * Event-first venue resolution — source-agnostic, READ-ONLY.
 *
 * For the venue named inside a normalized event, decide one of four explicit
 * statuses:
 *
 *   matched_existing  the venue is already in our `venues` data
 *   safe_new_venue    no match, and the source gives enough trustworthy
 *                     information to create the venue in a later write phase
 *   needs_review      no match, but a human is needed before creation
 *                     (ambiguous match, unenabled city, weak location, …)
 *   rejected          an obvious placeholder / non-venue / online event
 *
 * It NEVER writes. Matching reuses `../matching.ts#resolveMatch` (tiers 0-4)
 * UNCHANGED — no parallel matcher, no coordinate-only merging, no title-based
 * merging; ambiguous matches stay `needs_review`.
 *
 * Location enrichment (address / coordinates from the source's own venue page)
 * is best-effort via the adapter's optional `fetchSourceVenue` — failure just
 * lowers the location confidence, it is never fatal.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { findAlias } from "../aliases.ts";
import { resolveMatch } from "../matching.ts";
import { computeNameNormalized } from "../name.ts";
import type { ExistingVenue, NormalizedVenue } from "../types.ts";
import type { NormalizedEvent, SourceVenue } from "./types.ts";

const VENUE_COLUMNS =
  "id, name, name_normalized, source_id, external_id, source_url, latitude, longitude, coordinates_source, address, website, opening_hours, wikidata, city_id";

/** Source city text -> our `cities.name` (English exonyms for the big cities). */
const CITY_ALIASES: Record<string, string> = {
  beograd: "Belgrade",
  belgrade: "Belgrade",
  "novi sad": "Novi Sad",
  nis: "Niš",
  "nis srbija": "Niš",
};

/** Deterministic placeholder / non-venue name patterns (EN + SR). */
const PLACEHOLDER_PATTERNS: { code: string; re: RegExp }[] = [
  { code: "placeholder-unknown", re: /^(unknown|nepoznat[oa]?|nepoznata lokacija)$/i },
  { code: "placeholder-na", re: /^(n\/?a|-+|\.+|\?+|tbd|tba|tbc)$/i },
  {
    code: "placeholder-to-be-announced",
    re: /^(to be (announced|confirmed|determined)|location (tba|tbd|tbc|to be announced)|lokacija[ -].*(uskoro|naknadno|tba)|uskoro)$/i,
  },
  {
    code: "placeholder-various-locations",
    re: /^(various( locations?)?|multiple locations?|razne? lokacij\w*|vi[šs]e lokacija|na vi[šs]e lokacija)$/i,
  },
  {
    code: "online-event",
    re: /^(online( event)?|onlajn\w*|virtu(al|eln\w*)|live ?stream\w*|stream(ing)?|zoom|youtube|twitch)$/i,
  },
];

/** Single-token generic names that are almost never a real venue on their own. */
const GENERIC_NAME_TOKENS = new Set([
  "bar", "klub", "club", "kafe", "kafic", "cafe", "pab", "pub",
  "splav", "sala", "bina", "stage", "dvorana",
]);

/** Rough Serbia bounding box — only a soft flag, never a hard reject. */
function inSerbiaBox(lat: number, lon: number): boolean {
  return lat >= 42.0 && lat <= 46.3 && lon >= 18.7 && lon <= 23.1;
}

export type EventVenueStatus =
  | "matched_existing"
  | "safe_new_venue"
  | "needs_review"
  | "rejected";

export type LocationConfidence = "coordinates" | "address" | "city-only" | "none";

export interface EventVenueResolution {
  status: EventVenueStatus;
  reasonCode: string;
  reason: string;
  reasonCodes: string[];

  // proposed venue shape (enough for a later write phase)
  proposedName: string;
  normalizedName: string;
  city: string | null;
  cityKnown: boolean;
  cityEnabled: boolean;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatesSource: "source" | null;
  sourceVenueId: string | null;
  locationConfidence: LocationConfidence;

  // existing-match info
  matchedVenueId: string | null;
  matchTier: number | null;
  matchNote: string | null;

  eventRelevanceTier: "primary" | "secondary" | null;

  provenance: {
    dataSource: string;
    externalVenueId: string | null;
    sourceUrl: string;
    venuePageUrl: string | null;
  };

  candidateKey: string;
  event: { title: string; url: string };
}

export interface VenueResolver {
  readonly knownCities: string[];
  readonly enabledCities: string[];
  resolve(
    event: NormalizedEvent,
    relevanceTier: "primary" | "secondary",
  ): Promise<EventVenueResolution>;
}

export interface VenueResolverOptions {
  countryIds: string[];
  sourceKey: string;
  sourceTrusted: boolean;
  enabledCities: string[];
  fetchSourceVenue?: (sourceVenueId: string) => Promise<SourceVenue | null>;
}

interface CityRow {
  id: string;
  name: string;
}

function normalizeAddress(value: string): string {
  return computeNameNormalized(value.replace(/\d+/g, " ")).trim();
}

function placeholderCode(name: string): string | null {
  const trimmed = name.trim();
  for (const { code, re } of PLACEHOLDER_PATTERNS) {
    if (re.test(trimmed)) return code;
  }
  if (/\b(online|livestream|live stream|webinar)\b/i.test(trimmed)) return "online-event";
  return null;
}

function isGenericName(normalizedName: string): boolean {
  const tokens = normalizedName.split(" ").filter(Boolean);
  return tokens.length === 1 && GENERIC_NAME_TOKENS.has(tokens[0]);
}

function toIncomingVenue(
  event: NormalizedEvent,
  name: string,
  normalizedName: string,
  latitude: number,
  longitude: number,
): NormalizedVenue {
  return {
    // Write-phase-aligned: a created source venue would carry external_id = slug.
    externalId: event.venue.sourceVenueId ?? `name:${normalizedName}`,
    osmType: "node",
    osmId: 0,
    sourceUrl: event.sourceUrl,
    name,
    nameNormalized: normalizedName,
    latitude,
    longitude,
    address: event.venue.address ?? null,
    website: null,
    openingHours: null,
    wikidata: null,
  };
}

function shareToken(a: string, b: string): boolean {
  const bt = new Set(b.split(" ").filter((t) => t.length > 1));
  return a.split(" ").some((t) => t.length > 1 && bt.has(t));
}

export async function createVenueResolver(
  supabase: SupabaseClient,
  options: VenueResolverOptions,
): Promise<VenueResolver> {
  const citiesResult = await supabase
    .from("cities")
    .select("id, name, country_id")
    .in("country_id", options.countryIds);
  if (citiesResult.error) {
    throw new Error(`Could not read cities: ${citiesResult.error.message}`);
  }
  const cities: CityRow[] = (citiesResult.data ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
  }));

  const venuesResult = await supabase
    .from("venues")
    .select(VENUE_COLUMNS)
    .in("city_id", cities.map((c) => c.id));
  if (venuesResult.error) {
    throw new Error(`Could not read venues: ${venuesResult.error.message}`);
  }

  const venuesByCity = new Map<string, ExistingVenue[]>();
  for (const row of venuesResult.data ?? []) {
    const cityId = (row as { city_id: string }).city_id;
    const list = venuesByCity.get(cityId) ?? [];
    list.push(row as unknown as ExistingVenue);
    venuesByCity.set(cityId, list);
  }

  const enabledCities = options.enabledCities;
  const enrichmentCache = new Map<string, SourceVenue | null>();

  function matchCityText(text: string | null | undefined): CityRow | null {
    if (!text) return null;
    const norm = computeNameNormalized(text.replace(/-/g, " "));
    const aliased = CITY_ALIASES[norm];
    const targetNorm = aliased ? computeNameNormalized(aliased) : norm;
    return (
      cities.find(
        (c) =>
          c.name === (aliased ?? text) ||
          computeNameNormalized(c.name) === targetNorm,
      ) ?? null
    );
  }

  function deriveCity(event: NormalizedEvent): CityRow | null {
    const slug = (event.reported as { citySlug?: unknown }).citySlug;
    return (
      matchCityText(event.venue.city) ??
      (typeof slug === "string" ? matchCityText(slug) : null)
    );
  }

  async function enrich(sourceVenueId: string | null): Promise<SourceVenue | null> {
    if (!sourceVenueId || !options.fetchSourceVenue) return null;
    if (enrichmentCache.has(sourceVenueId)) return enrichmentCache.get(sourceVenueId) ?? null;
    let result: SourceVenue | null = null;
    try {
      result = await options.fetchSourceVenue(sourceVenueId);
    } catch {
      result = null;
    }
    enrichmentCache.set(sourceVenueId, result);
    return result;
  }

  function candidateKey(
    normalizedName: string,
    cityName: string | null,
    sourceVenueId: string | null,
    address: string | null,
    generic: boolean,
  ): string {
    if (sourceVenueId) return `svid:${options.sourceKey}:${sourceVenueId}`;
    const cityPart = cityName ?? "?";
    if (generic && address && normalizedName) {
      return `nca:${cityPart}:${normalizedName}:${normalizeAddress(address)}`;
    }
    if (normalizedName) return `nc:${cityPart}:${normalizedName}`;
    return `url:${cityPart}`;
  }

  async function resolve(
    event: NormalizedEvent,
    relevanceTier: "primary" | "secondary",
  ): Promise<EventVenueResolution> {
    const name = event.venue.name.trim();
    const normalizedName = computeNameNormalized(name);
    const sourceVenueId = event.venue.sourceVenueId ?? null;
    const cityRow = deriveCity(event);
    const generic = isGenericName(normalizedName);

    const citySlug = (event.reported as { citySlug?: unknown }).citySlug;
    // The city component of a candidate's identity: the resolved canonical city
    // name, else the NORMALIZED raw city text — so two un-enriched "Klub X" in
    // two DIFFERENT unknown cities are not collapsed into one `nc:?:klub x`
    // candidate by event-first aggregation.
    const rawCityText =
      event.venue.city?.trim() || (typeof citySlug === "string" ? citySlug.trim() : "") || "";
    const cityKeyName =
      cityRow?.name ?? (rawCityText ? computeNameNormalized(rawCityText) : null);

    // A single builder so every branch returns the same shape.
    const make = (
      partial: Partial<EventVenueResolution> &
        Pick<EventVenueResolution, "status" | "reasonCode" | "reason" | "reasonCodes">,
    ): EventVenueResolution => ({
      proposedName: name,
      normalizedName,
      city: cityRow?.name ?? null,
      cityKnown: cityRow != null,
      cityEnabled: cityRow != null && enabledCities.includes(cityRow.name),
      address: event.venue.address ?? null,
      latitude: null,
      longitude: null,
      coordinatesSource: null,
      sourceVenueId,
      locationConfidence: event.venue.address ? "address" : "city-only",
      matchedVenueId: null,
      matchTier: null,
      matchNote: null,
      eventRelevanceTier: relevanceTier,
      provenance: {
        dataSource: options.sourceKey,
        externalVenueId: sourceVenueId,
        sourceUrl: event.sourceUrl,
        venuePageUrl: null,
      },
      candidateKey: candidateKey(
        normalizedName,
        cityKeyName,
        sourceVenueId,
        event.venue.address ?? null,
        generic,
      ),
      event: { title: event.title, url: event.sourceUrl },
      ...partial,
    });

    // 0. placeholder / non-venue / online
    const ph = placeholderCode(name);
    if (ph) {
      return make({
        status: "rejected",
        reasonCode: ph,
        reason: `venue name "${name}" is a placeholder / non-venue`,
        reasonCodes: [ph],
        locationConfidence: "none",
      });
    }
    if (!normalizedName) {
      return make({
        status: "rejected",
        reasonCode: "empty-normalized-name",
        reason: "venue name normalizes to nothing",
        reasonCodes: ["empty-normalized-name"],
        locationConfidence: "none",
      });
    }
    if (name.length < 2) {
      return make({
        status: "rejected",
        reasonCode: "name-too-short",
        reason: `venue name "${name}" is too short`,
        reasonCodes: ["name-too-short"],
        locationConfidence: "none",
      });
    }

    // 1. city
    if (!event.venue.city && typeof citySlug !== "string") {
      return make({
        status: "rejected",
        reasonCode: "city-missing",
        reason: "no city information in the event source",
        reasonCodes: ["city-missing"],
        locationConfidence: "none",
      });
    }
    if (!cityRow) {
      return make({
        status: "needs_review",
        reasonCode: "city-unknown",
        reason: `city "${event.venue.city ?? citySlug}" is not in the venue database`,
        reasonCodes: ["city-unknown"],
      });
    }

    // 2. existing match (per-city; matcher + aliases reused UNCHANGED)
    const existing = venuesByCity.get(cityRow.id) ?? [];
    const matchCtx = {
      target: {
        countryId: options.countryIds[0] ?? "RS",
        cityName: cityRow.name,
        osmRelationId: 0,
      },
      osmSourceId: `${options.sourceKey}-dry-run`,
      existing,
      consumed: new Set<string>(),
    };

    // Pass 1 — id / identifier / exact-name (Tiers 0-2; no coordinates needed).
    let outcome = resolveMatch(
      toIncomingVenue(event, name, normalizedName, Number.NaN, Number.NaN),
      matchCtx,
    );

    // Enrich when Pass 1 did not cleanly match — we need the source's own venue
    // record for the location AND, when a curated alias applies, for Tier 3's
    // proximity guard (which needs real coordinates).
    let enriched: SourceVenue | null = null;
    if (outcome.kind !== "match") {
      enriched = await enrich(sourceVenueId);
    }

    if (outcome.kind === "new" && enriched) {
      const enrName = (enriched.name ?? "").trim() || name;
      const enrNorm = computeNameNormalized(enrName);
      const enrLat = enriched.latitude ?? Number.NaN;
      const enrLon = enriched.longitude ?? Number.NaN;
      const aliasApplies =
        findAlias(matchCtx.target.countryId, cityRow.name, normalizedName) != null ||
        findAlias(matchCtx.target.countryId, cityRow.name, enrNorm) != null;
      // Trust the source venue page for a re-match when its name shares a token
      // with the event's venue name, OR a curated alias links them.
      const trust = shareToken(normalizedName, enrNorm) || aliasApplies;
      if (trust && (enrNorm !== normalizedName || enriched.latitude != null || aliasApplies)) {
        // Pass 2 — re-match with the source venue page's confirmed name +
        // coordinates. Same matcher, same tiers.
        const pass2 = resolveMatch(
          toIncomingVenue(event, enrName, enrNorm, enrLat, enrLon),
          { ...matchCtx, consumed: new Set<string>() },
        );
        if (pass2.kind === "match") outcome = pass2;
      }
    }

    if (outcome.kind === "match") {
      return make({
        status: "matched_existing",
        reasonCode: `matched-tier-${outcome.tier}`,
        reason: `matched existing venue "${outcome.venue.name}" (tier ${outcome.tier})`,
        reasonCodes: [`matched-tier-${outcome.tier}`],
        address: outcome.venue.address ?? event.venue.address ?? null,
        latitude: outcome.venue.latitude ?? null,
        longitude: outcome.venue.longitude ?? null,
        coordinatesSource:
          (outcome.venue.coordinates_source as "source" | null) ?? null,
        locationConfidence: outcome.venue.latitude != null ? "coordinates" : "city-only",
        matchedVenueId: outcome.venue.id,
        matchTier: outcome.tier,
        matchNote: outcome.note ?? null,
        candidateKey: `venue:${outcome.venue.id}`,
      });
    }
    if (outcome.kind === "skip") {
      return make({
        status: "needs_review",
        reasonCode: "ambiguous-existing-match",
        reason: outcome.note,
        reasonCodes: ["ambiguous-existing-match"],
        matchNote: outcome.note,
      });
    }

    // 3. event-first candidate — gather every signal, then decide.
    const codes: string[] = [];
    if (outcome.review) codes.push("matcher-flagged-review");
    if (!options.sourceTrusted) codes.push("source-not-trusted");
    if (!enabledCities.includes(cityRow.name)) codes.push("city-not-enabled");
    if (relevanceTier !== "primary") codes.push("secondary-relevance-only");
    if (generic) codes.push("generic-venue-name");

    // 4. location — from the source's own venue page (fetched above), best-effort
    const address = enriched?.address ?? event.venue.address ?? null;
    const latitude = enriched?.latitude ?? event.venue.lat ?? null;
    const longitude = enriched?.longitude ?? event.venue.lon ?? null;
    const coordinatesSource: "source" | null =
      latitude != null && longitude != null ? "source" : null;
    const locationConfidence: LocationConfidence =
      latitude != null && longitude != null
        ? "coordinates"
        : address
          ? "address"
          : "city-only";

    if (latitude != null && longitude != null && !inSerbiaBox(latitude, longitude)) {
      codes.push("coordinates-out-of-region");
    }
    if (enriched?.city) {
      // The venue page names a city. If it does not resolve to the SAME city the
      // event resolved to — a *different* known city, OR a city we have no row
      // for at all — the page and the event disagree about where this venue is:
      // never silently `safe_new_venue`.
      const enrichedCity = matchCityText(enriched.city);
      if (!enrichedCity || enrichedCity.id !== cityRow.id) {
        codes.push("venue-page-city-mismatch");
      }
    }
    if (locationConfidence === "city-only") {
      codes.push("location-confidence-insufficient");
    }

    const safe = codes.length === 0;
    return make({
      status: safe ? "safe_new_venue" : "needs_review",
      reasonCode: safe ? "safe-new-venue" : codes[0],
      reason: safe
        ? `no existing match; trusted source, city "${cityRow.name}" enabled, ${locationConfidence} available`
        : `event-first candidate needs review: ${codes.join(", ")}`,
      reasonCodes: safe ? ["safe-new-venue"] : codes,
      address,
      latitude,
      longitude,
      coordinatesSource,
      locationConfidence,
      matchNote: outcome.note ?? null,
      provenance: {
        dataSource: options.sourceKey,
        externalVenueId: enriched?.externalId ?? sourceVenueId,
        sourceUrl: event.sourceUrl,
        venuePageUrl: enriched?.sourceUrl ?? null,
      },
      candidateKey: candidateKey(normalizedName, cityKeyName, sourceVenueId, address, generic),
    });
  }

  return {
    knownCities: cities
      .filter((c) => (venuesByCity.get(c.id)?.length ?? 0) > 0)
      .map((c) => c.name)
      .sort(),
    enabledCities: [...enabledCities].sort(),
    resolve,
  };
}
