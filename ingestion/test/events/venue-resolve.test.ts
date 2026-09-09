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

// ═══════════════════════════════════════════════════════════════════════
//  CHARACTERIZATION (pre-decomposition lock)
//
//  These tests do NOT add requirements. They pin the CURRENT observable
//  behavior of `resolve()` — especially the shared `make()` result shape and
//  the subtle match/enrich/code-gathering branches — so a later readability
//  decomposition of this ~240-line function is provably behavior-preserving.
// ═══════════════════════════════════════════════════════════════════════

const EV_URL = "https://new.gigstix.com/event/x/";

// ── the full resolution object for each of the four statuses ──────────

test("[char] full resolution shape — matched_existing (Tier 2, DB coordinates_source passed through)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Drugstore", sourceVenueId: "drugstore", city: "Beograd" }),
    "primary",
  );
  assert.deepEqual(res, {
    status: "matched_existing",
    reasonCode: "matched-tier-2",
    reason: 'matched existing venue "Drugstore" (tier 2)',
    reasonCodes: ["matched-tier-2"],
    proposedName: "Drugstore",
    normalizedName: "drugstore",
    city: "Belgrade",
    cityKnown: true,
    cityEnabled: true,
    address: null,
    latitude: 44.8185264,
    longitude: 20.488357,
    coordinatesSource: "manual", // NOTE: field type is `"source" | null`; the
    // matched-venue branch passes the existing row's `coordinates_source`
    // through verbatim. Not consumed downstream (event-first ignores matched
    // resolutions). Locked as-is.
    sourceVenueId: "drugstore",
    locationConfidence: "coordinates",
    matchedVenueId: "v-drugstore",
    matchTier: 2,
    matchNote: null,
    eventRelevanceTier: "primary",
    provenance: {
      dataSource: "gigstix",
      externalVenueId: "drugstore",
      sourceUrl: EV_URL,
      venuePageUrl: null,
    },
    candidateKey: "venue:v-drugstore",
    event: { title: "Night", url: EV_URL },
  });
});

test("[char] full resolution shape — safe_new_venue (enriched coordinates)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
    "primary",
  );
  assert.deepEqual(res, {
    status: "safe_new_venue",
    reasonCode: "safe-new-venue",
    reason:
      'no existing match; trusted source, city "Belgrade" enabled, coordinates available',
    reasonCodes: ["safe-new-venue"],
    proposedName: "Barutana BG",
    normalizedName: "barutana bg",
    city: "Belgrade",
    cityKnown: true,
    cityEnabled: true,
    address: "Beogradska tvrđava, Kalemegdan",
    latitude: 44.8238974,
    longitude: 20.4474708,
    coordinatesSource: "source",
    sourceVenueId: "barutana-bg",
    locationConfidence: "coordinates",
    matchedVenueId: null,
    matchTier: null,
    matchNote: null,
    eventRelevanceTier: "primary",
    provenance: {
      dataSource: "gigstix",
      externalVenueId: "4710",
      sourceUrl: EV_URL,
      venuePageUrl: "https://new.gigstix.com/venue/barutana-bg/",
    },
    candidateKey: "svid:gigstix:barutana-bg",
    event: { title: "Night", url: EV_URL },
  });
});

test("[char] full resolution shape — needs_review (untrusted source)", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ sourceTrusted: false, fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
    "primary",
  );
  assert.deepEqual(res, {
    status: "needs_review",
    reasonCode: "source-not-trusted",
    reason: "event-first candidate needs review: source-not-trusted",
    reasonCodes: ["source-not-trusted"],
    proposedName: "Barutana BG",
    normalizedName: "barutana bg",
    city: "Belgrade",
    cityKnown: true,
    cityEnabled: true,
    address: "Beogradska tvrđava, Kalemegdan",
    latitude: 44.8238974,
    longitude: 20.4474708,
    coordinatesSource: "source",
    sourceVenueId: "barutana-bg",
    locationConfidence: "coordinates",
    matchedVenueId: null,
    matchTier: null,
    matchNote: null,
    eventRelevanceTier: "primary",
    provenance: {
      dataSource: "gigstix",
      externalVenueId: "4710",
      sourceUrl: EV_URL,
      venuePageUrl: "https://new.gigstix.com/venue/barutana-bg/",
    },
    candidateKey: "svid:gigstix:barutana-bg",
    event: { title: "Night", url: EV_URL },
  });
});

