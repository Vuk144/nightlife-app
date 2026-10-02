/**
 * `../../src/sync/event-venue-match.ts` — event venue hint → an EXISTING
 * canonical venue (matched / review / unresolved). Deterministic: in-memory
 * venues, the in-memory store and the fake Supabase; no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseGigstixEventRecord } from "../../src/sync/adapters/gigstix-event.ts";
import { InMemoryConfigProvider, DEFAULT_RECONCILIATION, type CityConfig } from "../../src/sync/config.ts";
import { matchEventVenue, matchEventVenueInStore, type EventVenueMatchInput } from "../../src/sync/event-venue-match.ts";
import { serbianProfile } from "../../src/sync/normalization.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import type { VenueLinkHint } from "../../src/sync/types.ts";
import { FakeSupabase } from "./fake-supabase.ts";

const BELGRADE = { countryCode: "RS", cityName: "Belgrade" };
const NOVI_SAD = { countryCode: "RS", cityName: "Novi Sad" };

function venue(over: Partial<CanonicalVenue> & { id: string; name: string }): CanonicalVenue {
  return {
    cityId: "city-bg",
    cityName: "Belgrade",
    countryCode: "RS",
    normalizedName: serbianProfile.normalizeName(over.name),
    address: null,
    coordinates: null,
    coordinatesSource: null,
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
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function hint(over: Partial<VenueLinkHint> = {}): VenueLinkHint {
  return { name: "Drugstore", sourceVenueId: "drugstore", address: null, coordinates: null, cityText: "Beograd", ...over };
}

const match = (over: Partial<EventVenueMatchInput>) =>
  matchEventVenue({
    sourceKey: "gigstix",
    hint: hint(),
    city: BELGRADE,
    venues: [],
    normalizeName: serbianProfile.normalizeName,
    ...over,
  });

// ── matched ─────────────────────────────────────────────────────────────
test("1. exact GIGS source venue identity → matched (tier 0)", () => {
  const r = match({ venues: [venue({ id: "v-ds", name: "Drugstore", sourceKey: "gigstix", externalId: "drugstore" })] });
  assert.deepEqual({ status: r.status, id: r.status === "matched" && r.venueId, tier: r.status === "matched" && r.tier }, {
    status: "matched",
    id: "v-ds",
    tier: 0,
  });
});

test("2. exact source identity wins even when the display names differ", () => {
  const r = match({
    hint: hint({ name: "Drugstore" }),
    venues: [venue({ id: "v-ds", name: "Klub Drugstore Beograd", sourceKey: "gigstix", externalId: "drugstore" })],
  });
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.deepEqual([r.venueId, r.tier], ["v-ds", 0]);
});

test("3. same normalized name in the same city → matched (tier 2)", () => {
  // no source link yet; "DRUGSTORE" normalizes to the same key as "Drugstore"
  const r = match({ venues: [venue({ id: "v-ds", name: "DRUGSTORE", sourceKey: "OpenStreetMap", externalId: "node/1" })] });
  assert.equal(r.status, "matched");
  if (r.status === "matched") assert.deepEqual([r.venueId, r.tier], ["v-ds", 2]);
});

test("existing Serbian name normalization applies (Cyrillic ↔ Latin transliteration)", () => {
  const r = match({ hint: hint({ name: "Бродарац", sourceVenueId: null }), venues: [venue({ id: "v-b", name: "Brodarac" })] });
  assert.equal(r.status, "matched");
});

// ── city scope ──────────────────────────────────────────────────────────
test("5. a same-named venue in another city is never selected", () => {
  const venues = [
    venue({ id: "v-ns", name: "Drugstore", cityId: "city-ns", cityName: "Novi Sad" }),
    venue({ id: "v-bg", name: "Drugstore" }),
  ];
  const inNoviSad = match({ city: NOVI_SAD, venues });
  assert.equal(inNoviSad.status === "matched" && inNoviSad.venueId, "v-ns");
  const inBelgrade = match({ city: BELGRADE, venues });
  assert.equal(inBelgrade.status === "matched" && inBelgrade.venueId, "v-bg");
  // only the other city has it → unresolved, not a cross-city match
  const onlyElsewhere = match({ city: BELGRADE, venues: [venues[0]] });
  assert.equal(onlyElsewhere.status, "unresolved");
  // a source-identity link in ANOTHER city is not used either
  const linkedElsewhere = match({
    city: BELGRADE,
    venues: [venue({ id: "v-ns", name: "Drugstore NS", cityId: "city-ns", cityName: "Novi Sad", sourceKey: "gigstix", externalId: "drugstore" })],
  });
  assert.equal(linkedElsewhere.status, "unresolved");
});

test("an unresolved city matches nothing, even with an exact name", () => {
  const r = match({ city: null, venues: [venue({ id: "v-ds", name: "Drugstore" })] });
  assert.deepEqual(r, { status: "unresolved", reasonCode: "city-unresolved", note: r.note });
});

// ── review ──────────────────────────────────────────────────────────────
test("6. two plausible venues in the same city → review with both candidates, none chosen", () => {
  const r = match({
    hint: hint({ sourceVenueId: null }),
    venues: [venue({ id: "v-1", name: "Drugstore" }), venue({ id: "v-2", name: "DRUGSTORE" }), venue({ id: "v-3", name: "Other" })],
  });
  assert.equal(r.status, "review");
  if (r.status === "review") {
    assert.equal(r.reasonCode, "venue-ambiguous");
    assert.deepEqual(r.candidates, [{ id: "v-1", name: "Drugstore" }, { id: "v-2", name: "DRUGSTORE" }]);
  }
});

test("a curated alias beyond its distance guard is review, not a silent match (existing alias table)", () => {
  // `../aliases.ts`: "dragstor" (Драгстор) → "Drugstore" in Belgrade
  const drugstore = venue({ id: "v-ds", name: "Drugstore", coordinates: { latitude: 44.8185264, longitude: 20.488357 } });
  const near = match({ hint: hint({ name: "Драгстор", sourceVenueId: null, coordinates: { latitude: 44.8190, longitude: 20.4890 } }), venues: [drugstore] });
  assert.equal(near.status === "matched" && near.tier, 3, "within 300 m: a confident alias link");
  const farish = match({ hint: hint({ name: "Драгстор", sourceVenueId: null, coordinates: { latitude: 44.8225, longitude: 20.4884 } }), venues: [drugstore] });
  assert.equal(farish.status, "review", "~450 m: the matcher flags it for review");
  if (farish.status === "review") {
    assert.equal(farish.reasonCode, "venue-alias-beyond-guard");
    assert.deepEqual(farish.candidates, [{ id: "v-ds", name: "Drugstore" }]);
  }
});

// ── unresolved ──────────────────────────────────────────────────────────
test("7. no candidate → unresolved (no venue is created, no id invented)", () => {
  const r = match({ venues: [venue({ id: "v-x", name: "Something else" })] });
  assert.equal(r.status, "unresolved");
  if (r.status === "unresolved") assert.equal(r.reasonCode, "no-existing-venue");
});

test("8. no venue name AND no source venue id → unresolved", () => {
  for (const h of [undefined, hint({ name: "", sourceVenueId: null }), hint({ name: "  ", sourceVenueId: "  " })]) {
    const r = match({ hint: h, venues: [venue({ id: "v-ds", name: "Drugstore" })] });
    assert.equal(r.status === "unresolved" && r.reasonCode, "no-venue-identity");
  }
});

test("a name that only differs after an OSM rename is NOT forced: Latin 'Drugstore' vs stored Cyrillic 'Драгстор'", () => {
  // Real data since the OSM name took over: the canonical row is "Драгстор"
  // (normalized "dragstor"); GIGS says "Drugstore". No exact name, no alias in
  // that direction, no source link → unresolved rather than a guess.
  const r = match({ venues: [venue({ id: "v-ds", name: "Драгстор", sourceKey: "OpenStreetMap", externalId: "node/5302622223" })] });
  assert.equal(r.status, "unresolved");
});

test("9. a canonical venue id is returned ONLY for a confident match", () => {
  const outcomes = [
    match({ venues: [venue({ id: "v-ds", name: "Drugstore" })] }),
    match({ hint: hint({ sourceVenueId: null }), venues: [venue({ id: "v-1", name: "Drugstore" }), venue({ id: "v-2", name: "Drugstore" })] }),
    match({ venues: [] }),
    match({ city: null, venues: [venue({ id: "v-ds", name: "Drugstore" })] }),
  ];
  assert.deepEqual(outcomes.map((o) => o.status), ["matched", "review", "unresolved", "unresolved"]);
  for (const o of outcomes) assert.equal("venueId" in o, o.status === "matched", o.status);
});

// ── store adapter: config city resolution, read-only ────────────────────
function config(belgradeAliases: string[]) {
  const city = (canonicalName: string, nameAliases: string[]): CityConfig => ({
    countryCode: "RS",
    canonicalName,
    enabled: true,
    eventFirstEnabled: false,
    timeZone: "Europe/Belgrade",
    nameAliases,
    bounds: null,
    sourceScope: {},
  });
  return new InMemoryConfigProvider({
    countries: [{ code: "RS", name: "Serbia", enabled: true, defaultTimeZone: "Europe/Belgrade", bounds: null, normalizationProfile: "sr", extraPlaceholderPatterns: [] }],
    cities: [city("Belgrade", belgradeAliases), city("Novi Sad", [])],
    sources: [],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  });
}

const INTERCELL = readFileSync(new URL("../events/fixtures/gigstix-event-intercell.html", import.meta.url), "utf8");
function intercellRecord() {
  const r = parseGigstixEventRecord(INTERCELL, "https://new.gigstix.com/event/intercell-with-dvs1/", { fetchedAt: "2026-09-27T00:00:00.000Z" });
  assert.ok(r.ok);
  return r.record; // venue hint: "Drugstore" / "drugstore" / "Beograd"
}
const CITIES = [
  { id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: null },
  { id: "city-ns", countryCode: "RS", name: "Novi Sad", timeZone: null },
];

test("4. GIGS 'Beograd' resolves to Belgrade through the existing config city aliases, then matches", async () => {
  const store = new InMemoryCanonicalStore({
    cities: CITIES,
    venues: [venue({ id: "v-ds", name: "Drugstore" }), venue({ id: "v-ns", name: "Drugstore", cityId: "city-ns", cityName: "Novi Sad" })],
  });
  const r = await matchEventVenueInStore(intercellRecord(), { config: config(["beograd"]), store });
  assert.equal(r.status === "matched" && r.venueId, "v-ds");

  // without that alias in config, "Beograd" is not guessed to be Belgrade
  const unaliased = await matchEventVenueInStore(intercellRecord(), { config: config([]), store });
  assert.equal(unaliased.status === "unresolved" && unaliased.reasonCode, "city-unresolved");
});

test("10. matching never creates or writes anything (in-memory store and fake Supabase)", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [venue({ id: "v-x", name: "Unrelated" })] });
  const r = await matchEventVenueInStore(intercellRecord(), { config: config(["beograd"]), store });
  assert.equal(r.status, "unresolved");
  assert.deepEqual(store.venues.map((v) => v.id), ["v-x"], "no venue created");
  assert.deepEqual(store.applied, [], "apply never called");

  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }]);
  fake.seed("venues", [
    { id: "v-ds", city_id: "city-bg", name: "Drugstore", name_normalized: "drugstore", source_id: "ds-osm", external_id: "node/1", is_active: true, created_at: "x", updated_at: "x" },
  ]);
  const supa = await matchEventVenueInStore(intercellRecord(), { config: config(["beograd"]), store: new SupabaseCanonicalStore(fake.asClient()) });
  assert.equal(supa.status === "matched" && supa.venueId, "v-ds");
  assert.deepEqual(fake.writes, [], "zero writes through the real store");
  assert.equal(fake.tables.venues.length, 1);
  assert.equal(fake.tables.data_sources.length, 1, "no gigstix data_sources row created either");
});
