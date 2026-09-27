/**
 * OpenStreetMap (Overpass) `SourceAdapter` for the generic sync engine, plus
 * the `SyncConfig` builder for the same OSM targets.
 *
 * This is a thin wrapper — it owns no Overpass, parsing or classification
 * logic of its own:
 *   - query:    `../../sources/osm-overpass.ts#buildOverpassQuery`
 *   - fetch:    `#fetchOverpass` (retries; a `remark` or a missing `elements`
 *               array throws, and the engine counts the ref as fetch-failed)
 *   - parse:    `#parseOverpassVenues` (normalize + classify + rescue + dedup)
 * Its only job is mapping the accepted `NormalizedVenue`s onto the engine's
 * `NormalizedRecord` contract. Invalid / excluded elements never become
 * records.
 *
 * One discovered ref = one target (one city's Overpass area query). The
 * targets are passed in, not read from `AdapterContext`: the context carries
 * only city NAMES, while a target also needs its OSM relation id.
 */

import type { Config } from "../../config.ts";
import {
  buildOverpassQuery,
  fetchOverpass,
  parseOverpassVenues,
} from "../../sources/osm-overpass.ts";
import type { IngestionTarget } from "../../targets.ts";
import type { NormalizedVenue, OverpassResponse } from "../../types.ts";
import { DEFAULT_RECONCILIATION, InMemoryConfigProvider } from "../config.ts";
import type { CityConfig, CountryConfig, SourceConfig, SyncConfig } from "../config.ts";
import type {
  AdapterContext,
  NormalizedRecord,
  ParsedItem,
  RawItem,
  SourceAdapter,
  SourceItemRef,
} from "../types.ts";

/**
 * Must equal `data_sources.name` of the existing OSM row (seeded by migration
 * 20260907150000 and used by the legacy runner). Any other key would make the
 * store auto-create a second source and treat existing OSM rows as foreign.
 */
export const OSM_SOURCE_KEY = "OpenStreetMap";

/**
 * Country metadata the targets do not carry. Only countries listed here can be
 * targeted; an unlisted one fails loudly in `buildOsmSyncConfig` rather than
 * getting guessed defaults.
 */
const OSM_COUNTRIES: Record<string, Pick<CountryConfig, "name" | "defaultTimeZone" | "normalizationProfile">> = {
  RS: { name: "Serbia", defaultTimeZone: "Europe/Belgrade", normalizationProfile: "sr" },
};

/** Stable, unique ref id for a target — also how `parse` finds it again. */
export function osmTargetRefId(target: IngestionTarget): string {
  return `${target.countryId}:${target.cityName}:relation/${target.osmRelationId}`;
}

export interface OsmOverpassAdapterOptions {
  targets: IngestionTarget[];
  /** Overpass URL + user agent (only those fields are used). */
  config: Config;
  /** Injectable for tests; defaults to the real Overpass transport. */
  transport?: (query: string, config: Config) => Promise<OverpassResponse>;
  /** Injectable clock for `RawItem.fetchedAt`, for deterministic tests. */
  now?: () => string;
}

export function createOsmOverpassAdapter(opts: OsmOverpassAdapterOptions): SourceAdapter {
  const transport = opts.transport ?? fetchOverpass;
  const now = opts.now ?? (() => new Date().toISOString());
  const byRefId = new Map(opts.targets.map((t) => [osmTargetRefId(t), t]));
  if (byRefId.size !== opts.targets.length) {
    throw new Error("OSM targets must be unique by (country, city, relation id)");
  }

  return {
    key: OSM_SOURCE_KEY,
    capabilities: {
      kinds: ["venue"],
      discovery: "api",
      givesExternalId: true,
      givesCoordinates: true,
      givesVenuePages: false,
      emitsCancellations: false,
      // one ref = one city's complete area query
      snapshotRefs: true,
    },

    async *discover(ctx: AdapterContext): AsyncIterable<SourceItemRef> {
      // Only the cities the engine put in scope (enabled + source scope).
      const inScope = new Set(ctx.cities);
      for (const target of opts.targets) {
        if (!inScope.has(target.cityName)) continue;
        yield {
          url: opts.config.overpassUrl,
          externalId: osmTargetRefId(target),
          kindHint: "venue",
          lastModified: null,
        };
      }
    },

    async fetch(ref: SourceItemRef): Promise<RawItem> {
      const target = ref.externalId != null ? byRefId.get(ref.externalId) : undefined;
      if (!target) throw new Error(`unknown OSM target ref ${ref.externalId}`);
      const response = await transport(buildOverpassQuery(target), opts.config);
      return {
        ref,
        url: opts.config.overpassUrl,
        status: 200,
        body: JSON.stringify(response),
        contentType: "application/json",
        fetchedAt: now(),
      };
    },

    parse(raw: RawItem): ParsedItem {
      const target = raw.ref.externalId != null ? byRefId.get(raw.ref.externalId) : undefined;
      if (!target) return { ok: false, reason: "unknown-target", detail: raw.ref.externalId ?? "" };
      let response: OverpassResponse;
      try {
        response = JSON.parse(raw.body) as OverpassResponse;
      } catch {
        return { ok: false, reason: "invalid-json" };
      }
      // A configured city's nightlife query never legitimately comes back empty:
      // an empty (or all-rejected) snapshot is a broken fetch, not "every venue
      // closed". Failing the ref keeps it out of reconciliation.
      const elements = Array.isArray(response.elements) ? response.elements.length : 0;
      if (elements === 0) {
        return { ok: false, reason: "empty-result", detail: `${raw.ref.externalId}: Overpass returned 0 elements` };
      }
      const { venues, invalid, excluded } = parseOverpassVenues(response, target);
      if (venues.length === 0) {
        return {
          ok: false,
          reason: "no-accepted-venues",
          detail: `${raw.ref.externalId}: ${elements} elements, 0 accepted (${invalid.length} invalid, ${excluded.length} excluded)`,
        };
      }
      return { ok: true, records: venues.map((v) => toRecord(v, target, raw.fetchedAt)) };
    },
  };
}

