/**
 * Characterization tests for `../../src/sync/config.ts`.
 *
 * The quality/architecture audit found NO correctness bug. This file locks in
 * the current behavior of the parts that were previously only exercised
 * indirectly (via `planSync`) or not at all:
 *
 *   - `cityKey()` folding — diacritics, the `đ → dj` digraph, punctuation,
 *     and the Latin-only limitation (non-Latin scripts fold to `""`)
 *   - `InMemoryConfigProvider` getters: `country` / `source` / `load`
 *   - `citiesInScope` / `sourcesForKind` / `aliasesForCity`
 *   - config footguns that are silently tolerated today (documented, not fixed):
 *       * a duplicate `(countryCode, canonicalName)` city row
 *       * an alias that equals another city's folded canonical name
 *       * an alias/name that folds to `""`
 *       * `load()` / getters return live references into the config
 *
 * `resolveCity`'s country-authoritative / ambiguity contract has its own
 * regression file (`./config-city-resolution.test.ts`); this file adds the
 * folding + getter + footgun coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRecord } from "../../src/sync/validation.ts";
import {
  assertValidCityConfig,
  assertValidPlaceholderPatterns,
  cityKey,
  DEFAULT_RECONCILIATION,
  InMemoryConfigProvider,
  PLACEHOLDER_REGEX_FLAGS,
  type CityConfig,
  type CountryConfig,
  type SourceConfig,
  type SyncConfig,
} from "../../src/sync/config.ts";
import type { NormalizedRecord, ResolvedScope } from "../../src/sync/types.ts";

// ── fixtures ───────────────────────────────────────────────────────

const country = (over: Partial<CountryConfig> & { code: string }): CountryConfig => ({
  name: over.code,
  enabled: true,
  defaultTimeZone: "UTC",
  bounds: null,
  normalizationProfile: "latin",
  extraPlaceholderPatterns: [],
  ...over,
});

const city = (
  countryCode: string,
  canonicalName: string,
  over: Partial<CityConfig> = {},
): CityConfig => ({
  countryCode,
  canonicalName,
  enabled: true,
  eventFirstEnabled: false,
  timeZone: "UTC",
  nameAliases: [],
  bounds: null,
  sourceScope: {},
  ...over,
});

const source = (over: Partial<SourceConfig> & { key: string }): SourceConfig => ({
  adapter: over.key,
  kinds: ["event"],
  enabled: true,
  trusted: false,
  tos: "permitted",
  scope: { countries: [], cities: [] },
  schedule: null,
  rateLimit: null,
  fieldTrust: {},
  settings: {},
  ...over,
});

const syncConfig = (over: Partial<SyncConfig> = {}): SyncConfig => ({
  countries: [],
  cities: [],
  sources: [],
  venueAliases: [],
  reconciliation: DEFAULT_RECONCILIATION,
  ...over,
});

// ════════════════════════════════════════════════════════════════════
//  cityKey — the shared match-key fold
// ════════════════════════════════════════════════════════════════════

test("cityKey: lower-cases, collapses whitespace/punctuation, trims", () => {
  assert.equal(cityKey("  New   York! "), "new york");
  assert.equal(cityKey("Saint-Étienne"), "saint etienne");
  assert.equal(cityKey("CITY_NAME"), "city name");
});

test("cityKey: folds Latin diacritics via NFD", () => {
  assert.equal(cityKey("Niš"), "nis");
  assert.equal(cityKey("Zürich"), "zurich");
  assert.equal(cityKey("Málaga"), "malaga");
  assert.equal(cityKey("Kraków"), "krakow");
});

test("cityKey: `đ` / `Đ` become the `dj` digraph (NFD cannot decompose it)", () => {
  assert.equal(cityKey("Đakovo"), "djakovo");
  assert.equal(cityKey("ĐAKOVO"), "djakovo");
});

test("cityKey: [LIMITATION] a non-Latin script folds to the empty string", () => {
  // `cityKey` is Latin-oriented by design — it de-accents, it does NOT
  // transliterate. Cyrillic / CJK / etc. become "" because `[^a-z0-9]+` strips
  // them. A source that reports such a name resolves only if config supplies a
  // LATIN alias (see the footgun test below).
  assert.equal(cityKey("Београд"), "");
  assert.equal(cityKey("北京"), "");
  assert.equal(cityKey("القاهرة"), "");
});

test("cityKey: an all-punctuation / empty input folds to ''", () => {
  assert.equal(cityKey(""), "");
  assert.equal(cityKey("—"), "");
  assert.equal(cityKey("  -. ?_ "), "");
});

test("cityKey: `|` can never survive the fold (the `CC|key` index separator is safe)", () => {
  assert.equal(cityKey("a|b"), "a b");
  assert.doesNotMatch(cityKey("weird | name"), /\|/);
});

// ════════════════════════════════════════════════════════════════════
//  getters: country / source / load
// ════════════════════════════════════════════════════════════════════

const P = () =>
  new InMemoryConfigProvider(
    syncConfig({
      countries: [country({ code: "RS", name: "Serbia" }), country({ code: "hr", name: "Croatia" })],
      cities: [city("RS", "Belgrade", { nameAliases: ["beograd"] }), city("HR", "Zagreb")],
      sources: [
        source({ key: "a-events", kinds: ["event"], enabled: true }),
        source({ key: "b-venues", kinds: ["venue"], enabled: true }),
        source({ key: "c-off", kinds: ["event"], enabled: false }),
        source({ key: "d-both", kinds: ["event", "venue"], enabled: true }),
      ],
    }),
  );

test("country(): case-insensitive lookup; null / unknown → null", () => {
  const p = P();
  assert.equal(p.country("RS")?.name, "Serbia");
  assert.equal(p.country("rs")?.name, "Serbia");
  assert.equal(p.country("HR")?.name, "Croatia"); // config stored it lower-case
  assert.equal(p.country(null), null);
  assert.equal(p.country(""), null);
  assert.equal(p.country("ZZ"), null);
});

test("source(): exact-key lookup; unknown → null (no case folding on the key)", () => {
  const p = P();
  assert.equal(p.source("a-events")?.key, "a-events");
  assert.equal(p.source("A-EVENTS"), null);
  assert.equal(p.source("nope"), null);
});

test("sourcesForKind(): enabled sources whose kinds include the requested kind", () => {
  const p = P();
  assert.deepEqual(p.sourcesForKind("event").map((s) => s.key).sort(), ["a-events", "d-both"]);
  assert.deepEqual(p.sourcesForKind("venue").map((s) => s.key).sort(), ["b-venues", "d-both"]);
  // c-off is disabled → excluded from both
});

test("load(): returns the config; same reference on every call (no defensive copy today)", () => {
  const p = P();
  assert.equal(p.load(), p.load());
  assert.equal(p.load().countries.length, 2);
});

// ════════════════════════════════════════════════════════════════════
//  citiesInScope
// ════════════════════════════════════════════════════════════════════

const scopeProvider = () =>
  new InMemoryConfigProvider(
    syncConfig({
      countries: [country({ code: "RS" }), country({ code: "HR" })],
      cities: [
        city("RS", "Belgrade"),
        city("RS", "Novi Sad", { enabled: false }),
        city("HR", "Zagreb"),
        city("HR", "Split"),
      ],
    }),
  );

test("citiesInScope: empty scope → every ENABLED city, disabled ones excluded", () => {
  const p = scopeProvider();
  const names = p
    .citiesInScope(source({ key: "s", scope: { countries: [], cities: [] } }))
    .map((c) => c.canonicalName)
    .sort();
  assert.deepEqual(names, ["Belgrade", "Split", "Zagreb"]); // no "Novi Sad"
});

test("citiesInScope: country scope filters case-insensitively", () => {
  const p = scopeProvider();
  const names = p
    .citiesInScope(source({ key: "s", scope: { countries: ["hr"], cities: [] } }))
    .map((c) => c.canonicalName)
    .sort();
  assert.deepEqual(names, ["Split", "Zagreb"]);
});

test("citiesInScope: city scope filters via cityKey (fold-insensitive)", () => {
  const p = scopeProvider();
  const names = p
    .citiesInScope(source({ key: "s", scope: { countries: [], cities: ["  BELGRADE ", "split"] } }))
    .map((c) => c.canonicalName)
    .sort();
  assert.deepEqual(names, ["Belgrade", "Split"]);
});

test("citiesInScope: country AND city scope both apply (intersection)", () => {
  const p = scopeProvider();
  const names = p
    .citiesInScope(source({ key: "s", scope: { countries: ["RS"], cities: ["zagreb", "belgrade"] } }))
    .map((c) => c.canonicalName);
  assert.deepEqual(names, ["Belgrade"]); // Zagreb is HR → filtered out by the country clause
});

// ════════════════════════════════════════════════════════════════════
//  aliasesForCity
// ════════════════════════════════════════════════════════════════════

test("aliasesForCity: matches on country (case-insensitive) + the row's cityName (cityKey-folded)", () => {
  const p = new InMemoryConfigProvider(
    syncConfig({
      countries: [country({ code: "RS" })],
      cities: [city("RS", "Belgrade")],
      venueAliases: [
        { countryCode: "rs", cityName: "  BELGRADE ", aliasNormalized: "dragstor", canonicalName: "Drugstore", note: null },
        { countryCode: "RS", cityName: "Belgrade", aliasNormalized: "kst", canonicalName: "KST", note: "x" },
        { countryCode: "HR", cityName: "Zagreb", aliasNormalized: "other", canonicalName: "Other", note: null },
      ],
    }),
  );
  const got = p.aliasesForCity("RS", "Belgrade").map((a) => a.aliasNormalized).sort();
  assert.deepEqual(got, ["dragstor", "kst"]); // both RS rows whose cityName folds to "belgrade"
  assert.deepEqual(p.aliasesForCity("RS", "Niš"), []);
});

test("[footgun] aliasesForCity does a RAW folded-string match on the row's cityName — it does NOT resolve through city aliases", () => {
  const p = new InMemoryConfigProvider(
    syncConfig({
      countries: [country({ code: "RS" })],
      cities: [city("RS", "Belgrade", { nameAliases: ["beograd"] })],
      venueAliases: [
        // this row keys the venue-alias by the city EXONYM, not the canonical name
        { countryCode: "RS", cityName: "beograd", aliasNormalized: "dragstor", canonicalName: "Drugstore", note: null },
      ],
    }),
  );
  // querying by the canonical name does NOT find a row keyed by the exonym…
  assert.deepEqual(p.aliasesForCity("RS", "Belgrade"), []);
  // …only a query that folds identically to the row's own cityName matches
  assert.equal(p.aliasesForCity("RS", "Beograd").length, 1);
});

// ════════════════════════════════════════════════════════════════════
//  P1 — city-config validation: invalid config is REJECTED loudly at
//  construction (never silently normalized). Same policy as
//  assertValidReconciliationThresholds / assertValidPlaceholderPatterns.
// ════════════════════════════════════════════════════════════════════

test("[P1 regression] a canonicalName that folds to '' is REJECTED at construction", () => {
  const cities = [city("RS", "Београд")]; // Cyrillic — cityKey folds it to ""
  assert.throws(() => assertValidCityConfig(cities), /canonicalName.*empty match key/);
  assert.throws(
    () => new InMemoryConfigProvider(syncConfig({ countries: [country({ code: "RS" })], cities })),
    /canonicalName.*empty match key/,
  );
});

test("[P1 regression] a nameAlias that folds to '' is REJECTED at construction (message names the alias index)", () => {
  const cities = [city("RS", "Belgrade", { nameAliases: ["beograd", "београд"] })];
  assert.throws(() => assertValidCityConfig(cities), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /nameAliases\[1\]/);
    assert.match(err.message, /empty match key/);
    assert.match(err.message, /Belgrade/);
    assert.match(err.message, /"RS"/);
    return true;
  });
  assert.throws(
    () => new InMemoryConfigProvider(syncConfig({ countries: [country({ code: "RS" })], cities })),
    /nameAliases\[1\]/,
  );
});

test("[P1 regression] duplicate cities with the same (countryCode, cityKey(canonicalName)) are REJECTED", () => {
  // exact dup
  assert.throws(
    () => assertValidCityConfig([city("AA", "Rivertown"), city("AA", "Rivertown")]),
    /duplicate/,
  );
  // dup only after folding + case-insensitive country
  assert.throws(
    () => assertValidCityConfig([city("AA", "Saint-Étienne"), city("aa", "saint etienne")]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /duplicate/);
      assert.match(err.message, /saint etienne/); // the folded key
      return true;
    },
  );
  assert.throws(
    () =>
      new InMemoryConfigProvider(
        syncConfig({
          countries: [country({ code: "AA" })],
          cities: [city("AA", "Rivertown", { timeZone: "TZ-1" }), city("AA", "Rivertown", { timeZone: "TZ-2" })],
        }),
      ),
    /duplicate/,
  );
});

test("[P1 regression] same folded name in DIFFERENT countries is ALLOWED (country-less ambiguity preserved)", () => {
  const cities = [
    city("AA", "Rivertown", { nameAliases: ["riverside"] }),
    city("BB", "Rivertown", { nameAliases: ["riverside"] }),
  ];
  assert.doesNotThrow(() => assertValidCityConfig(cities));
  const p = new InMemoryConfigProvider(
    syncConfig({ countries: [country({ code: "AA" }), country({ code: "BB" })], cities }),
  );
  // the pre-existing ambiguity behavior is intact
  assert.equal(p.resolveCity(null, "Rivertown"), null);
  assert.equal(p.resolveCity("AA", "Rivertown")?.city.countryCode, "AA");
  assert.equal(p.resolveCity("BB", "riverside")?.city.countryCode, "BB");
});

test("[P1 regression] an alias shared between cities / countries is ALLOWED", () => {
  assert.doesNotThrow(() =>
    assertValidCityConfig([
      city("AA", "Alpha", { nameAliases: ["shared"] }),
      city("AA", "Beta", { nameAliases: ["shared"] }), // same country, same alias, DIFFERENT canonical → allowed
      city("BB", "Gamma", { nameAliases: ["shared"] }),
    ]),
  );
});

test("[P2] country-authoritative index: build and lookup agree on the key, case-insensitively", () => {
  // Exercises `cityIndexKey()` on both the build side (indexCity) and the query
  // side (resolveCity) with mismatched country-code casing throughout.
  const p = new InMemoryConfigProvider(
    syncConfig({
      countries: [country({ code: "aa" })], // lower-case in the country list
      cities: [city("Aa", "Rivertown", { nameAliases: ["RiverSide"] })], // mixed-case country + alias
    }),
  );
  assert.equal(p.resolveCity("AA", "rivertown")?.city.canonicalName, "Rivertown");
  assert.equal(p.resolveCity("aA", "  RIVERSIDE ")?.via, "alias");
  assert.equal(p.resolveCity("aa", "Rivertown")?.via, "canonical-name");
  assert.equal(p.resolveCity("BB", "Rivertown"), null); // still country-authoritative
});

test("[P1 regression] the existing world / resolution fixtures stay valid", () => {
  // `config-city-resolution.test.ts` CONFIG shape (AA/BB Rivertown + AA Soloville)
  assert.doesNotThrow(() =>
    assertValidCityConfig([
      city("AA", "Rivertown", { nameAliases: ["riverside"] }),
      city("BB", "Rivertown", { nameAliases: ["riverside"] }),
      city("AA", "Soloville", { nameAliases: ["onlyplace"] }),
    ]),
  );
  assert.doesNotThrow(() => assertValidCityConfig([])); // empty is fine
});

// ════════════════════════════════════════════════════════════════════
//  P3 — placeholder regex flags are ONE shared constant
// ════════════════════════════════════════════════════════════════════

test("[P3] PLACEHOLDER_REGEX_FLAGS is `\"i\"` and both layers reference it (no inline flag literal)", () => {
  assert.equal(PLACEHOLDER_REGEX_FLAGS, "i");

  const cfgSrc = readFileSync(new URL("../../src/sync/config.ts", import.meta.url), "utf8");
  const valSrc = readFileSync(new URL("../../src/sync/validation.ts", import.meta.url), "utf8");
  assert.match(cfgSrc, /export const PLACEHOLDER_REGEX_FLAGS = "i"/);
  assert.match(valSrc, /PLACEHOLDER_REGEX_FLAGS/, "validation.ts must use the shared constant");
  // no `new RegExp(x, "i")` inline literal left in either file
  for (const src of [cfgSrc.replace(/PLACEHOLDER_REGEX_FLAGS = "i"/, ""), valSrc]) {
    assert.doesNotMatch(src, /new RegExp\([^)]*,\s*["']i["']\s*\)/);
  }
});

test("[P3] config load-validation and validateRecord agree on case-insensitivity", () => {
  const rs = country({ code: "RS", extraPlaceholderPatterns: ["^(uskoro|nepoznat)$"] });
  // config layer: the pattern compiles → accepted
  assert.doesNotThrow(() => assertValidPlaceholderPatterns([rs]));
  // check layer: the SAME pattern matches a differently-cased name (the "i" flag)
  const rec: NormalizedRecord = {
    kind: "venue",
    provenance: { sourceKey: "s", externalId: "x", sourceUrl: null, confidence: 1, fetchedAt: "2026-01-01T00:00:00Z", reported: {} },
    scope: { countryCode: "RS", cityText: "Belgrade", coordinates: null },
    fields: {
      name: "USKORO",
      normalizedName: "uskoro",
      address: null,
      coordinates: null,
      coordinatesSource: null,
      website: null,
      wikidata: null,
      openingHours: null,
    },
    links: {},
  };
  const scope: ResolvedScope = {
    countryCode: "RS", cityName: "Belgrade", cityId: "c1", timeZone: "UTC",
    cityEnabled: true, eventFirstEnabled: false, bounds: null, resolvedVia: "country+city",
  };
  const r = validateRecord({ record: rec, scope, country: rs });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.reasonCode, "placeholder-venue-name");
});

// ════════════════════════════════════════════════════════════════════
//  FOOTGUNS still tolerated (characterization; NOT in P1's scope)
// ════════════════════════════════════════════════════════════════════

test("[footgun] an alias equal to another city's folded canonical name can still shadow it (insertion-order dependent)", () => {
  // P1 rejects a duplicate CANONICAL key, not an alias that collides with one.
  const p = new InMemoryConfigProvider(
    syncConfig({
      countries: [country({ code: "AA" })],
      cities: [
        city("AA", "Xtown"), // indexed first, via "canonical-name"
        city("AA", "Ytown", { nameAliases: ["xtown"] }), // its alias overwrites AA|xtown
      ],
    }),
  );
  const r = p.resolveCity("AA", "Xtown");
  assert.equal(r?.city.canonicalName, "Ytown", "the later alias shadowed the earlier canonical name");
  assert.equal(r?.via, "alias");
});

test("[footgun] load() and getters expose live references into the config (no snapshot boundary)", () => {
  const cfg = syncConfig({
    countries: [country({ code: "RS" })],
    sources: [source({ key: "s", enabled: true })],
  });
  const p = new InMemoryConfigProvider(cfg);
  assert.equal(p.load(), cfg, "load() hands back the very object passed to the constructor");
  assert.equal(p.source("s"), cfg.sources[0], "getters return the same object references");
  // (documented: nothing enforces read-only; callers must not mutate)
});
