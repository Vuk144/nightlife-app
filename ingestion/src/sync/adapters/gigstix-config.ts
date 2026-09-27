/**
 * Sync-engine configuration for GIGS TIX events: which canonical cities GIGS
 * city text resolves to. City identity only — no venues.
 *
 * Built from the shared city alias table (`../../city-aliases.ts`), so GIGS
 * "Beograd" resolves to our `Belgrade` through the engine's existing,
 * data-driven `ConfigProvider.resolveCity` (`CityConfig.nameAliases` folded
 * by `cityKey`). The cities are exactly that table's targets. Anything else
 * resolves to `null` — never guessed.
 */

import { CITY_ALIASES } from "../../city-aliases.ts";
import { DEFAULT_COUNTRIES, DEFAULT_TIME_ZONE } from "../../events/config.ts";
import { DEFAULT_RECONCILIATION, InMemoryConfigProvider } from "../config.ts";
import type { CityConfig, SourceConfig, SyncConfig } from "../config.ts";
import { GIGSTIX_SOURCE_KEY } from "./gigstix-event.ts";

const COUNTRY = DEFAULT_COUNTRIES[0]; // "RS" — GIGS TIX is a Serbian platform

/** Canonical city → its GIGS city-text aliases, from the shared table (deterministic order). */
function aliasesByCity(): Map<string, string[]> {
  const byCity = new Map<string, string[]>();
  for (const [alias, cityName] of Object.entries(CITY_ALIASES)) {
    byCity.set(cityName, [...(byCity.get(cityName) ?? []), alias]);
  }
  return byCity;
}

export function buildGigstixSyncConfig(): SyncConfig {
  const cities: CityConfig[] = [...aliasesByCity()].map(([canonicalName, nameAliases]) => ({
    countryCode: COUNTRY,
    canonicalName,
    enabled: true,
    // no event-first venue creation from GIGS
    eventFirstEnabled: false,
    timeZone: DEFAULT_TIME_ZONE,
    nameAliases,
    bounds: null,
    sourceScope: {},
  }));
  const source: SourceConfig = {
    key: GIGSTIX_SOURCE_KEY,
    adapter: "gigstix",
    kinds: ["event"],
    enabled: true,
    trusted: true,
    tos: "permitted",
    scope: { countries: [COUNTRY], cities: cities.map((c) => c.canonicalName) },
    schedule: null,
    rateLimit: null,
    fieldTrust: {},
    settings: {},
  };
  return {
    countries: [
      {
        code: COUNTRY,
        name: "Serbia",
        enabled: true,
        defaultTimeZone: DEFAULT_TIME_ZONE,
        bounds: null,
        normalizationProfile: "sr",
        extraPlaceholderPatterns: [],
      },
    ],
    cities,
    sources: [source],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  };
}

/** `buildGigstixSyncConfig` behind the validating `InMemoryConfigProvider`. */
export function createGigstixConfigProvider(): InMemoryConfigProvider {
  return new InMemoryConfigProvider(buildGigstixSyncConfig());
}

/**
 * GIGS city text → our canonical `{ countryCode, cityName }`, or `null` when
 * it is not a configured city. Pure and deterministic. The country is always
 * RS — GIGS city text is never resolved into another country.
 */
export function resolveGigstixCity(
  cityText: string | null | undefined,
  provider: InMemoryConfigProvider = createGigstixConfigProvider(),
): { countryCode: string; cityName: string } | null {
  const resolution = provider.resolveCity(COUNTRY, cityText ?? null);
  return resolution ? { countryCode: resolution.city.countryCode, cityName: resolution.city.canonicalName } : null;
}
