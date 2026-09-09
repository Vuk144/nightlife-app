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