test("[char] full resolution shape — rejected (placeholder), + the other rejection codes", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts(),
  );
  const res = await r.resolve(ev({ name: "TBA", city: "Beograd" }), "primary");
  assert.deepEqual(res, {
    status: "rejected",
    reasonCode: "placeholder-na",
    reason: 'venue name "TBA" is a placeholder / non-venue',
    reasonCodes: ["placeholder-na"],
    proposedName: "TBA",
    normalizedName: "tba",
    city: "Belgrade",
    cityKnown: true,
    cityEnabled: true,
    address: null,
    latitude: null,
    longitude: null,
    coordinatesSource: null,
    sourceVenueId: null,
    locationConfidence: "none",
    matchedVenueId: null,
    matchTier: null,
    matchNote: null,
    eventRelevanceTier: "primary",
    provenance: {
      dataSource: "gigstix",
      externalVenueId: null,
      sourceUrl: EV_URL,
      venuePageUrl: null,
    },
    candidateKey: "nc:Belgrade:tba",
    event: { title: "Night", url: EV_URL },
  });

  // the name-gate order: empty-normalized-name and name-too-short reject
  // BEFORE the city check. `empty-normalized-name` needs a whitespace-only name
  // (a raw "" venue name never reaches resolve — engine.ts gates on it), and
  // note `computeNameNormalized` falls back to the raw string, so a punctuation
  // name like "!!!" does NOT normalize to empty.
  const empty = await r.resolve(ev({ name: "   ", city: "Beograd" }), "primary");
  assert.equal(empty.reasonCode, "empty-normalized-name");
  assert.equal(empty.status, "rejected");

  const short = await r.resolve(ev({ name: "X", city: "Beograd" }), "primary");
  assert.equal(short.reasonCode, "name-too-short");
  assert.equal(short.status, "rejected");

  // an unanchored keyword still catches online
  const webinar = await r.resolve(ev({ name: "Weekly Webinar Series", city: "Beograd" }), "primary");
  assert.equal(webinar.reasonCode, "online-event");
});

// ── Tier 0 — exact source identity re-import ─────────────────────────

test("[char] Tier 0 match — venue already linked to this source key + external id", async () => {
  const linked = venueRow({
    id: "v-linked",
    name: "Renamed On Source",
    name_normalized: "renamed on source",
    source_id: "gigstix-dry-run", // == `${sourceKey}-dry-run`
    external_id: "drugstore", // == the event's sourceVenueId
  });
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [linked] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  const res = await r.resolve(
    ev({ name: "Totally Different Label", sourceVenueId: "drugstore", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "matched_existing");
  assert.equal(res.matchTier, 0);
  assert.equal(res.reasonCode, "matched-tier-0");
  assert.equal(res.matchedVenueId, "v-linked");
  assert.equal(res.candidateKey, "venue:v-linked");
});

// ── the enrichment / Pass-2 re-match gate ────────────────────────────

test("[char] enriched venue-page name unrelated to the event name -> Pass 2 skipped, enriched LOCATION still used, proposedName stays the event name", async () => {
  const unrelated: SourceVenue = {
    externalId: "u-1",
    sourceUrl: "https://new.gigstix.com/venue/mystery/",
    name: "Zzz Totally Other",
    address: null,
    latitude: 44.81,
    longitude: 20.46,
    city: null,
  };
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: (id) => Promise.resolve(id === "mystery-hall" ? unrelated : null) }),
  );
  const res = await r.resolve(
    ev({ name: "Mystery Hall", sourceVenueId: "mystery-hall", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "safe_new_venue");
  assert.equal(res.proposedName, "Mystery Hall"); // NOT "Zzz Totally Other"
  assert.equal(res.normalizedName, "mystery hall");
  assert.equal(res.latitude, 44.81); // enriched location IS adopted
  assert.equal(res.coordinatesSource, "source");
  assert.equal(res.candidateKey, "svid:gigstix:mystery-hall");
});

test("[char] curated alias whose canonical venue is NOT in the DB -> needs_review with matcher-flagged-review + the alias note", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }), // no Drugstore seeded
    opts(),
  );
  const res = await r.resolve(
    ev({ name: "Dragstor", sourceVenueId: "dragstor-x", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "needs_review");
  assert.ok(res.reasonCodes.includes("matcher-flagged-review"));
  assert.equal(res.reasonCode, "matcher-flagged-review");
  assert.match(res.matchNote ?? "", /Drugstore/);
});

test("[char] curated alias + enriched coords 300-1000 m from the canonical -> matched_existing Tier 3; the matcher review flag is surfaced ONLY via matchNote (current behavior)", async () => {
  const page: SourceVenue = {
    externalId: "d-99",
    sourceUrl: "https://new.gigstix.com/venue/dragstor/",
    name: "Dragstor", // normalizes to "dragstor" -> Tier 2 misses, alias hits
    address: "Kod nekog mesta",
    latitude: 44.8235, // ~550 m north of DRUGSTORE (44.8185264, 20.488357)
    longitude: 20.488,
    city: "Beograd",
  };
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: (id) => Promise.resolve(id === "dragstor-y" ? page : null) }),
  );
  const res = await r.resolve(
    ev({ name: "Dragstor", sourceVenueId: "dragstor-y", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "matched_existing");
  assert.equal(res.matchTier, 3);
  assert.equal(res.matchedVenueId, "v-drugstore");
  assert.deepEqual(res.reasonCodes, ["matched-tier-3"]);
  assert.ok(!res.reasonCodes.includes("matcher-flagged-review"));
  assert.match(res.matchNote ?? "", /over the 300 m guard/);
});

