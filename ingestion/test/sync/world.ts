/**
 * Shared multi-country fixture world for the sync-engine tests.
 *
 * Everything here is DATA. There is no city-specific or country-specific code.
 * Adding "Croatia / Zagreb" was adding rows to `CITIES` and `COUNTRIES`.
 */

import {
  DEFAULT_RECONCILIATION,
  InMemoryConfigProvider,
  type SyncConfig,
} from "../../src/sync/config.ts";
import {
  InMemoryCanonicalStore,
  type CanonicalVenue,
  type CityRecord,
  type SourceLink,
} from "../../src/sync/store.ts";
import type {
  EventFields,
  GeoPoint,
  NormalizedRecord,
  VenueFields,
} from "../../src/sync/types.ts";
import type { FakeItem, FakeVenuePage } from "../../src/sync/adapters/in-memory.ts";

const SERBIA_BOUNDS = { minLat: 42, maxLat: 46.3, minLon: 18.7, maxLon: 23.1 };
const CROATIA_BOUNDS = { minLat: 42.3, maxLat: 46.6, minLon: 13.4, maxLon: 19.5 };

export const CONFIG: SyncConfig = {
  countries: [
    {
      code: "RS",
      name: "Serbia",
      enabled: true,
      defaultTimeZone: "Europe/Belgrade",
      bounds: SERBIA_BOUNDS,
      normalizationProfile: "sr",
      extraPlaceholderPatterns: ["^(nepoznat|uskoro|vi[sš]e lokacija)"],
    },
    {
      code: "HR",
      name: "Croatia",
      enabled: true,
      defaultTimeZone: "Europe/Zagreb",
      bounds: CROATIA_BOUNDS,
      normalizationProfile: "latin",
      extraPlaceholderPatterns: ["^(nepoznato|uskoro|vi[sš]e lokacija)"],
    },
    {
      code: "HU",
      name: "Hungary",
      enabled: true,
      defaultTimeZone: "Europe/Budapest",
      bounds: null,
      normalizationProfile: "latin",
      extraPlaceholderPatterns: [],
    },
    {
      code: "DE",
      name: "Germany",
      enabled: true,
      defaultTimeZone: "Europe/Berlin",
      bounds: null,
      normalizationProfile: "latin",
      extraPlaceholderPatterns: [],
    },
  ],
  cities: [
    city("RS", "Belgrade", ["beograd", "belgrade"], "Europe/Belgrade", true),
    city("RS", "Novi Sad", ["novi sad"], "Europe/Belgrade", false),
    city("RS", "Niš", ["nis", "nis srbija"], "Europe/Belgrade", false),
    city("HR", "Zagreb", ["zagreb"], "Europe/Zagreb", true),
    city("HR", "Split", ["split"], "Europe/Zagreb", false),
    city("HU", "Budapest", ["budapest", "budimpesta"], "Europe/Budapest", false),
    city("DE", "Berlin", ["berlin"], "Europe/Berlin", false),
  ],
  sources: [
    source("gigstix", ["event"], { countries: ["RS"], cities: [] }, true),
    source("entrio-hr", ["event"], { countries: ["HR"], cities: [] }, true),
    source("cooltix", ["event"], { countries: ["RS", "HR"], cities: [] }, true),
    source("osm", ["venue"], { countries: [], cities: [] }, false),
  ],
  // Mirrors ../../src/aliases.ts#VENUE_ALIASES — curated data, per country+city.
  venueAliases: [
    { countryCode: "RS", cityName: "Belgrade", aliasNormalized: "dragstor", canonicalName: "Drugstore", note: null },
    { countryCode: "RS", cityName: "Belgrade", aliasNormalized: "studenata tehnike", canonicalName: "KST", note: null },
  ],
  reconciliation: DEFAULT_RECONCILIATION,
};

function city(
  countryCode: string,
  canonicalName: string,
  nameAliases: string[],
  timeZone: string,
  eventFirstEnabled: boolean,
) {
  return {
    countryCode,
    canonicalName,
    enabled: true,
    eventFirstEnabled,
    timeZone,
    nameAliases,
    bounds: null,
    sourceScope: {},
  };
}

function source(
  key: string,
  kinds: ("venue" | "event")[],
  scope: { countries: string[]; cities: string[] },
  trusted: boolean,
) {
  return {
    key,
    adapter: `${key}-adapter`,
    kinds,
    enabled: true,
    trusted,
    tos: "permitted" as const,
    scope,
    schedule: null,
    rateLimit: null,
    fieldTrust: {},
    settings: {},
  };
}

export function provider(): InMemoryConfigProvider {
  return new InMemoryConfigProvider(CONFIG);
}

// ── canonical store seed ─────────────────────────────────────────────
export const CITY_IDS = {
  Belgrade: "city-bg",
  Zagreb: "city-zg",
  Split: "city-sp",
  Budapest: "city-bp",
  Berlin: "city-be",
} as const;

function cityRecord(name: keyof typeof CITY_IDS, countryCode: string, tz: string): CityRecord {
  return { id: CITY_IDS[name], countryCode, name, timeZone: tz };
}