/** `{ [key]: value }` for a real value; `{}` (the key omitted) for null. */
function provided<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return value == null ? {} : ({ [key]: value } as { [P in K]?: string });
}

function toRecord(v: NormalizedVenue, target: IngestionTarget, fetchedAt: string): NormalizedRecord {
  const coordinates = { latitude: v.latitude, longitude: v.longitude };
  return {
    kind: "venue",
    provenance: {
      sourceKey: OSM_SOURCE_KEY,
      externalId: v.externalId,
      sourceUrl: v.sourceUrl,
      // Structured tags, not scraped text — extraction itself is certain.
      // Classifier doubt is carried as `reported.review` / `reported.rescued`.
      confidence: 1,
      fetchedAt,
      // Classifier metadata the legacy report shows. Not part of the
      // change-detection hash and not persisted by the Supabase store.
      reported: {
        osmType: v.osmType,
        osmId: v.osmId,
        category: v.category ?? null,
        acceptedVia: v.acceptedVia ?? null,
        rescued: v.rescued === true,
        review: v.review === true,
      },
    },
    scope: { countryCode: target.countryId, cityText: target.cityName, coordinates },
    fields: {
      name: v.name,
      normalizedName: v.nameNormalized,
      coordinates,
      coordinatesSource: "source",
      // A missing (or blank) OSM tag is OMITTED, never null: an Overpass
      // snapshot cannot tell "never tagged" from "tag deleted", so it must not
      // read as a clear. An address with at least one addr:* part is provided.
      ...provided("address", v.address),
      ...provided("website", v.website),
      ...provided("wikidata", v.wikidata),
      ...provided("openingHours", v.openingHours),
    },
    links: {},
  };
}

/**
 * The engine configuration for the OSM targets: one country / city per target
 * and the single OSM source scoped to exactly those cities. Event-first is off
 * (OSM is venue-only) and bounds are null (the Overpass area query already
 * scopes the data).
 */
export function buildOsmSyncConfig(targets: IngestionTarget[]): SyncConfig {
  const countries: CountryConfig[] = [];
  const cities: CityConfig[] = [];
  for (const target of targets) {
    const meta = OSM_COUNTRIES[target.countryId];
    if (!meta) {
      throw new Error(`no OSM country metadata for "${target.countryId}" — add it to OSM_COUNTRIES`);
    }
    if (!countries.some((c) => c.code === target.countryId)) {
      countries.push({
        code: target.countryId,
        ...meta,
        enabled: true,
        bounds: null,
        extraPlaceholderPatterns: [],
      });
    }
    cities.push({
      countryCode: target.countryId,
      canonicalName: target.cityName,
      enabled: true,
      eventFirstEnabled: false,
      timeZone: meta.defaultTimeZone,
      nameAliases: [],
      bounds: null,
      sourceScope: { osm: { relationId: target.osmRelationId } },
    });
  }
  const source: SourceConfig = {
    key: OSM_SOURCE_KEY,
    adapter: "osm-overpass",
    kinds: ["venue"],
    enabled: true,
    trusted: true,
    tos: "permitted",
    scope: { countries: countries.map((c) => c.code), cities: targets.map((t) => t.cityName) },
    schedule: null,
    rateLimit: null,
    fieldTrust: {},
    settings: {},
  };
  return {
    countries,
    cities,
    sources: [source],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  };
}

/** `buildOsmSyncConfig` behind the validating `InMemoryConfigProvider`. */
export function createOsmConfigProvider(targets: IngestionTarget[]): InMemoryConfigProvider {
  return new InMemoryConfigProvider(buildOsmSyncConfig(targets));
}
