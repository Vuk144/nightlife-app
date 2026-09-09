import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createVenueResolver,
  type VenueResolverOptions,
} from "../../src/events/venue-resolve.ts";
import type { NormalizedEvent, SourceVenue } from "../../src/events/types.ts";

/**
 * Read-only fake: `.from(t).select(...).in(...)` resolves to `{ data, error }`.
 * Any write method (`insert`/`update`/`upsert`/`delete`/`rpc`) throws — the
 * resolver must never call one.
 */
function readOnlySupabase(tables: Record<string, unknown[]>): SupabaseClient {
  const guard = (name: string) => () => {
    throw new Error(`WRITE ATTEMPTED: ${name}`);
  };
  return {
    rpc: guard("rpc"),
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        then: (resolve: (r: { data: unknown[]; error: null }) => void) =>
          resolve({ data: tables[table] ?? [], error: null }),
        insert: guard("insert"),
        update: guard("update"),
        upsert: guard("upsert"),
        delete: guard("delete"),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const BELGRADE = { id: "city-bg", name: "Belgrade", country_id: "RS" };
const NOVI_SAD = { id: "city-ns", name: "Novi Sad", country_id: "RS" };

function venueRow(o: Partial<Record<string, unknown>> & { id: string; name: string }) {
  return {
    name_normalized: null,
    source_id: null,
    external_id: null,
    source_url: null,
    latitude: null,
    longitude: null,
    coordinates_source: null,
    address: null,
    website: null,
    opening_hours: null,
    wikidata: null,
    city_id: "city-bg",
    ...o,
  };
}

const DRUGSTORE = venueRow({
  id: "v-drugstore",
  name: "Drugstore",
  name_normalized: "drugstore",
  latitude: 44.8185264,
  longitude: 20.488357,
  coordinates_source: "manual",
});
const KST = venueRow({
  id: "v-kst",
  name: "KST",
  name_normalized: "kst",
  latitude: 44.8055631,
  longitude: 20.4762304,
  coordinates_source: "manual",
});

function ev(
  venue: Partial<NormalizedEvent["venue"]>,
  rest: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return {
    externalId: "1",
    sourceUrl: "https://new.gigstix.com/event/x/",
    title: "Night",
    startLocal: "2026-10-30T23:00",
    startPrecision: "datetime",
    venue: { name: "Venue", ...venue },
    reported: { citySlug: "beograd" },
    ...rest,
  };
}

function opts(over: Partial<VenueResolverOptions> = {}): VenueResolverOptions {
  return {
    countryIds: ["RS"],
    sourceKey: "gigstix",
    sourceTrusted: true,
    enabledCities: ["Belgrade"],
    ...over,
  };
}

const SOURCE_VENUE: Record<string, SourceVenue> = {
  "barutana-bg": {
    externalId: "4710",
    sourceUrl: "https://new.gigstix.com/venue/barutana-bg/",
    name: "Barutana BG",
    address: "Beogradska tvrđava, Kalemegdan",
    latitude: 44.8238974,
    longitude: 20.4474708,
    city: "Beograd",
  },
  "dorcol-platz-noco": {
    externalId: "5538",
    sourceUrl: "https://new.gigstix.com/venue/dorcol-platz/",
    name: "Dorćol Platz",
    address: "Dobračina 59",
    latitude: null,
    longitude: null,
    city: "Beograd",
  },
  kst: {
    externalId: "9001",
    sourceUrl: "https://new.gigstix.com/venue/kst/",
    name: "Klub studenata tehnike",
    address: "Bulevar kralja Aleksandra 73",
    latitude: 44.8056,
    longitude: 20.4762,
    city: "Beograd",
  },
};

const fetchStub = (id: string): Promise<SourceVenue | null> =>
  Promise.resolve(SOURCE_VENUE[id] ?? null);

// ---- 1. existing venue exact match --------------------------------------
test("existing venue exact name match -> matched_existing (tier 2), no enrichment fetch", async () => {
  let fetched = 0;
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({
      fetchSourceVenue: (id) => {
        fetched++;
        return fetchStub(id);
      },
    }),
  );
  const res = await r.resolve(ev({ name: "Drugstore", sourceVenueId: "drugstore", city: "Beograd" }), "primary");
  assert.equal(res.status, "matched_existing");
  assert.equal(res.matchTier, 2);
  assert.equal(res.matchedVenueId, "v-drugstore");
  assert.equal(fetched, 0, "a clean name match must not fetch the venue page");
});

// ---- 2. existing venue via alias + matcher ----------------------------
test("existing venue via curated alias + Tier 3 proximity (enriched coords)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [KST] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Klub Studenata Tehnike", sourceVenueId: "kst", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "matched_existing");
  assert.equal(res.matchedVenueId, "v-kst");
  assert.ok(res.matchTier != null && res.matchTier >= 2);
});

