/**
 * Data-driven synchronization configuration.
 *
 * Countries, cities, sources, aliases, scope, trust and scheduling are DATA —
 * never branches. Adding "Croatia / Zagreb" is a few rows here (or, in
 * production, a few DB rows), not a code change.
 *
 * The engine reads config only through `ConfigProvider`. `InMemoryConfigProvider`
 * is the reference implementation, used by tests and, initially, by a small
 * checked-in seed. The production provider (a LATER task) will assemble the
 * same `SyncConfig` from the `countries` / `cities` / `data_sources` tables
 * plus a small `venue_aliases` table.
 */

import type { EntityKind, GeoBounds, JsonValue, ReconciliationThresholds } from "./types.ts";

export interface CountryConfig {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  enabled: boolean;
  defaultTimeZone: string;
  bounds: GeoBounds | null;
  /** Key of the name-normalization profile (see `./normalization.ts`). */
  normalizationProfile: string;
  /** Extra placeholder / non-venue name regex sources for this locale. */
  extraPlaceholderPatterns: string[];
}

export interface CityConfig {
  countryCode: string;
  /** Must equal `cities.name` in the store. */
  canonicalName: string;
  enabled: boolean;
  /** Whether an event-first venue here may become a safe creation candidate. */
  eventFirstEnabled: boolean;
  timeZone: string;
  /**
   * Lower-cased exonyms / transliterations / common source spellings that all
   * resolve to `canonicalName` (e.g. "beograd" → "Belgrade"). Data, not code.
   */
  nameAliases: string[];
  bounds: GeoBounds | null;
  /** Per-source discovery scope, e.g. `{ osm: { relationId: 2728438 } }`. */
  sourceScope: Record<string, JsonValue>;
}

export interface SourceConfig {
  key: string;
  /** Which adapter module services this source. */
  adapter: string;
  kinds: EntityKind[];
  enabled: boolean;
  /** Trusted to seed venues and to act on reported cancellations. */
  trusted: boolean;
  tos: "permitted" | "needs_review" | "prohibited";
  scope: { countries: string[]; cities: string[] };
  /** Cron hint. Config only — the scheduler is a later task. */
  schedule: string | null;
  rateLimit: { requestsPerMinute: number; politenessMs: number } | null;
  /** Per canonical field: authority weight when sources disagree (higher wins). */
  fieldTrust: Record<string, number>;
  /** Free-form source-specific settings passed to the adapter. */
  settings: Record<string, JsonValue>;
}

export interface VenueAliasConfig {
  countryCode: string;
  cityName: string;
  /** Incoming normalized name that should resolve to `canonicalName`. */
  aliasNormalized: string;
  canonicalName: string;
  note: string | null;
}

export interface SyncConfig {
  countries: CountryConfig[];
  cities: CityConfig[];
  sources: SourceConfig[];
  venueAliases: VenueAliasConfig[];
  reconciliation: ReconciliationThresholds;
}

export interface CityResolution {
  city: CityConfig;
  via: "canonical-name" | "alias";
}

export interface ConfigProvider {
  load(): SyncConfig;
  country(code: string | null): CountryConfig | null;
  source(key: string): SourceConfig | null;
  /**
   * Data-driven city resolution: (country, free text) → canonical city. The
   * function body contains NO city or country names — every match comes from
   * `cities[].canonicalName` / `cities[].nameAliases`.
   */
  resolveCity(countryCode: string | null, cityText: string | null): CityResolution | null;
  citiesInScope(source: SourceConfig): CityConfig[];
  sourcesForKind(kind: EntityKind): SourceConfig[];
  aliasesForCity(countryCode: string, cityName: string): VenueAliasConfig[];
}

/** Fold to a lower-case, de-accented, whitespace-collapsed key for matching. */
export function cityKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/đ/g, "dj")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const DEFAULT_RECONCILIATION: ReconciliationThresholds = {
  staleAfterMisses: 1,
  missingAfterMisses: 2,
  goneAfterMisses: 3,
  minDiscoveryRatio: 0.4,
  maxParseFailureRatio: 0.3,
};

/**
 * The reconciliation lifecycle (`./reconcile.ts`) only makes sense if a record
 * reaches `stale` before `missing` before `gone`. `reconcile.ts` tests the
 * thresholds most-severe-first (`>= goneAfterMisses` … `>= staleAfterMisses`),
 * so anything but a strictly ascending sequence of positive integers silently
 * skips or reorders lifecycle stages.
 *
 * This is the generic config-validation layer: bad thresholds are REJECTED here
 * (loudly, at config load) — never normalized, and never guarded around inside
 * `reconcile.ts`.
 */
export function assertValidReconciliationThresholds(t: ReconciliationThresholds): void {
  for (const name of ["staleAfterMisses", "missingAfterMisses", "goneAfterMisses"] as const) {
    const v = t[name];
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`reconciliation.${name} must be an integer ≥ 1, got ${JSON.stringify(v)}`);
    }
  }
  if (
    !(t.staleAfterMisses < t.missingAfterMisses) ||
    !(t.missingAfterMisses < t.goneAfterMisses)
  ) {
    throw new Error(
      "reconciliation thresholds must be strictly ascending: staleAfterMisses " +
        `(${t.staleAfterMisses}) < missingAfterMisses (${t.missingAfterMisses}) < ` +
        `goneAfterMisses (${t.goneAfterMisses})`,
    );
  }
}

