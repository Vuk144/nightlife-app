/**
 * Regression: `InMemoryConfigProvider.resolveCity` must never silently resolve
 * an ambiguous country-less city name to an arbitrary city ("last write wins").
 *
 *  - country known   -> only a city configured for THAT country can match
 *  - country unknown  -> resolves ONLY when exactly one distinct city matches
 *
 * Everything here is DATA — the provider body contains no city/country names.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RECONCILIATION,
  InMemoryConfigProvider,
  type CityConfig,
  type SyncConfig,
} from "../../src/sync/config.ts";

function city(
  countryCode: string,
  canonicalName: string,
  nameAliases: string[] = [],
): CityConfig {
  return {
    countryCode,
    canonicalName,
    enabled: true,
    eventFirstEnabled: false,
    timeZone: "UTC",
    nameAliases,
    bounds: null,
    sourceScope: {},
  };
}

/**
 * Two countries (AA, BB) that deliberately collide:
 *  - both have a city called "Rivertown"            (ambiguous canonical name)
 *  - both have an alias "riverside"                  (ambiguous alias)
 *  - AA additionally has a unique "Soloville" with a unique alias "onlyplace"
 */
const CONFIG: SyncConfig = {
  countries: [
    { code: "AA", name: "Aaland", enabled: true, defaultTimeZone: "UTC", bounds: null, normalizationProfile: "latin", extraPlaceholderPatterns: [] },
    { code: "BB", name: "Beeland", enabled: true, defaultTimeZone: "UTC", bounds: null, normalizationProfile: "latin", extraPlaceholderPatterns: [] },
  ],
  cities: [
    city("AA", "Rivertown", ["riverside"]),
    city("BB", "Rivertown", ["riverside"]),
    city("AA", "Soloville", ["onlyplace"]),
  ],
  sources: [],
  venueAliases: [],
  reconciliation: DEFAULT_RECONCILIATION,
};

const provider = () => new InMemoryConfigProvider(CONFIG);

// ── country-less input ───────────────────────────────────────────────
test("same city name in two countries + no country -> unresolved", () => {
  assert.equal(provider().resolveCity(null, "Rivertown"), null);
  assert.equal(provider().resolveCity("", "Rivertown"), null);
});

test("unique city with no country -> resolves", () => {
  const r = provider().resolveCity(null, "Soloville");
  assert.equal(r?.city.canonicalName, "Soloville");
  assert.equal(r?.city.countryCode, "AA");
  assert.equal(r?.via, "canonical-name");
});

test("unique alias with no country -> resolves", () => {
  const r = provider().resolveCity(null, "onlyplace");
  assert.equal(r?.city.canonicalName, "Soloville");
  assert.equal(r?.via, "alias");
});

test("ambiguous alias with no country -> unresolved", () => {
  assert.equal(provider().resolveCity(null, "riverside"), null);
});

test("country-less input that matches nothing -> unresolved", () => {
  assert.equal(provider().resolveCity(null, "Nowhereton"), null);
});

// ── country known: authoritative, no cross-country leakage ───────────
test("same city name in two countries + correct country -> correct city", () => {
  const aa = provider().resolveCity("AA", "Rivertown");
  const bb = provider().resolveCity("BB", "Rivertown");
  assert.equal(aa?.city.countryCode, "AA");
  assert.equal(bb?.city.countryCode, "BB");
  assert.notEqual(aa?.city, bb?.city);
});

test("ambiguous alias + correct country -> correct city (alias still works)", () => {
  assert.equal(provider().resolveCity("AA", "riverside")?.city.countryCode, "AA");
  assert.equal(provider().resolveCity("BB", "riverside")?.city.countryCode, "BB");
});

test("known country never falls back to another country's city or alias", () => {
  // "Soloville" / "onlyplace" exist only in AA — asking BB must NOT leak them.
  assert.equal(provider().resolveCity("BB", "Soloville"), null);
  assert.equal(provider().resolveCity("BB", "onlyplace"), null);
  // an unconfigured country code resolves nothing, even for a real city name
  assert.equal(provider().resolveCity("ZZ", "Rivertown"), null);
});

test("normalization stays data-driven for the country-qualified path", () => {
  // case / whitespace folding via cityKey, not a hardcoded branch
  assert.equal(provider().resolveCity("AA", "  RIVERTOWN  ")?.city.countryCode, "AA");
  assert.equal(provider().resolveCity("AA", "RiverSide")?.via, "alias");
});