// ---- 3. safe new venue with coordinates ------------------------------
test("no match + trusted source + enabled city + coordinates -> safe_new_venue", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "safe_new_venue");
  assert.equal(res.locationConfidence, "coordinates");
  assert.equal(res.latitude, 44.8238974);
  assert.equal(res.coordinatesSource, "source");
  assert.equal(res.city, "Belgrade");
  assert.equal(res.provenance.dataSource, "gigstix");
  assert.equal(res.provenance.externalVenueId, "4710");
});

// ---- 4. safe new venue with address, no coordinates ----------------
test("no match + address but no coordinates -> safe_new_venue (address confidence)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Dorćol Platz", sourceVenueId: "dorcol-platz-noco", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "safe_new_venue");
  assert.equal(res.locationConfidence, "address");
  assert.equal(res.address, "Dobračina 59");
  assert.equal(res.latitude, null);
});

// ---- 5. missing city ------------------------------------------------
test("no city information at all -> rejected (city-missing)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts(),
  );
  const res = await r.resolve(
    ev({ name: "Neki Klub", sourceVenueId: "x" }, { reported: {} }),
    "primary",
  );
  assert.equal(res.status, "rejected");
  assert.equal(res.reasonCode, "city-missing");
});

// ---- 6. unknown city ---------------------------------------------
test("city stated but not in the venue DB -> needs_review (city-unknown)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts(),
  );
  const res = await r.resolve(
    ev({ name: "Neki Klub", city: "Vršac" }, { reported: { citySlug: "vrsac" } }),
    "primary",
  );
  assert.equal(res.status, "needs_review");
  assert.equal(res.reasonCode, "city-unknown");
});

// ---- 7. placeholder venue name -------------------------------
test("placeholder venue names -> rejected", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts(),
  );
  for (const [name, code] of [
    ["TBA", "placeholder-na"],
    ["Various Locations", "placeholder-various-locations"],
    ["Više lokacija", "placeholder-various-locations"],
    ["Unknown", "placeholder-unknown"],
    ["Location TBD", "placeholder-to-be-announced"],
  ] as const) {
    const res = await r.resolve(ev({ name, city: "Beograd" }), "primary");
    assert.equal(res.status, "rejected", `${name} should be rejected`);
    assert.equal(res.reasonCode, code, name);
  }
});

// ---- 8. online event -----------------------------------------
test("online event 'venue' -> rejected (online-event)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts(),
  );
  for (const name of ["Online", "Online Event", "Livestream", "YouTube"]) {
    const res = await r.resolve(ev({ name, city: "Beograd" }), "primary");
    assert.equal(res.status, "rejected", name);
    assert.equal(res.reasonCode, "online-event", name);
  }
});

// ---- 9. ambiguous existing venue ---------------------------
test("two existing venues share name_normalized -> needs_review (ambiguous)", async () => {
  const twinA = venueRow({ id: "a", name: "Twin", name_normalized: "twin" });
  const twinB = venueRow({ id: "b", name: "Twin", name_normalized: "twin" });
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [twinA, twinB] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(ev({ name: "Twin", city: "Beograd" }), "primary");
  assert.equal(res.status, "needs_review");
  assert.equal(res.reasonCode, "ambiguous-existing-match");
});

// ---- 11. missing source venue id ------------------------
test("no source venue id + no venue page -> needs_review (location-confidence-insufficient)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(ev({ name: "Some Brand New Place", city: "Beograd" }), "primary");
  assert.equal(res.status, "needs_review");
  assert.ok(res.reasonCodes.includes("location-confidence-insufficient"));
  assert.equal(res.candidateKey, "nc:Belgrade:some brand new place");
});

// ---- 12 & 13. trusted vs untrusted source ------------
test("trusted source -> safe; untrusted source -> needs_review (source-not-trusted)", async () => {
  const trusted = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ sourceTrusted: true, fetchSourceVenue: fetchStub }),
  );
  const a = await trusted.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
    "primary",
  );
  assert.equal(a.status, "safe_new_venue");

  const untrusted = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ sourceTrusted: false, fetchSourceVenue: fetchStub }),
  );
  const b = await untrusted.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
    "primary",
  );
  assert.equal(b.status, "needs_review");
  assert.ok(b.reasonCodes.includes("source-not-trusted"));
});