// ── code gathering: generic name, out-of-region coords ───────────────

test("[char] single-token generic venue name -> generic-venue-name; candidateKey is nca:/nc: by presence of address", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts(),
  );
  const withAddr = await r.resolve(
    ev({ name: "Klub", city: "Beograd", address: "Nemanjina 4" }),
    "primary",
  );
  assert.equal(withAddr.status, "needs_review");
  assert.equal(withAddr.reasonCode, "generic-venue-name");
  assert.ok(withAddr.reasonCodes.includes("generic-venue-name"));
  assert.equal(withAddr.candidateKey, "nca:Belgrade:klub:nemanjina");

  const noAddr = await r.resolve(ev({ name: "Klub", city: "Beograd" }), "primary");
  assert.equal(noAddr.candidateKey, "nc:Belgrade:klub");
  assert.ok(noAddr.reasonCodes.includes("generic-venue-name"));
  assert.ok(noAddr.reasonCodes.includes("location-confidence-insufficient"));
});

test("[char] enriched coordinates outside the Serbia bounding box -> coordinates-out-of-region", async () => {
  const vienna: SourceVenue = {
    externalId: "vie-1",
    sourceUrl: "https://new.gigstix.com/venue/vie/",
    name: "Bec Mesto",
    address: null,
    latitude: 48.2082, // Vienna — outside 42.0..46.3 / 18.7..23.1
    longitude: 16.3738,
    city: null,
  };
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [] }),
    opts({ fetchSourceVenue: (id) => Promise.resolve(id === "vie" ? vienna : null) }),
  );
  const res = await r.resolve(
    ev({ name: "Bec Mesto", sourceVenueId: "vie", city: "Beograd" }),
    "primary",
  );
  assert.equal(res.status, "needs_review");
  assert.ok(res.reasonCodes.includes("coordinates-out-of-region"));
  assert.equal(res.latitude, 48.2082);
});

// ── city derivation ─────────────────────────────────────────────────

test("[char] deriveCity: event.venue.city is tried before reported.citySlug", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE, NOVI_SAD], venues: [] }),
    opts({ enabledCities: ["Belgrade", "Novi Sad"] }),
  );
  const res = await r.resolve(
    ev({ name: "Neko Mesto", city: "Beograd" }, { reported: { citySlug: "novi-sad" } }),
    "primary",
  );
  assert.equal(res.city, "Belgrade");
  assert.equal(res.cityKnown, true);
});

test("[char] matchCityText resolves a non-aliased city by de-accented, case-folded normalized equality", async () => {
  const KRALJEVO = { id: "c-kv", name: "Kraljevo", country_id: "RS" };
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [KRALJEVO], venues: [] }),
    opts({ enabledCities: ["Kraljevo"] }),
  );
  const res = await r.resolve(ev({ name: "Neko Mesto", city: "KRALJEVO" }), "primary");
  assert.equal(res.city, "Kraljevo");
  assert.equal(res.cityKnown, true);
});

// ── enrichment robustness + determinism ──────────────────────────────

test("[char] fetchSourceVenue throwing is swallowed — resolution proceeds as if enrichment returned nothing", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({
      fetchSourceVenue: () => {
        throw new Error("boom");
      },
    }),
  );
  let res: Awaited<ReturnType<typeof r.resolve>>;
  await assert.doesNotReject(async () => {
    res = await r.resolve(
      ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" }),
      "primary",
    );
  });
  assert.equal(res!.status, "needs_review");
  assert.ok(res!.reasonCodes.includes("location-confidence-insufficient"));
  assert.equal(res!.latitude, null);
});

test("[char] determinism — same event resolves identically; enrichment is fetched once and cached", async () => {
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
  const event = ev({ name: "Barutana BG", sourceVenueId: "barutana-bg", city: "Beograd" });
  const a = await r.resolve(event, "primary");
  const b = await r.resolve(event, "primary");
  assert.deepEqual(a, b);
  assert.equal(fetched, 1, "the venue page is fetched once per source venue id, then cached");

  // a fresh resolver over identical data produces the identical resolution
  const r2 = await createVenueResolver(
    readOnlySupabase({ cities: [BELGRADE], venues: [DRUGSTORE] }),
    opts({ fetchSourceVenue: fetchStub }),
  );
  assert.deepEqual(await r2.resolve(event, "primary"), a);
});

// ── public accessors ────────────────────────────────────────────────

test("[char] knownCities = cities that have >=1 venue (sorted); enabledCities = sorted copy of the option", async () => {
  const r = await createVenueResolver(
    readOnlySupabase({ cities: [NOVI_SAD, BELGRADE], venues: [DRUGSTORE] }),
    opts({ enabledCities: ["Novi Sad", "Belgrade"] }),
  );
  assert.deepEqual(r.knownCities, ["Belgrade"]);
  assert.deepEqual(r.enabledCities, ["Belgrade", "Novi Sad"]);
});