export function seededStore(): InMemoryCanonicalStore {
  return new InMemoryCanonicalStore({
    cities: [
      cityRecord("Belgrade", "RS", "Europe/Belgrade"),
      cityRecord("Zagreb", "HR", "Europe/Zagreb"),
      cityRecord("Split", "HR", "Europe/Zagreb"),
      cityRecord("Budapest", "HU", "Europe/Budapest"),
      cityRecord("Berlin", "DE", "Europe/Berlin"),
    ],
    venues: [
      canonicalVenue("v-bg-tvornica", "city-bg", "Belgrade", "RS", "Tvornica", "tvornica", null),
      canonicalVenue("v-zg-tvornica", "city-zg", "Zagreb", "HR", "Tvornica", "tvornica", {
        latitude: 45.8071,
        longitude: 15.9663,
      }),
      canonicalVenue("v-zg-mocvara", "city-zg", "Zagreb", "HR", "Klub Močvara", "klub mocvara", {
        latitude: 45.8009,
        longitude: 15.9506,
      }),
    ],
  });
}

function canonicalVenue(
  id: string,
  cityId: string,
  cityName: string,
  countryCode: string,
  name: string,
  normalizedName: string,
  coordinates: GeoPoint | null,
): CanonicalVenue {
  return {
    id,
    cityId,
    cityName,
    countryCode,
    name,
    normalizedName,
    address: null,
    coordinates,
    coordinatesSource: coordinates ? "source" : null,
    website: null,
    wikidata: null,
    openingHours: null,
    description: null,
    openingTime: null,
    closingTime: null,
    isActive: true,
    sourceKey: null,
    externalId: null,
    sourceUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

// ── record builders (what an adapter's parse() would return) ─────────
export function venueRecord(input: {
  sourceKey: string;
  externalId: string;
  countryCode: string;
  cityText: string;
  name: string;
  coordinates?: GeoPoint | null;
  address?: string | null;
  website?: string | null;
  description?: string | null;
  openingTime?: string | null;
  closingTime?: string | null;
  isActive?: boolean;
  contentHash?: string;
}): NormalizedRecord {
  const fields: VenueFields = {
    name: input.name,
    normalizedName: "",
    address: input.address ?? null,
    coordinates: input.coordinates ?? null,
    coordinatesSource: input.coordinates ? "source" : null,
    website: input.website ?? null,
    wikidata: null,
    openingHours: null,
    description: input.description ?? null,
    openingTime: input.openingTime ?? null,
    closingTime: input.closingTime ?? null,
    isActive: input.isActive ?? true,
  };
  return {
    kind: "venue",
    provenance: prov(input.sourceKey, input.externalId, input.contentHash),
    scope: { countryCode: input.countryCode, cityText: input.cityText, coordinates: input.coordinates ?? null },
    fields,
    links: {},
  };
}

export function eventRecord(input: {
  sourceKey: string;
  externalId: string;
  countryCode: string;
  cityText: string;
  title: string;
  startLocal: string;
  ticketUrl?: string | null;
  venueName: string;
  sourceVenueId?: string | null;
  status?: EventFields["status"];
  /** Source-provided zone. Null (default) => the engine resolves it from config. */
  timeZone?: string | null;
  coverImageUrl?: string | null;
  contentHash?: string;
}): NormalizedRecord {
  const fields: EventFields = {
    title: input.title,
    description: null,
    startLocal: input.startLocal,
    endLocal: null,
    doorsLocal: null,
    timeZone: input.timeZone ?? null,
    startPrecision: input.startLocal.length > 10 ? "datetime" : "date",
    status: input.status ?? "scheduled",
    promoter: null,
    ticketUrl: input.ticketUrl ?? null,
    coverImageUrl: input.coverImageUrl ?? null,
    lineup: [],
  };
  return {
    kind: "event",
    provenance: prov(input.sourceKey, input.externalId, input.contentHash),
    scope: { countryCode: input.countryCode, cityText: input.cityText, coordinates: null },
    fields,
    links: {
      venue: {
        name: input.venueName,
        sourceVenueId: input.sourceVenueId ?? null,
        address: null,
        coordinates: null,
        cityText: input.cityText,
      },
    },
  };
}

function prov(sourceKey: string, externalId: string, contentHash?: string) {
  return {
    sourceKey,
    externalId,
    sourceUrl: `memory://${sourceKey}/${externalId}`,
    // Adapters do NOT provide a change-detection hash; this optional field is
    // only threaded through for the few tests that assert it is ignored.
    ...(contentHash === undefined ? {} : { contentHash }),
    confidence: 0.9,
    fetchedAt: "2026-06-01T00:00:00.000Z",
    reported: {},
  };
}

export function fakeItem(record: NormalizedRecord, lastModified?: string): FakeItem {
  return {
    externalId: record.provenance.externalId,
    kind: record.kind,
    payload: record,
    lastModified,
  };
}

export function venuePage(externalId: string, record: NormalizedRecord): FakeVenuePage {
  return { externalId, record };
}

export function activeEventLink(over: Partial<SourceLink>): SourceLink {
  return {
    id: "seed-link",
    kind: "event",
    sourceKey: "entrio-hr",
    externalId: "E1",
    sourceUrl: null,
    canonicalId: "ev-seed",
    contentHash: "seed-hash",
    comparableFields: {},
    reported: {},
    firstSeenAt: "2026-05-01T00:00:00.000Z",
    lastSeenAt: "2026-05-20T00:00:00.000Z",
    lastSyncedAt: "2026-05-20T00:00:00.000Z",
    sourceStatus: "active",
    consecutiveMisses: 0,
    ...over,
  };
}