// ---- secondary relevance is review-only, not safe ------------
test("secondary relevance tier -> needs_review (secondary-relevance-only)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
    "secondary",
  );
  assert.equal(res.status, "needs_review");
  assert.ok(res.reasonCodes.includes("secondary-relevance-only"));
});

// ---- city not enabled for event-first creation ---------------
test("new venue in a known but not-enabled city -> needs_review (city-not-enabled)", async () => {
  const nsVenue = venueRow({ id: "v-ns", name: "GIGS", name_normalized: "gigs", city_id: "city-ns" });
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE, NOVI_SAD], venues: [nsVenue] }),
    opts({ enabledCities: ["Belgrade"], fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "SKCNS Fabrika", sourceVenueId: "skcns-fabrika", city: "Novi Sad" }, { reported: { citySlug: "novi-sad" } }),
    "primary",
  );
  assert.equal(res.status, "needs_review");
  assert.ok(res.reasonCodes.includes("city-not-enabled"));
});

// ---- 15 & 16. no event-frequency requirement ---------------
test("a venue seen in only ONE event is still safe_new_venue (frequency is never a filter)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  // single event, full location data
  const res = await r.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }, { externalId: "only-one" }),
    "primary",
  );
  assert.equal(res.status, "safe_new_venue");
  // nothing in the resolution references an event count / frequency
  assert.ok(!("eventCount" in res));
  assert.ok(!JSON.stringify(res).toLowerCase().includes("frequency"));
});

// ---- REGRESSIONS -----------------------------------------

// A venue page whose city is NOT in our cities table must not slip through as
// safe_new_venue with the (wrong) event-derived city label.
const KG_PAGE: SourceVenue = {
  externalId: "7777",
  sourceUrl: "https://new.gigstix.com/venue/barutana-kg/",
  name: "Barutana KG",
  address: "Kralja Petra 1",
  latitude: 44.0128, // Kragujevac — inside the Serbia bounding box
  longitude: 20.9114,
  city: "Kragujevac", // NOT a row in `cities`
};

test("[regression] venue page names an unknown city -> needs_review (venue-page-city-mismatch), not safe", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({
      fetchSourceVenue: (id) =>
        Promise.resolve(id === "barutana-kg" ? KG_PAGE : SOURCE_VENUE[id] ?? null),
    }),
  );

  const mismatch = await r.resolve(
    ev({ name: "Barutana KG", sourceVenueId: "barutana-kg", city: "Beograd" }),
    "primary",
  );
  assert.equal(mismatch.status, "needs_review");
  assert.ok(mismatch.reasonCodes.includes("venue-page-city-mismatch"));

  // control: a page whose city DOES resolve to the event's city stays safe
  const ok = await r.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
    "primary",
  );
  assert.equal(ok.status, "safe_new_venue");
  assert.ok(!ok.reasonCodes.includes("venue-page-city-mismatch"));
});

test("[regression] same-named venues in two DIFFERENT unknown cities get distinct candidateKeys", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts(),
  );
  const a = await r.resolve(
    ev({ name: "SKC" }, { reported: { citySlug: "kragujevac" } }),
    "primary",
  );
  const b = await r.resolve(
    ev({ name: "SKC" }, { reported: { citySlug: "subotica" } }),
    "primary",
  );
  assert.equal(a.reasonCode, "city-unknown");
  assert.equal(b.reasonCode, "city-unknown");
  assert.notEqual(a.candidateKey, b.candidateKey, "two unknown cities must not collide on nc:?:<name>");
  assert.equal(a.candidateKey, "nc:kragujevac:skc");
  assert.equal(b.candidateKey, "nc:subotica:skc");
});

// ---- no writes -------------------------------------------
test("resolver performs only reads — no write method is ever called", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE, KST] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  // exercise every branch
  await r.resolve(ev({ name: "Drugstore", sourceVenueId: "drugstore", city: "Beograd" }), "primary");
  await r.resolve(ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }), "primary");
  await r.resolve(ev({ name: "TBA", city: "Beograd" }), "primary");
  await r.resolve(ev({ name: "X", city: "Vršac" }, { reported: { citySlug: "vrsac" } }), "secondary");
  // reaching here without a "WRITE ATTEMPTED" throw is the assertion
  assert.ok(true);
});
