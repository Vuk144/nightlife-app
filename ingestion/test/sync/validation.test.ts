/**
 * `../../src/sync/validation.ts#validateRecord` — the generic, pure record
 * validator — plus the config-layer regex-pattern guard in `config.ts`.
 *
 * Focus areas (see the STEP-3 validation hardening task):
 *   - universal coordinate sanity: non-finite / out-of-Earth-range → rejected
 *   - valid coordinates outside the configured region → needs_review (unchanged)
 *   - whitespace-only normalizedName → rejected
 *   - invalid `extraPlaceholderPatterns` regex → config load fails loudly
 *   - optional fields stay optional
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRecord } from "../../src/sync/validation.ts";
import {
  assertValidPlaceholderPatterns,
  InMemoryConfigProvider,
  DEFAULT_RECONCILIATION,
  type SyncConfig,
} from "../../src/sync/config.ts";
import type { CountryConfig } from "../../src/sync/config.ts";
import type {
  GeoBounds,
  GeoPoint,
  NormalizedRecord,
  ResolvedScope,
  VenueFields,
  EventFields,
} from "../../src/sync/types.ts";

// ── fixtures ─────────────────────────────────────────────────────────
function scope(over: Partial<ResolvedScope> = {}): ResolvedScope {
  return {
    countryCode: "RS",
    cityName: "Belgrade",
    cityId: "city-bg",
    timeZone: "Europe/Belgrade",
    cityEnabled: true,
    eventFirstEnabled: false,
    bounds: null,
    resolvedVia: "country+city",
    ...over,
  };
}

function country(over: Partial<CountryConfig> = {}): CountryConfig {
  return {
    code: "RS",
    name: "Serbia",
    enabled: true,
    defaultTimeZone: "Europe/Belgrade",
    bounds: null,
    normalizationProfile: "sr",
    extraPlaceholderPatterns: [],
    ...over,
  };
}

function venueFields(over: Partial<VenueFields> = {}): VenueFields {
  return {
    name: "Klub Depo",
    normalizedName: "klub depo",
    address: null,
    coordinates: null,
    coordinatesSource: null,
    website: null,
    wikidata: null,
    openingHours: null,
    ...over,
  };
}

function venueRecord(fieldsOver: Partial<VenueFields> = {}): NormalizedRecord {
  return {
    kind: "venue",
    provenance: {
      sourceKey: "osm",
      externalId: "osm-1",
      sourceUrl: null,
      confidence: 0.9,
      fetchedAt: "2026-06-01T00:00:00.000Z",
      reported: {},
    },
    scope: { countryCode: "RS", cityText: "Beograd", coordinates: null },
    fields: venueFields(fieldsOver),
    links: {},
  };
}

function eventFields(over: Partial<EventFields> = {}): EventFields {
  return {
    title: "DJ Night",
    description: null,
    startLocal: "2026-07-01T22:00",
    endLocal: null,
    doorsLocal: null,
    timeZone: null,
    startPrecision: "datetime",
    status: "scheduled",
    promoter: null,
    ticketUrl: null,
    coverImageUrl: null,
    lineup: [],
    ...over,
  };
}

function eventRecord(opts: { fields?: Partial<EventFields>; venueCoordinates?: GeoPoint | null } = {}): NormalizedRecord {
  return {
    kind: "event",
    provenance: {
      sourceKey: "entrio-hr",
      externalId: "E1",
      sourceUrl: null,
      confidence: 0.9,
      fetchedAt: "2026-06-01T00:00:00.000Z",
      reported: {},
    },
    scope: { countryCode: "RS", cityText: "Beograd", coordinates: null },
    fields: eventFields(opts.fields),
    links: {
      venue: {
        name: "Tvornica",
        sourceVenueId: null,
        address: null,
        coordinates: opts.venueCoordinates ?? null,
        cityText: "Beograd",
      },
    },
  };
}

const SERBIA_BOUNDS: GeoBounds = { minLat: 42, maxLat: 46.3, minLon: 18.7, maxLon: 23.1 };

function v(fieldsOver: Partial<VenueFields>, scopeOver: Partial<ResolvedScope> = {}) {
  return validateRecord({ record: venueRecord(fieldsOver), scope: scope(scopeOver), country: country() });
}

// ── 1. universal coordinate sanity — REJECTED ───────────────────────
test("latitude > 90 is rejected", () => {
  const r = v({ coordinates: { latitude: 91, longitude: 20 } });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.reasonCode, "invalid-coordinates");
});

test("latitude < -90 is rejected", () => {
  assert.equal(v({ coordinates: { latitude: -90.0001, longitude: 20 } }).reasonCode, "invalid-coordinates");
});

test("longitude > 180 is rejected", () => {
  assert.equal(v({ coordinates: { latitude: 44, longitude: 180.5 } }).reasonCode, "invalid-coordinates");
});

test("longitude < -180 is rejected", () => {
  assert.equal(v({ coordinates: { latitude: 44, longitude: -181 } }).reasonCode, "invalid-coordinates");
});

test("NaN latitude or longitude is rejected", () => {
  assert.equal(v({ coordinates: { latitude: NaN, longitude: 20 } }).reasonCode, "invalid-coordinates");
  assert.equal(v({ coordinates: { latitude: 44, longitude: NaN } }).reasonCode, "invalid-coordinates");
});

test("Infinity latitude or longitude is rejected", () => {
  assert.equal(
    v({ coordinates: { latitude: Infinity, longitude: 20 } }).reasonCode,
    "invalid-coordinates",
  );
  assert.equal(
    v({ coordinates: { latitude: 44, longitude: -Infinity } }).reasonCode,
    "invalid-coordinates",
  );
});

test("the exact boundary values (±90 / ±180) are physically valid", () => {
  for (const c of [
    { latitude: 90, longitude: 180 },
    { latitude: -90, longitude: -180 },
  ] as const) {
    const r = v({ coordinates: c });
    assert.notEqual(r.reasonCode, "invalid-coordinates", JSON.stringify(c));
  }
});

// ── 2. regional bounds — still needs_review, never silent reject ────
test("valid coordinates with NO configured bounds pass validation", () => {
  const r = v({ coordinates: { latitude: 44.8, longitude: 20.45 } }); // Belgrade, no bounds set
  assert.equal(r.outcome, "ok");
});

test("valid coordinates OUTSIDE the configured regional bounds -> needs_review (not rejected)", () => {
  const r = validateRecord({
    record: venueRecord({ coordinates: { latitude: 48.85, longitude: 2.35 } }), // Paris
    scope: scope({ bounds: SERBIA_BOUNDS }),
    country: country({ bounds: SERBIA_BOUNDS }),
  });
  assert.equal(r.outcome, "needs_review");
  assert.equal(r.reasonCode, "coordinates-out-of-region");
});

test("physically-impossible coordinates are rejected even when regional bounds exist", () => {
  const r = validateRecord({
    record: venueRecord({ coordinates: { latitude: 999, longitude: 20 } }),
    scope: scope({ bounds: SERBIA_BOUNDS }),
    country: country({ bounds: SERBIA_BOUNDS }),
  });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.reasonCode, "invalid-coordinates");
});

test("valid in-bounds coordinates pass", () => {
  const r = validateRecord({
    record: venueRecord({ coordinates: { latitude: 44.8, longitude: 20.45 } }),
    scope: scope({ bounds: SERBIA_BOUNDS }),
    country: country({ bounds: SERBIA_BOUNDS }),
  });
  assert.equal(r.outcome, "ok");
});

test("an event whose venue hint carries non-finite coordinates is rejected", () => {
  const r = validateRecord({
    record: eventRecord({ venueCoordinates: { latitude: NaN, longitude: 20 } }),
    scope: scope(),
    country: country(),
  });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.reasonCode, "invalid-coordinates");
});

// ── 3. normalized name ─────────────────────────────────────────────
test("whitespace-only normalizedName is treated as empty -> rejected", () => {
  for (const ws of ["   ", "\t", "\n", "   "]) {
    const r = v({ name: "Real Venue Name", normalizedName: ws });
    assert.equal(r.outcome, "rejected", JSON.stringify(ws));
    assert.equal(r.reasonCode, "empty-normalized-name");
  }
});

test("a non-empty normalizedName still passes", () => {
  assert.equal(v({ name: "Real Venue Name", normalizedName: "real venue name" }).outcome, "ok");
});

// ── 4. country-specific placeholder regex configuration ────────────
test("assertValidPlaceholderPatterns throws clearly on an uncompilable regex", () => {
  for (const badPattern of ["(", "[", "a{2,1}", "\\"]) {
    assert.throws(
      () => assertValidPlaceholderPatterns([country({ code: "RS", extraPlaceholderPatterns: [badPattern] })]),
      (err: Error) => {
        assert.match(err.message, /country "RS"/);
        assert.match(err.message, /extraPlaceholderPatterns\[0\]/);
        assert.match(err.message, /not a valid regex/);
        return true;
      },
      badPattern,
    );
  }
});

test("assertValidPlaceholderPatterns accepts valid patterns (and an empty list)", () => {
  assert.doesNotThrow(() =>
    assertValidPlaceholderPatterns([
      country({ extraPlaceholderPatterns: [] }),
      country({ code: "HR", extraPlaceholderPatterns: ["^(nepoznato|uskoro|vi[sš]e lokacija)"] }),
    ]),
  );
});

function config(over: Partial<SyncConfig> = {}): SyncConfig {
  return {
    countries: [country()],
    cities: [],
    sources: [],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
    ...over,
  };
}

test("InMemoryConfigProvider rejects an invalid placeholder regex at construction", () => {
  assert.doesNotThrow(() => new InMemoryConfigProvider(config()));
  assert.throws(
    () => new InMemoryConfigProvider(config({ countries: [country({ extraPlaceholderPatterns: ["("] })] })),
    /not a valid regex/,
  );
});

test("a VALID country-specific placeholder pattern still filters names via validateRecord", () => {
  const rs = country({ extraPlaceholderPatterns: ["^(nepoznat|uskoro|vi[sš]e lokacija)"] });

  const flagged = validateRecord({
    record: venueRecord({ name: "Uskoro", normalizedName: "uskoro" }),
    scope: scope(),
    country: rs,
  });
  assert.equal(flagged.outcome, "rejected");
  assert.equal(flagged.reasonCode, "placeholder-venue-name");

  const realVenue = validateRecord({
    record: venueRecord({ name: "Klub Depo", normalizedName: "klub depo" }),
    scope: scope(),
    country: rs,
  });
  assert.equal(realVenue.outcome, "ok");

  // the UNIVERSAL placeholder list still applies regardless of country config
  const universal = validateRecord({
    record: venueRecord({ name: "TBA", normalizedName: "tba" }),
    scope: scope(),
    country: country({ extraPlaceholderPatterns: [] }),
  });
  assert.equal(universal.reasonCode, "placeholder-venue-name");
});

// ── 5. optional fields stay optional (no accidental over-validation) ─
test("a venue with ONLY the required fields validates ok", () => {
  const bare = venueRecord({
    name: "Klub Depo",
    normalizedName: "klub depo",
    address: null,
    coordinates: null,
    coordinatesSource: null,
    website: null,
    wikidata: null,
    openingHours: null,
    // description / openingTime / closingTime / isActive all omitted
  });
  const r = validateRecord({ record: bare, scope: scope(), country: country() });
  assert.equal(r.outcome, "ok");
});

test("an event with ONLY the required fields validates ok", () => {
  const r = validateRecord({
    record: eventRecord({
      fields: {
        title: "DJ Night",
        startLocal: "2026-07-01T22:00",
        endLocal: null,
        doorsLocal: null,
        description: null,
        promoter: null,
        ticketUrl: null,
        coverImageUrl: null,
        lineup: [],
      },
    }),
    scope: scope(),
    country: country(),
  });
  assert.equal(r.outcome, "ok");
});

test("optional URL-ish / free-text fields are never required or format-checked", () => {
  // deliberately weird-but-present optional values must not change the outcome
  const r = validateRecord({
    record: venueRecord({
      name: "Klub Depo",
      normalizedName: "klub depo",
      website: "not-a-url",
      description: "  ",
      openingHours: "garbage;;;",
      openingTime: "99:99",
      wikidata: "",
    }),
    scope: scope(),
    country: country(),
  });
  assert.equal(r.outcome, "ok");
});

// ── existing behavior preserved ────────────────────────────────────
test("still rejects the genuinely broken records", () => {
  assert.equal(
    validateRecord({ record: venueRecord({ name: "" }), scope: scope(), country: country() }).reasonCode,
    "missing-name",
  );
  assert.equal(
    validateRecord({
      record: { ...venueRecord(), provenance: { ...venueRecord().provenance, externalId: "" } },
      scope: scope(),
      country: country(),
    }).reasonCode,
    "missing-external-id",
  );
  assert.equal(
    validateRecord({ record: eventRecord({ fields: { title: "" } }), scope: scope(), country: country() }).reasonCode,
    "missing-title",
  );
});

test("city-unresolved is still needs_review, and comes AFTER coordinate checks", () => {
  const r = v({ coordinates: { latitude: 44.8, longitude: 20.45 } }, { cityName: null });
  assert.equal(r.outcome, "needs_review");
  assert.equal(r.reasonCode, "city-unresolved");
});

// ════════════════════════════════════════════════════════════════════════
//  AUDIT PASS — characterization of the current contract (no bug found)
// ════════════════════════════════════════════════════════════════════════

const RS_BOUNDS: GeoBounds = SERBIA_BOUNDS;
const HR_BOUNDS: GeoBounds = { minLat: 42.3, maxLat: 46.6, minLon: 13.4, maxLon: 19.5 };

function withExternalId(id: string): NormalizedRecord {
  const base = venueRecord();
  return { ...base, provenance: { ...base.provenance, externalId: id } };
}

// ── externalId: the presence check is NOT a trim check (question A) ──
test("[externalId] empty-string externalId is rejected; a whitespace-only one currently passes (untrimmed check)", () => {
  assert.equal(
    validateRecord({ record: withExternalId(""), scope: scope(), country: country() }).reasonCode,
    "missing-external-id",
  );
  // `if (!record.provenance.externalId)` — no `.trim()`, unlike name/title. No
  // production adapter for the sync engine exists yet, and `types.ts` types the
  // field `string` (never null/undefined), so a whitespace value is not
  // reachable today; this pins the behaviour if that ever changes.
  for (const ws of ["  ", "\t", "\n", " \t "]) {
    assert.equal(
      validateRecord({ record: withExternalId(ws), scope: scope(), country: country() }).outcome,
      "ok",
      JSON.stringify(ws),
    );
  }
});

// ── event startLocal: presence check, not a format / trim check ──
test("[startLocal] empty-string start is rejected; whitespace or unparseable text passes validation (the store defers it later)", () => {
  assert.equal(
    validateRecord({ record: eventRecord({ fields: { startLocal: "" } }), scope: scope(), country: country() }).reasonCode,
    "missing-start",
  );
  for (const s of ["   ", "next friday", "2026-02-30"]) {
    assert.equal(
      validateRecord({ record: eventRecord({ fields: { startLocal: s } }), scope: scope(), country: country() }).outcome,
      "ok",
      `validation does not format-check startLocal — ${JSON.stringify(s)}`,
    );
  }
});

// ── venue name length: UTF-16 code units (question B) ──
test("[name-too-short] `name.length < 2` counts UTF-16 code units — 1 ASCII or 1 BMP char is rejected", () => {
  assert.equal(v({ name: "Q", normalizedName: "q" }).reasonCode, "name-too-short");
  assert.equal(v({ name: "京", normalizedName: "jing" }).reasonCode, "name-too-short"); // 1 CJK codepoint, length 1
  assert.equal(v({ name: "  A  ", normalizedName: "a" }).reasonCode, "name-too-short"); // trimmed to "A"
});

test('[name-too-short][characterization] a single astral-plane char (surrogate pair, .length === 2) is NOT rejected', () => {
  // A quirk of `.length`, not a locale rule. No configured country has
  // single-character venue names; the audit forbids inventing one, so unchanged.
  assert.equal(v({ name: "🎵", normalizedName: "music" }).outcome, "ok");
  assert.equal(v({ name: "ab", normalizedName: "ab" }).outcome, "ok");
});

// ── (0,0) coordinates are a real point, not a magic "missing" sentinel ──
test("[coordinates] (0,0) is physically valid — `ok` with no bounds, `needs_review` inside a region that excludes it", () => {
  assert.equal(v({ coordinates: { latitude: 0, longitude: 0 } }).outcome, "ok");
  const r = validateRecord({
    record: venueRecord({ coordinates: { latitude: 0, longitude: 0 } }),
    scope: scope({ bounds: RS_BOUNDS }),
    country: country({ bounds: RS_BOUNDS }),
  });
  assert.equal(r.outcome, "needs_review");
  assert.equal(r.reasonCode, "coordinates-out-of-region");
  // "0,0 means missing" is a SOURCE-specific convention -> belongs in the adapter.
});

// ── event venue-hint coordinates: physical check only, NO regional bounds ──
test("[event][characterization] an event venue-hint coordinate is physical-checked but NOT region-checked", () => {
  const parisHint = validateRecord({
    record: eventRecord({ venueCoordinates: { latitude: 48.85, longitude: 2.35 } }), // Paris
    scope: scope({ bounds: RS_BOUNDS }),
    country: country({ bounds: RS_BOUNDS }),
  });
  assert.equal(parisHint.outcome, "ok", "the event path never calls withinBounds on the hint");

  const impossibleHint = validateRecord({
    record: eventRecord({ venueCoordinates: { latitude: 200, longitude: 2.35 } }),
    scope: scope({ bounds: RS_BOUNDS }),
    country: country({ bounds: RS_BOUNDS }),
  });
  assert.equal(impossibleHint.reasonCode, "invalid-coordinates", "physical impossibility is still rejected");
});

// ── bounds precedence: scope.bounds wins, country.bounds is the fallback (question E) ──
test("[bounds] scope.bounds takes precedence over country.bounds; country.bounds is only the fallback", () => {
  // A point inside HR_BOUNDS but OUTSIDE RS_BOUNDS.
  const zagreb = { latitude: 45.81, longitude: 15.97 };
  // scope carries the (tighter) RS bounds -> out of region
  const scopeWins = validateRecord({
    record: venueRecord({ coordinates: zagreb }),
    scope: scope({ bounds: RS_BOUNDS }),
    country: country({ bounds: HR_BOUNDS }),
  });
  assert.equal(scopeWins.reasonCode, "coordinates-out-of-region", "scope.bounds is consulted, not country.bounds");
  // scope has no bounds -> falls back to country.bounds (HR) -> in region
  const countryFallback = validateRecord({
    record: venueRecord({ coordinates: zagreb }),
    scope: scope({ bounds: null }),
    country: country({ bounds: HR_BOUNDS }),
  });
  assert.equal(countryFallback.outcome, "ok");
});

test("[bounds] no bounds anywhere -> the regional check is a no-op (never a silent reject)", () => {
  assert.equal(
    validateRecord({
      record: venueRecord({ coordinates: { latitude: 48.85, longitude: 2.35 } }), // Paris
      scope: scope({ bounds: null }),
      country: country({ bounds: null }),
    }).outcome,
    "ok",
  );
});

// ── placeholder detection: universal list + country extras, applied post-trim ──
test("[placeholder] the universal list matches after trimming and is case-insensitive", () => {
  for (const name of ["  TBA  ", "n/a", "NONE", "Various Locations", "Online Event", "  ---  "]) {
    const r = v({ name, normalizedName: "x" }); // force a non-empty normalizedName so isPlaceholder is reached
    assert.equal(r.reasonCode, "placeholder-venue-name", JSON.stringify(name));
  }
});

test("[placeholder][ordering] a punctuation-only VENUE name is caught by empty-normalized-name; the same as an EVENT venue hint is placeholder-venue-name", () => {
  // venue: the normalizedName check fires before isPlaceholder
  assert.equal(v({ name: "---", normalizedName: "" }).reasonCode, "empty-normalized-name");

  // event venue hint: a hint has no normalizedName, so pattern /^[\s\-.?_]+$/ applies
  const base = eventRecord() as Extract<NormalizedRecord, { kind: "event" }>;
  const hintDashes: NormalizedRecord = {
    ...base,
    links: { venue: { name: "---", sourceVenueId: null, address: null, coordinates: null, cityText: "Beograd" } },
  };
  assert.equal(
    validateRecord({ record: hintDashes, scope: scope(), country: country() }).reasonCode,
    "placeholder-venue-name",
  );
});

test("[placeholder] a country extra pattern only rejects; matching names are never merely needs_review", () => {
  const rs = country({ extraPlaceholderPatterns: ["^(uskoro|nepoznato)$"] });
  assert.equal(validateRecord({ record: venueRecord({ name: "Uskoro", normalizedName: "uskoro" }), scope: scope(), country: rs }).outcome, "rejected");
  assert.equal(validateRecord({ record: venueRecord({ name: "Klub Uskoro", normalizedName: "klub uskoro" }), scope: scope(), country: rs }).outcome, "ok");
});

// ── determinism + no cross-call regex state (questions C, J) ──
test("[determinism] repeated validation of the same record is deep-equal, for every outcome", () => {
  const inputs: Array<{ record: NormalizedRecord; scope: ResolvedScope; country: CountryConfig }> = [
    { record: venueRecord(), scope: scope(), country: country() }, // ok
    { record: venueRecord({ name: "" }), scope: scope(), country: country() }, // rejected
    { record: venueRecord({ coordinates: { latitude: 0, longitude: 0 } }), scope: scope({ bounds: RS_BOUNDS }), country: country({ bounds: RS_BOUNDS }) }, // needs_review
  ];
  for (const input of inputs) {
    const first = validateRecord(input);
    for (let i = 0; i < 5; i++) assert.deepEqual(validateRecord(input), first);
  }
});

test("[determinism] a placeholder match on one call does not leak regex `lastIndex` into the next", () => {
  const ctry = country({ extraPlaceholderPatterns: ["^tba$", "^uskoro$"] });
  const placeholder = () => validateRecord({ record: venueRecord({ name: "Uskoro", normalizedName: "uskoro" }), scope: scope(), country: ctry });
  const real = () => validateRecord({ record: venueRecord({ name: "Klub Depo", normalizedName: "klub depo" }), scope: scope(), country: ctry });
  for (let i = 0; i < 10; i++) {
    assert.equal(placeholder().outcome, "rejected");
    assert.equal(real().outcome, "ok");
  }
});

// ── purity: no mutation of inputs (question: accidental mutation) ──
test("[purity] validateRecord does not mutate the record, the scope, or country.extraPlaceholderPatterns", () => {
  const patterns = ["^tba$", "^uskoro$"];
  const ctry = country({ extraPlaceholderPatterns: patterns });
  const rec = venueRecord({ name: "Uskoro", normalizedName: "uskoro", coordinates: { latitude: 44.8, longitude: 20.45 } });
  const recBefore = JSON.stringify(rec);
  const patternsBefore = [...patterns];

  validateRecord({ record: rec, scope: scope({ bounds: RS_BOUNDS }), country: ctry });

  assert.equal(JSON.stringify(rec), recBefore, "record graph unchanged");
  assert.deepEqual(patterns, patternsBefore, "extraPlaceholderPatterns array unchanged");
  assert.equal(ctry.extraPlaceholderPatterns, patterns, "same array reference, not replaced");
});

test("[purity] validateRecord works on a deep-frozen input", () => {
  const input = {
    record: venueRecord({ coordinates: { latitude: 44.8, longitude: 20.45 } }),
    scope: scope({ bounds: RS_BOUNDS }),
    country: country({ extraPlaceholderPatterns: ["^tba$"] }),
  };
  const deepFreeze = (o: unknown): void => {
    if (o && typeof o === "object") {
      Object.values(o).forEach(deepFreeze);
      Object.freeze(o);
    }
  };
  deepFreeze(input);
  assert.equal(validateRecord(input).outcome, "ok");
});

// ── the `ok` result is a shared singleton — callers must treat it as read-only ──
test("[characterization] a passing result equals the canonical `ok` shape (shared singleton; treat ValidationResult as immutable)", () => {
  const r = v({});
  assert.deepEqual(r, { outcome: "ok", reasonCode: null, reasons: [] });
  // `ok` is a module const (unlike `reject`/`review`, which are factories). Every
  // current caller (engine.ts, change-detection.ts) only READS `.outcome` /
  // `.reasonCode`, so the sharing is safe; a future caller that needs to mutate
  // `reasons` must switch `ok` to a factory.
  assert.equal(v({}) === v({}), true, "same object instance is returned for every `ok`");
});