/**
 * `CountryConfig.extraPlaceholderPatterns` are regex SOURCE strings that
 * `validation.ts#validateRecord` compiles (`new RegExp(src, "i")`) for every
 * record it checks. An uncompilable pattern would throw mid-run, deep inside
 * record processing.
 *
 * Same policy as {@link assertValidReconciliationThresholds}: this is the
 * generic config-validation layer — a bad pattern is REJECTED here, loudly, at
 * config load. It is never normalized away and never swallowed inside
 * `validateRecord`.
 */
export function assertValidPlaceholderPatterns(countries: CountryConfig[]): void {
  for (const country of countries) {
    country.extraPlaceholderPatterns.forEach((src, i) => {
      try {
        // Same flags `validateRecord` uses — a pattern can be valid unflagged
        // yet still need to compile with "i".
        new RegExp(src, "i");
      } catch (err) {
        throw new Error(
          `country "${country.code}": extraPlaceholderPatterns[${i}] is not a valid regex ` +
            `(${JSON.stringify(src)}): ${(err as Error).message}`,
        );
      }
    });
  }
}

export class InMemoryConfigProvider implements ConfigProvider {
  private readonly config: SyncConfig;
  /** `"CC|normalized"` → the city in that country. Country is authoritative. */
  private readonly cityIndex: Map<string, CityResolution>;
  /**
   * `"normalized"` → every DISTINCT city whose canonical name or alias folds to
   * that key, across all countries. Used only for country-less input, which
   * resolves solely when the list holds exactly one city (see `resolveCity`).
   */
  private readonly countrylessCityIndex: Map<string, CityResolution[]>;

  constructor(config: SyncConfig) {
    assertValidReconciliationThresholds(config.reconciliation);
    assertValidPlaceholderPatterns(config.countries);
    this.config = config;
    this.cityIndex = new Map();
    this.countrylessCityIndex = new Map();
    for (const city of config.cities) {
      this.indexCity(city, cityKey(city.canonicalName), "canonical-name");
      for (const alias of city.nameAliases) {
        this.indexCity(city, cityKey(alias), "alias");
      }
    }
  }

  private indexCity(city: CityConfig, key: string, via: CityResolution["via"]): void {
    if (!key) return;
    const res: CityResolution = { city, via };
    this.cityIndex.set(`${city.countryCode.toUpperCase()}|${key}`, res);
    // Track ALL distinct cities for this key — never overwrite. A key shared by
    // two countries' cities must stay ambiguous, not collapse to "last wins".
    const bucket = this.countrylessCityIndex.get(key);
    if (!bucket) {
      this.countrylessCityIndex.set(key, [res]);
    } else if (!bucket.some((r) => r.city === city)) {
      bucket.push(res);
    }
  }

  load(): SyncConfig {
    return this.config;
  }

  country(code: string | null): CountryConfig | null {
    if (!code) return null;
    const c = code.toUpperCase();
    return this.config.countries.find((x) => x.code.toUpperCase() === c) ?? null;
  }

  source(key: string): SourceConfig | null {
    return this.config.sources.find((s) => s.key === key) ?? null;
  }

  resolveCity(countryCode: string | null, cityText: string | null): CityResolution | null {
    if (!cityText) return null;
    const key = cityKey(cityText);
    if (!key) return null;

    const cc = (countryCode ?? "").toUpperCase();
    if (cc) {
      // Country is authoritative: only a city configured for THIS country can
      // match. Never fall back to another country's city or alias.
      return this.cityIndex.get(`${cc}|${key}`) ?? null;
    }

    // Country-less: accept only when exactly one distinct city matches.
    const matches = this.countrylessCityIndex.get(key);
    if (!matches || matches.length !== 1) return null;
    return matches[0];
  }

  citiesInScope(source: SourceConfig): CityConfig[] {
    const countries = new Set(source.scope.countries.map((c) => c.toUpperCase()));
    const cities = new Set(source.scope.cities.map((c) => cityKey(c)));
    return this.config.cities.filter((city) => {
      if (!city.enabled) return false;
      if (countries.size > 0 && !countries.has(city.countryCode.toUpperCase())) {
        return false;
      }
      if (cities.size > 0 && !cities.has(cityKey(city.canonicalName))) return false;
      return true;
    });
  }

  sourcesForKind(kind: EntityKind): SourceConfig[] {
    return this.config.sources.filter((s) => s.enabled && s.kinds.includes(kind));
  }

  aliasesForCity(countryCode: string, cityName: string): VenueAliasConfig[] {
    const cc = countryCode.toUpperCase();
    const ck = cityKey(cityName);
    return this.config.venueAliases.filter(
      (a) => a.countryCode.toUpperCase() === cc && cityKey(a.cityName) === ck,
    );
  }
}
