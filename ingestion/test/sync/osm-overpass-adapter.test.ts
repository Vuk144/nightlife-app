/**
 * `../../src/sync/adapters/osm-overpass.ts` — the OSM `SourceAdapter` for the
 * generic sync engine, and its `SyncConfig` builder.
 *
 * All fixture-driven: the Overpass transport is injected, so nothing here
 * touches the network or Supabase.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OSM_SOURCE_KEY,
  buildOsmSyncConfig,
  createOsmConfigProvider,
  createOsmOverpassAdapter,
  osmTargetRefId,
} from "../../src/sync/adapters/osm-overpass.ts";
import { planSync } from "../../src/sync/engine.ts";
import { InMemoryCanonicalStore, type CanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { FakeSupabase } from "./fake-supabase.ts";
import { parseOverpassVenues } from "../../src/sources/osm-overpass.ts";
import { computeNameNormalized } from "../../src/normalize.ts";
import type { Config } from "../../src/config.ts";
import type { IngestionTarget } from "../../src/targets.ts";
import type { OverpassElement, OverpassResponse } from "../../src/types.ts";
import type { AdapterContext, NormalizedRecord, SourceItemRef } from "../../src/sync/types.ts";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/overpass-belgrade.sample.json", import.meta.url), "utf8"),
) as OverpassResponse;
const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const NOW = "2026-09-26T00:00:00.000Z";
const CONFIG: Config = {
  supabaseUrl: "",
  supabaseServiceRoleKey: "",
  overpassUrl: "https://overpass.test/api/interpreter",
  overpassUserAgent: "osm-adapter-test",
};

function adapterFor(response: OverpassResponse, targets: IngestionTarget[] = [BELGRADE]) {
  const queries: string[] = [];
  const adapter = createOsmOverpassAdapter({
    targets,
    config: CONFIG,
    transport: async (query) => {
      queries.push(query);
      return response;
    },
    now: () => NOW,
  });
  return { adapter, queries };
}

function ctx(cities: string[]): AdapterContext {
  return {
    defaultCountryCode: "RS",
    defaultTimeZone: "Europe/Belgrade",
    scopeConfig: {},
    userAgent: "t",
    cities,
    limit: 0,
    verbose: false,
  };
}

async function refsOf(adapter: ReturnType<typeof adapterFor>["adapter"], cities: string[]): Promise<SourceItemRef[]> {
  const refs: SourceItemRef[] = [];
  for await (const ref of adapter.discover(ctx(cities))) refs.push(ref);
  return refs;
}

/** discover → fetch → parse for the Belgrade target, returning the records. */
async function recordsFor(response: OverpassResponse): Promise<NormalizedRecord[]> {
  const { adapter } = adapterFor(response);
  const [ref] = await refsOf(adapter, ["Belgrade"]);
  const parsed = adapter.parse(await adapter.fetch(ref, ctx(["Belgrade"])), ctx(["Belgrade"]));
  assert.ok(parsed.ok);
  return parsed.records;
}

const venueOf = (records: NormalizedRecord[], externalId: string) => {
  const r = records.find((x) => x.provenance.externalId === externalId);
  assert.ok(r && r.kind === "venue", `no venue record ${externalId}`);
  return r;
};

// ── mapping ──────────────────────────────────────────────────────────────
test("a valid OSM venue maps to a venue record: source key, external id, coordinates, normalized name, city/country", async () => {
  const records = await recordsFor(FIXTURE);
  const drugstore = venueOf(records, "node/1001");
  assert.equal(drugstore.provenance.sourceKey, "OpenStreetMap");
  assert.equal(OSM_SOURCE_KEY, "OpenStreetMap");
  assert.equal(drugstore.provenance.externalId, "node/1001");
  assert.equal(drugstore.provenance.sourceUrl, "https://www.openstreetmap.org/node/1001");
  assert.equal(drugstore.provenance.fetchedAt, NOW);
  assert.deepEqual(drugstore.scope, {
    countryCode: "RS",
    cityText: "Belgrade",
    coordinates: { latitude: 44.8185, longitude: 20.4884 },
  });
  assert.equal(drugstore.fields.name, "Drugstore");
  assert.equal(drugstore.fields.normalizedName, computeNameNormalized("Drugstore"));
  assert.deepEqual(drugstore.fields.coordinates, { latitude: 44.8185, longitude: 20.4884 });
  assert.equal(drugstore.fields.coordinatesSource, "source");
  assert.equal(drugstore.fields.website, "https://example.org/drugstore");
  assert.equal(drugstore.fields.wikidata, "Q3040577");
  assert.equal(drugstore.fields.openingHours, "Fr-Sa 23:00-06:00");
  // every record, not just one, carries the OSM identity and its target's city
  for (const r of records) {
    assert.equal(r.provenance.sourceKey, "OpenStreetMap");
    assert.match(r.provenance.externalId, /^(node|way|relation)\/\d+$/);
    assert.equal(r.scope.countryCode, "RS");
    assert.equal(r.scope.cityText, "Belgrade");
  }
});

test("exactly the parser's accepted venues become records — invalid and excluded elements never do", async () => {
  const records = await recordsFor(FIXTURE);
  const { venues, invalid, excluded } = parseOverpassVenues(FIXTURE, BELGRADE);
  assert.deepEqual(
    records.map((r) => r.provenance.externalId),
    venues.map((v) => v.externalId),
  );
  assert.ok(invalid.length > 0 && excluded.length > 0, "fixture must exercise both");
  const ids = new Set(records.map((r) => r.provenance.externalId));
  for (const e of [...invalid, ...excluded]) assert.ok(!ids.has(e.ref), `${e.ref} must not be a record`);
});

test("rescue / review classifier metadata is carried in provenance.reported", async () => {
  const records = await recordsFor(FIXTURE);
  const dom = venueOf(records, "way/41234985"); // accepted only via the Belgrade rescue list
  assert.deepEqual(dom.provenance.reported, {
    osmType: "way",
    osmId: 41234985,
    category: "concert_hall",
    acceptedVia: dom.provenance.reported.acceptedVia, // text owned by the classifier
    rescued: true,
    review: dom.provenance.reported.review,
  });
  // the flags match the parser's output for every venue, not just the rescued one
  const { venues } = parseOverpassVenues(FIXTURE, BELGRADE);
  for (const v of venues) {
    const r = venueOf(records, v.externalId);
    assert.equal(r.provenance.reported.rescued, v.rescued === true, v.externalId);
    assert.equal(r.provenance.reported.review, v.review === true, v.externalId);
    assert.equal(r.provenance.reported.category, v.category ?? null, v.externalId);
  }
});

// ── discovery ────────────────────────────────────────────────────────────
test("multiple targets: one deterministic ref per in-scope target, in target order; each fetch queries its own area", async () => {
  const noviSad: IngestionTarget = { countryId: "RS", cityName: "Novi Sad", osmRelationId: 1111 };
  const { adapter, queries } = adapterFor(FIXTURE, [BELGRADE, noviSad]);

  const refs = await refsOf(adapter, ["Novi Sad", "Belgrade"]);
  assert.deepEqual(
    refs.map((r) => r.externalId),
    [osmTargetRefId(BELGRADE), osmTargetRefId(noviSad)],
  );
  assert.deepEqual(await refsOf(adapter, ["Novi Sad", "Belgrade"]), refs, "repeatable");
  assert.equal(new Set(refs.map((r) => r.externalId)).size, 2, "unique");
  for (const r of refs) assert.equal(r.kindHint, "venue");

  // a target whose city the engine did not put in scope is not discovered
  assert.deepEqual((await refsOf(adapter, ["Belgrade"])).map((r) => r.externalId), [osmTargetRefId(BELGRADE)]);
  assert.deepEqual(await refsOf(adapter, []), []);

  for (const r of refs) await adapter.fetch(r, ctx([]));
  assert.ok(queries[0].includes(`area(id:${3600000000 + 2728438})`), "Belgrade's area");
  assert.ok(queries[1].includes(`area(id:${3600000000 + 1111})`), "Novi Sad's area");

  assert.throws(() => createOsmOverpassAdapter({ targets: [BELGRADE, { ...BELGRADE }], config: CONFIG }), /unique/);
});

test("parse fails cleanly on an unknown target ref or a non-JSON body", async () => {
  const { adapter } = adapterFor(FIXTURE);
  const [ref] = await refsOf(adapter, ["Belgrade"]);
  const raw = await adapter.fetch(ref, ctx([]));
  assert.deepEqual(adapter.parse({ ...raw, body: "<html>" }, ctx([])), { ok: false, reason: "invalid-json" });
  const unknown = adapter.parse({ ...raw, ref: { ...ref, externalId: "RS:Nowhere:relation/1" } }, ctx([]));
  assert.equal(unknown.ok, false);
  await assert.rejects(adapter.fetch({ ...ref, externalId: "RS:Nowhere:relation/1" }, ctx([])), /unknown OSM target/);
});

// ── config ───────────────────────────────────────────────────────────────
test("buildOsmSyncConfig: one country / city per target, the single OpenStreetMap source scoped to them", () => {
  const cfg = buildOsmSyncConfig([BELGRADE]);
  assert.deepEqual(cfg.countries.map((c) => [c.code, c.normalizationProfile, c.defaultTimeZone]), [
    ["RS", "sr", "Europe/Belgrade"],
  ]);
  assert.equal(cfg.cities.length, 1);
  assert.equal(cfg.cities[0].canonicalName, "Belgrade");
  assert.equal(cfg.cities[0].eventFirstEnabled, false);
  assert.deepEqual(cfg.cities[0].sourceScope, { osm: { relationId: 2728438 } });
  assert.deepEqual(cfg.sources.map((s) => [s.key, s.kinds, s.scope]), [
    ["OpenStreetMap", ["venue"], { countries: ["RS"], cities: ["Belgrade"] }],
  ]);

  const provider = createOsmConfigProvider([BELGRADE]); // passes the provider's own config validation
  assert.equal(provider.resolveCity("RS", "Belgrade")?.city.canonicalName, "Belgrade");
  assert.deepEqual(provider.citiesInScope(provider.source("OpenStreetMap")!).map((c) => c.canonicalName), ["Belgrade"]);

  assert.throws(() => buildOsmSyncConfig([{ countryId: "HR", cityName: "Zagreb", osmRelationId: 1 }]), /no OSM country metadata for "HR"/);
});

// ── through the engine ───────────────────────────────────────────────────
const BELGRADE_CITY = { id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade" };

async function plan(response: OverpassResponse, store: InMemoryCanonicalStore) {
  const provider = createOsmConfigProvider([BELGRADE]);
  const { adapter } = adapterFor(response);
  return planSync({ adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store, now: NOW, runId: "r" });
}

test("planSync: a fresh city plans one insert per accepted venue; after apply, a second identical run is all UNCHANGED", async () => {
  const store = new InMemoryCanonicalStore({ cities: [BELGRADE_CITY] });
  const accepted = parseOverpassVenues(FIXTURE, BELGRADE).venues.length;

  const first = await plan(FIXTURE, store);
  assert.equal(first.stats.status, "ok");
  assert.equal(first.upserts.filter((u) => u.operation === "insert").length, accepted);
  assert.equal(first.reviewItems.length, 0);
  await store.apply(first, { commit: true });

  const second = await plan(FIXTURE, store);
  assert.equal(second.stats.byChangeStatus.UNCHANGED, accepted);
  assert.equal(second.upserts.filter((u) => u.operation === "insert").length, 0);
  assert.equal(store.venues.length, accepted, "no duplicates");
});

test("planSync: an Overpass failure is a fetch failure — failed run, no upserts, reconciliation skipped", async () => {
  const provider = createOsmConfigProvider([BELGRADE]);
  const adapter = createOsmOverpassAdapter({
    targets: [BELGRADE],
    config: CONFIG,
    transport: async () => {
      throw new Error("Overpass returned an error remark: runtime error");
    },
  });
  const store = new InMemoryCanonicalStore({ cities: [BELGRADE_CITY] });
  const p = await planSync({ adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store, now: NOW, runId: "r" });
  assert.equal(p.stats.fetchFailed, 1);
  assert.notEqual(p.stats.status, "ok");
  assert.equal(p.upserts.length, 0);
  assert.equal(p.reconciliation.reconciled, false);
});

// ── regressions for the two engine gaps found by this adapter ─────────────
//
// Setup: a hand-seeded Belgrade venue "Drugstore" (no source, manual
// coordinates), and TWO incoming OSM elements named "Drugstore" — the fixture's
// node/1001 plus a second, nearby node/1099.

const SECOND_DRUGSTORE: OverpassElement = {
  type: "node",
  id: 1099,
  lat: 44.8186,
  lon: 20.4885,
  tags: { amenity: "nightclub", name: "Drugstore" },
};
const WITH_SECOND_DRUGSTORE: OverpassResponse = { ...FIXTURE, elements: [...(FIXTURE.elements ?? []), SECOND_DRUGSTORE] };

function seededDrugstore(over: Partial<CanonicalVenue> = {}): CanonicalVenue {
  return {
    id: "v-drugstore",
    cityId: "city-bg",
    cityName: "Belgrade",
    countryCode: "RS",
    name: "Drugstore",
    normalizedName: computeNameNormalized("Drugstore"),
    address: null,
    coordinates: { latitude: 44.8185264, longitude: 20.488357 },
    coordinatesSource: "manual",
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

const drugstoreOutcomes = (p: Awaited<ReturnType<typeof plan>>) =>
  p.upserts
    .filter((u) => u.record.kind === "venue" && u.record.fields.name === "Drugstore")
    .map((u) => ({ externalId: u.record.provenance.externalId, operation: u.operation, canonicalId: u.canonicalId }));

const storeWith = (...venues: CanonicalVenue[]) => new InMemoryCanonicalStore({ cities: [BELGRADE_CITY], venues });

test("[gap A regression] the first matching element links the existing venue; the second takes the normal new-venue path", async () => {
  const p = await plan(WITH_SECOND_DRUGSTORE, storeWith(seededDrugstore()));
  // Before the fix: BOTH were link-only to v-drugstore.
  assert.deepEqual(drugstoreOutcomes(p), [
    { externalId: "node/1001", operation: "link-only", canonicalId: "v-drugstore" },
    { externalId: "node/1099", operation: "insert", canonicalId: null },
  ]);
  assert.equal(p.upserts.find((u) => u.record.provenance.externalId === "node/1099")?.identity.decision, "new_candidate");

  // unrelated records are exactly what a store without the seed plans for them
  const fresh = await plan(WITH_SECOND_DRUGSTORE, storeWith());
  const others = (x: typeof p) =>
    x.upserts
      .filter((u) => u.record.kind === "venue" && u.record.fields.name !== "Drugstore")
      .map((u) => [u.record.provenance.externalId, u.operation, u.canonicalId]);
  assert.deepEqual(others(p), others(fresh));

  // deterministic: a second plan over the same state is identical
  const again = await plan(WITH_SECOND_DRUGSTORE, storeWith(seededDrugstore()));
  assert.deepEqual(drugstoreOutcomes(again), drugstoreOutcomes(p));
});

test("[gap A regression] after apply, the next run re-links each element to its OWN row — no duplicate, nothing new", async () => {
  const store = storeWith(seededDrugstore());
  await store.apply(await plan(WITH_SECOND_DRUGSTORE, store), { commit: true });
  const second = await plan(WITH_SECOND_DRUGSTORE, store);
  assert.equal(second.upserts.filter((u) => u.operation === "insert").length, 0);
  const drugstores = store.venues.filter((v) => v.name === "Drugstore");
  assert.equal(drugstores.length, 2, "the seed + node/1099's own row");
  assert.equal(drugstoreOutcomes(second).find((o) => o.externalId === "node/1001")?.canonicalId, "v-drugstore");
});

test("[gap A regression] an element that already OWNS a row keeps it even when a same-name element is processed first", async () => {
  // Overpass prints nodes before ways, so a new same-name element can come
  // before the owner. A plain shared claim set would let it take the owner's
  // row by name, and the owner would then be inserted as a duplicate.
  const owned = seededDrugstore({ sourceKey: "OpenStreetMap", externalId: "node/1001" });
  const newcomerFirst: OverpassResponse = {
    ...FIXTURE,
    elements: [SECOND_DRUGSTORE, ...(FIXTURE.elements ?? [])],
  };
  const outcomes = drugstoreOutcomes(await plan(newcomerFirst, storeWith(owned)));
  assert.deepEqual(outcomes, [
    { externalId: "node/1099", operation: "insert", canonicalId: null },
    { externalId: "node/1001", operation: "link-only", canonicalId: "v-drugstore" },
  ]);
});

test("[gap B regression] a seeded venue with NULL name_normalized is matched by name, not duplicated — and the read writes nothing", async () => {
  // "" is exactly how SupabaseCanonicalStore reads a NULL name_normalized.
  const store = storeWith(seededDrugstore({ normalizedName: "" }));
  const p = await plan(WITH_SECOND_DRUGSTORE, store);
  // Before the fix: both elements were `insert` — two duplicates of the seed.
  assert.deepEqual(drugstoreOutcomes(p), [
    { externalId: "node/1001", operation: "link-only", canonicalId: "v-drugstore" },
    { externalId: "node/1099", operation: "insert", canonicalId: null },
  ]);
  assert.equal(store.venues[0].normalizedName, "", "planning derived it in memory only");
});

test("[gap B regression] a real stored name_normalized is still authoritative; blank / symbol-only names never match", async () => {
  // a curated value that differs from the name's computed form is NOT replaced
  const curated = await plan(FIXTURE, storeWith(seededDrugstore({ normalizedName: "klub drugstore" })));
  assert.deepEqual(drugstoreOutcomes(curated), [{ externalId: "node/1001", operation: "insert", canonicalId: null }]);

  for (const name of ["   ", "---"]) {
    const p = await plan(FIXTURE, storeWith(seededDrugstore({ name, normalizedName: "" })));
    assert.equal(drugstoreOutcomes(p)[0].canonicalId, null, JSON.stringify(name));
  }
});

test("[manual-coords regression] a matched seeded venue with MANUAL coordinates converges to UNCHANGED; the pin is never moved", async () => {
  const pin = { latitude: 44.8185264, longitude: 20.488357 }; // differs from OSM's 44.8185 / 20.4884
  const store = storeWith(seededDrugstore({ coordinates: pin, coordinatesSource: "manual" }));
  const status = (p: Awaited<ReturnType<typeof plan>>) =>
    p.upserts.find((u) => u.record.provenance.externalId === "node/1001")!.changeStatus;

  const run1 = await plan(FIXTURE, store); // links the seed
  await store.apply(run1, { commit: true });
  const run2 = await plan(FIXTURE, store); // fills the seed's empty fields (address, website, …) once
  assert.equal(status(run2), "UPDATED");
  await store.apply(run2, { commit: true });

  // Before the fix: UPDATED on every run, forever — the protected manual
  // coordinates were still compared against OSM's.
  const run3 = await plan(FIXTURE, store);
  assert.equal(status(run3), "UNCHANGED");
  const seed = store.venues.find((v) => v.id === "v-drugstore")!;
  assert.deepEqual(seed.coordinates, pin);
  assert.equal(seed.coordinatesSource, "manual");
  assert.equal(seed.website, "https://example.org/drugstore", "the non-coordinate fill did apply");
});

test("[omitted-fields regression] curated description / opening times / deactivation OSM never provides: converges to UNCHANGED, kept as curated", async () => {
  const curated = { description: "Legendary club", openingTime: "23:00", closingTime: "06:00", isActive: false };
  const store = storeWith(seededDrugstore({ coordinates: null, coordinatesSource: null, ...curated }));
  const statusOf = (p: Awaited<ReturnType<typeof plan>>) =>
    p.upserts.find((u) => u.record.provenance.externalId === "node/1001")!;

  await store.apply(await plan(FIXTURE, store), { commit: true }); // links the seed
  const run2 = statusOf(await plan(FIXTURE, store)); // fills address / website / coords once
  assert.equal(run2.changeStatus, "UPDATED");
  // only fields OSM actually provides may be in the delta
  const provided = new Set(["address", "lat", "lon", "website", "wikidata", "openingHours", "normalizedName"]);
  for (const d of run2.fieldDeltas) assert.ok(provided.has(d.field), `unexpected delta ${d.field}`);
  await store.apply(await plan(FIXTURE, store), { commit: true });

  // Before the fix: UPDATED(description, openingTime, closingTime, isActive) forever.
  const run3 = statusOf(await plan(FIXTURE, store));
  assert.equal(run3.changeStatus, "UNCHANGED", JSON.stringify(run3.fieldDeltas));
  const seed = store.venues.find((v) => v.id === "v-drugstore")!;
  assert.deepEqual(
    { description: seed.description, openingTime: seed.openingTime, closingTime: seed.closingTime, isActive: seed.isActive },
    curated,
  );
  assert.deepEqual(seed.coordinates, { latitude: 44.8185, longitude: 20.4884 }, "source-owned coords still written");
});

// ── field presence: omitted (undefined) vs provided ─────────────────────
const PRESENCE_FIELDS = ["address", "website", "wikidata", "openingHours"] as const;
const BLANK_TAGS: OverpassElement = {
  type: "node",
  id: 8101,
  lat: 44.81,
  lon: 20.46,
  tags: { amenity: "bar", name: "Blank Tags Bar", website: "   ", opening_hours: "", wikidata: " ", "addr:city": "  " },
};
const PARTIAL_ADDRESS: OverpassElement = {
  type: "node",
  id: 8102,
  lat: 44.811,
  lon: 20.461,
  tags: { amenity: "bar", name: "Street Only Bar", "addr:street": "Knez Mihailova" },
};

test("[presence] absent, empty or whitespace-only OSM tags are OMITTED — the key is absent, not null", async () => {
  const records = await recordsFor({ ...FIXTURE, elements: [...(FIXTURE.elements ?? []), BLANK_TAGS] });
  for (const id of ["node/8008", "node/8101"]) {
    const fields = venueOf(records, id).fields;
    for (const k of PRESENCE_FIELDS) assert.equal(k in fields, false, `${id}: ${k} must be omitted`);
  }
});

test("[presence] present tags are provided; a partial address is provided as assembled", async () => {
  const records = await recordsFor({ ...FIXTURE, elements: [...(FIXTURE.elements ?? []), PARTIAL_ADDRESS] });
  const drugstore = venueOf(records, "node/1001").fields;
  assert.deepEqual(
    Object.fromEntries(PRESENCE_FIELDS.map((k) => [k, drugstore[k]])),
    {
      address: "Bulevar despota Stefana 115, 11000 Beograd",
      website: "https://example.org/drugstore",
      wikidata: "Q3040577",
      openingHours: "Fr-Sa 23:00-06:00",
    },
  );
  const partial = venueOf(records, "node/8102").fields;
  assert.equal(partial.address, "Knez Mihailova");
  assert.equal("website" in partial, false);
  const dom = venueOf(records, "way/41234985").fields; // wikidata only
  assert.equal(dom.wikidata, "Q4882656");
  assert.equal("address" in dom, false);
});

function seededBar(over: Partial<CanonicalVenue> = {}): CanonicalVenue {
  return seededDrugstore({
    id: "v-bar",
    name: "Random Cocktail Bar",
    normalizedName: computeNameNormalized("Random Cocktail Bar"),
    coordinates: null,
    coordinatesSource: null,
    ...over,
  });
}

test("[presence regression] curated address / website / wikidata / opening hours OSM does not have: kept, and identical re-syncs are UNCHANGED", async () => {
  const curated = {
    address: "Knez Mihailova 1",
    website: "https://curated.example",
    wikidata: "Q1",
    openingHours: "Mo-Su 18:00-02:00",
  };
  const store = storeWith(seededBar(curated));
  const bar = (p: Awaited<ReturnType<typeof plan>>) => p.upserts.find((u) => u.record.provenance.externalId === "node/8008")!;

  await store.apply(await plan(FIXTURE, store), { commit: true }); // links the seed (tier 2)
  const run2 = bar(await plan(FIXTURE, store)); // OSM's coordinates fill the empty ones once
  assert.equal(run2.changeStatus, "UPDATED");
  assert.deepEqual(run2.fieldDeltas.map((d) => d.field).sort(), ["lat", "lon"]);
  await store.apply(await plan(FIXTURE, store), { commit: true });

  // Before the fix: UPDATED(address, website, wikidata, openingHours) on every run, forever.
  for (const run of ["run3", "run4"]) {
    const u = bar(await plan(FIXTURE, store));
    assert.equal(u.changeStatus, "UNCHANGED", `${run}: ${JSON.stringify(u.fieldDeltas)}`);
    await store.apply(await plan(FIXTURE, store), { commit: true });
  }
  const row = store.venues.find((v) => v.id === "v-bar")!;
  assert.deepEqual(Object.fromEntries(PRESENCE_FIELDS.map((k) => [k, row[k]])), curated);
});

test("[presence regression] a website OSM later REMOVES is kept (no clear) and the next syncs are UNCHANGED", async () => {
  const withSite: OverpassResponse = {
    ...FIXTURE,
    elements: (FIXTURE.elements ?? []).map((e) =>
      e.id === 8008 ? { ...e, tags: { ...e.tags, website: "https://bar.example" } } : e,
    ),
  };
  const store = storeWith();
  await store.apply(await plan(withSite, store), { commit: true });
  const bar = () => store.venues.find((v) => v.externalId === "node/8008")!;
  assert.equal(bar().website, "https://bar.example");

  for (let i = 0; i < 2; i++) {
    const p = await plan(FIXTURE, store); // the tag is gone
    const u = p.upserts.find((x) => x.record.provenance.externalId === "node/8008")!;
    assert.equal(u.changeStatus, "UNCHANGED", JSON.stringify(u.fieldDeltas));
    await store.apply(p, { commit: true });
  }
  assert.equal(bar().website, "https://bar.example", "OSM cannot tell 'deleted' from 'never tagged' — never clear");
});

test("[presence] identity: a provided wikidata still matches (tier 1); omitted website / wikidata behave like null", async () => {
  // tier 1 by wikidata, despite a different stored name
  const byQid = await plan(FIXTURE, storeWith(seededDrugstore({ id: "v-dom", name: "DOB", normalizedName: "dob", wikidata: "Q4882656" })));
  const dom = byQid.upserts.find((u) => u.record.provenance.externalId === "way/41234985")!;
  assert.equal(dom.identity.decision, "matched");
  assert.equal(dom.identity.tier, 1);
  assert.equal(dom.canonicalId, "v-dom");

  // node/8008 omits website + wikidata: a stored row sharing neither name nor
  // identity must not match it (exactly the null behavior)
  const noMatch = await plan(FIXTURE, storeWith(seededDrugstore({ id: "v-x", name: "Other", normalizedName: "other", website: "https://x.example", wikidata: "Q9" })));
  assert.equal(noMatch.upserts.find((u) => u.record.provenance.externalId === "node/8008")?.operation, "insert");
});

// ── Step 7A: empty / collapsed / partial results must never reconcile ─────
//
// Reconciliation marks every stored source record NOT seen this run. An OSM
// ref is a whole city's snapshot, so a missing, empty or collapsed snapshot
// would read as "every venue disappeared".

/** The fixture's elements with ids shifted, so each city gets distinct OSM ids. */
function shifted(offset: number): OverpassResponse {
  return { ...FIXTURE, elements: (FIXTURE.elements ?? []).map((e) => ({ ...e, id: e.id + offset })) };
}

async function planWith(
  store: InMemoryCanonicalStore,
  transport: (query: string) => Promise<OverpassResponse>,
  targets: IngestionTarget[] = [BELGRADE],
) {
  const provider = createOsmConfigProvider(targets);
  const adapter = createOsmOverpassAdapter({ targets, config: CONFIG, transport, now: () => NOW });
  return planSync({ adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store, now: NOW, runId: "r" });
}

/** Belgrade after one healthy, applied sync of the full fixture. */
async function syncedBelgrade() {
  const store = storeWith();
  await store.apply(await planWith(store, async () => FIXTURE), { commit: true });
  const synced = parseOverpassVenues(FIXTURE, BELGRADE).venues.length;
  assert.equal((await store.listSourceLinks("venue", OSM_SOURCE_KEY)).length, synced);
  return { store, synced };
}

const destructive = (p: Awaited<ReturnType<typeof plan>>) =>
  p.reconciliation.actions.filter((a) => a.transition === "mark-stale" || a.transition === "mark-missing" || a.transition === "mark-gone");

test("[7A] parse rejects an empty Overpass result, and one with zero accepted venues, with an explicit reason", async () => {
  const { adapter } = adapterFor({ elements: [] });
  const [ref] = await refsOf(adapter, ["Belgrade"]);
  const empty = adapter.parse(await adapter.fetch(ref, ctx([])), ctx([]));
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.reason, "empty-result");
    assert.match(empty.detail ?? "", /RS:Belgrade/);
  }
  const onlyRejects: OverpassResponse = {
    elements: (FIXTURE.elements ?? []).filter((e) => ["node/5005", "node/6006"].includes(`${e.type}/${e.id}`)),
  };
  const { adapter: a2 } = adapterFor(onlyRejects);
  const [ref2] = await refsOf(a2, ["Belgrade"]);
  const none = a2.parse(await a2.fetch(ref2, ctx([])), ctx([]));
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.reason, "no-accepted-venues");
});

test("[7A regression] an EMPTY result after a healthy sync: reconciliation skipped, nothing marked stale, reason in the notes", async () => {
  const { store } = await syncedBelgrade();
  const p = await planWith(store, async () => ({ elements: [] }));
  // Before the guard: parsed ok with zero records, a "healthy" run, and every
  // synced Belgrade venue planned mark-stale.
  assert.equal(p.reconciliation.reconciled, false);
  assert.deepEqual(destructive(p), []);
  assert.equal(p.stats.healthy, false);
  assert.ok(p.stats.notes.some((n) => /empty-result/.test(n)), JSON.stringify(p.stats.notes));
  assert.ok(p.reconciliation.skippedReason);
});

test("[7A regression] a COLLAPSED result (far fewer venues than were synced): reconciliation skipped; the venues it did return are still planned", async () => {
  const { store, synced } = await syncedBelgrade();
  const one: OverpassResponse = { elements: (FIXTURE.elements ?? []).filter((e) => e.id === 1001) };
  const p = await planWith(store, async () => one);
  // Before the guard: 1 of 8 seen → the other 7 planned mark-stale.
  assert.equal(p.reconciliation.reconciled, false);
  assert.deepEqual(destructive(p), []);
  assert.ok(
    p.stats.notes.some((n) => n.includes(`1 of ${synced}`) && /collapsed/.test(n)),
    JSON.stringify(p.stats.notes),
  );
  assert.deepEqual(p.upserts.map((u) => [u.record.provenance.externalId, u.changeStatus]), [["node/1001", "UNCHANGED"]]);
});

test("[7A regression] one of several city snapshots FAILING or EMPTY: reconciliation skipped even under the ratio thresholds", async () => {
  const cities = ["Belgrade", "Novi Sad", "Niš", "Kragujevac"].map((cityName, i) => ({
    target: { countryId: "RS", cityName, osmRelationId: 1000 + i } as IngestionTarget,
    city: { id: `city-${i}`, countryCode: "RS", name: cityName, timeZone: "Europe/Belgrade" },
    response: shifted(i * 100000),
  }));
  const targets = cities.map((c) => c.target);
  const byArea = (query: string) => cities.find((c) => query.includes(`area(id:${3600000000 + c.target.osmRelationId})`))!;
  const store = new InMemoryCanonicalStore({ cities: cities.map((c) => c.city) });
  await store.apply(await planWith(store, async (q) => byArea(q).response, targets), { commit: true });

  // 1 of 4 fetches fails (fetchFail 0.25 < 0.5) — would pass the generic ratio rule
  const failing = await planWith(store, async (q) => {
    if (byArea(q).city.name === "Niš") throw new Error("Overpass returned an error remark: timeout");
    return byArea(q).response;
  }, targets);
  assert.equal(failing.reconciliation.reconciled, false);
  assert.deepEqual(destructive(failing), []);

  // 1 of 4 snapshots empty (parseFail 0.25 < 0.3) — would also pass the ratio rule
  const empty = await planWith(store, async (q) => (byArea(q).city.name === "Niš" ? { elements: [] } : byArea(q).response), targets);
  assert.equal(empty.reconciliation.reconciled, false);
  assert.deepEqual(destructive(empty), []);
  assert.ok(empty.stats.notes.some((n) => /empty-result/.test(n) && /Niš/.test(n)), JSON.stringify(empty.stats.notes));
});

test("[7A] a HEALTHY result still reconciles exactly as before: a venue OSM dropped is marked stale, the rest stay active", async () => {
  const { store, synced } = await syncedBelgrade();
  const withoutOne: OverpassResponse = { elements: (FIXTURE.elements ?? []).filter((e) => e.id !== 8008) };
  const p = await planWith(store, async () => withoutOne);
  assert.equal(p.stats.healthy, true);
  assert.equal(p.reconciliation.reconciled, true);
  assert.deepEqual(destructive(p).map((a) => [a.key, a.transition]), [["OpenStreetMap:node/8008", "mark-stale"]]);
  assert.equal(p.reconciliation.actions.filter((a) => a.transition === "keep-active").length, synced - 1);
});

// ── Step 7B: a reliable OSM match makes the OSM name authoritative ─────────
//
// Policy: the stored name of a hand-seeded venue is not protected. Once OSM
// reliably matches it, the OSM name replaces it; the id, the row and manual
// coordinates stay. (The rename lands on the SECOND sync: the first reliable
// match is planned `link-only`, the generic rule for a first match.)

async function runStore(store: CanonicalStore, response: OverpassResponse = FIXTURE) {
  const provider = createOsmConfigProvider([BELGRADE]);
  const adapter = createOsmOverpassAdapter({ targets: [BELGRADE], config: CONFIG, transport: async () => response, now: () => NOW });
  const p = await planSync({ adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store, now: NOW, runId: "r" });
  const res = await store.apply(p, { commit: true });
  assert.equal(res.error, null, JSON.stringify(res.error));
  return p;
}
const drugstoreUpsert = (p: Awaited<ReturnType<typeof runStore>>) =>
  p.upserts.find((u) => u.record.provenance.externalId === "node/1001")!;

const SEED_PIN = { latitude: 44.8185264, longitude: 20.488357 };

test("[7B] a seeded name is replaced by the reliably matched OSM name — same id, no duplicate, manual coords kept, then UNCHANGED (in-memory)", async () => {
  // "DRUGSTORE" and OSM's "Drugstore" normalize the same: a reliable tier-2 match
  const store = storeWith(seededDrugstore({ name: "DRUGSTORE", normalizedName: "", coordinates: SEED_PIN, coordinatesSource: "manual" }));
  const accepted = parseOverpassVenues(FIXTURE, BELGRADE).venues.length;

  assert.equal(drugstoreUpsert(await runStore(store)).operation, "link-only"); // first match
  const run2 = drugstoreUpsert(await runStore(store));
  assert.equal(run2.changeStatus, "UPDATED");
  assert.ok(run2.fieldDeltas.some((d) => d.field === "name" && d.from === "DRUGSTORE" && d.to === "Drugstore"));
  assert.equal(run2.canonicalId, "v-drugstore");

  const row = store.venues.find((v) => v.id === "v-drugstore")!;
  assert.equal(row.name, "Drugstore");
  assert.deepEqual(row.coordinates, SEED_PIN);
  assert.equal(row.coordinatesSource, "manual");
  assert.equal(store.venues.length, accepted, "the seed was matched, not duplicated");
  assert.equal(store.venues.filter((v) => /drugstore/i.test(v.name)).length, 1);

  const run3 = drugstoreUpsert(await runStore(store));
  assert.equal(run3.changeStatus, "UNCHANGED", JSON.stringify(run3.fieldDeltas));
});

test("[7B] the same rename through SupabaseCanonicalStore (fake Supabase): id kept, no duplicate, manual coords kept, then UNCHANGED", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }]);
  fake.seed("venues", [
    { id: "v-drugstore", city_id: "city-bg", name: "DRUGSTORE", name_normalized: null, latitude: SEED_PIN.latitude, longitude: SEED_PIN.longitude, coordinates_source: "manual", is_active: true, created_at: NOW, updated_at: NOW },
  ]);
  const store = new SupabaseCanonicalStore(fake.asClient(), { now: () => NOW });
  const accepted = parseOverpassVenues(FIXTURE, BELGRADE).venues.length;

  await runStore(store);
  assert.equal(drugstoreUpsert(await runStore(store)).changeStatus, "UPDATED");
  const row = fake.tables.venues.find((r) => r.id === "v-drugstore")!;
  assert.equal(row.name, "Drugstore");
  assert.equal(row.latitude, SEED_PIN.latitude);
  assert.equal(row.longitude, SEED_PIN.longitude);
  assert.equal(row.coordinates_source, "manual");
  assert.equal(row.external_id, "node/1001");
  assert.equal(fake.tables.venues.length, accepted, "no duplicate row");
  assert.equal(drugstoreUpsert(await runStore(store)).changeStatus, "UNCHANGED");
});

test("[7B] an AMBIGUOUS match renames nothing: both candidates keep their names, the OSM venue is held for review", async () => {
  const store = storeWith(
    seededDrugstore({ id: "v-a", name: "DRUGSTORE", normalizedName: "" }),
    seededDrugstore({ id: "v-b", name: "Drugstore", normalizedName: "" }),
  );
  for (let i = 0; i < 2; i++) {
    const p = await runStore(store);
    assert.equal(p.upserts.some((u) => u.record.provenance.externalId === "node/1001"), false);
    assert.ok(p.reviewItems.some((r) => r.record.provenance.externalId === "node/1001" && /ambiguous/.test(r.reasonCode)));
  }
  assert.deepEqual(store.venues.filter((v) => v.id === "v-a" || v.id === "v-b").map((v) => v.name), ["DRUGSTORE", "Drugstore"]);
});

test("[7B] no reliable match → the unrelated seeded venue keeps its name; the OSM venue is inserted under the OSM name", async () => {
  const store = storeWith(seededDrugstore({ id: "v-other", name: "Drug Store Lounge", normalizedName: "" }));
  for (let i = 0; i < 2; i++) await runStore(store);
  assert.equal(store.venues.find((v) => v.id === "v-other")!.name, "Drug Store Lounge");
  const inserted = store.venues.find((v) => v.externalId === "node/1001")!;
  assert.equal(inserted.name, "Drugstore", "a new OSM venue is stored under its OSM name");
  assert.notEqual(inserted.id, "v-other");
});

// ── Venue lifecycle contract ──────────────────────────────────────────────
//
// A known OSM venue absent from a HEALTHY, COMPLETE OSM snapshot moves through
// the reconciliation lifecycle (active → stale → missing → gone); at gone it
// becomes `is_active = false` — never hard-deleted. Seen again, it is active
// again with its misses reset. An unhealthy / failed / partial run changes no
// lifecycle state. Event activity plays no part: OSM reconciles venues only.
// [lifecycle A–C] run on the in-memory store; [lifecycle S*] persist through
// SupabaseCanonicalStore (fake Supabase) — source_status / consecutive_misses /
// is_active.

const DROPPED = "OpenStreetMap:node/8008";
const withoutDropped = async (): Promise<OverpassResponse> => ({ elements: (FIXTURE.elements ?? []).filter((e) => e.id !== 8008) });
const linkOf = async (store: InMemoryCanonicalStore, key: string) =>
  (await store.listSourceLinks("venue", OSM_SOURCE_KEY)).find((l) => `${l.sourceKey}:${l.externalId}` === key)!;

test("[lifecycle A] a venue absent from consecutive healthy complete snapshots progresses stale → missing → gone, and is never deleted", async () => {
  const { store } = await syncedBelgrade();
  const venueId = (await linkOf(store, DROPPED)).canonicalId;
  const steps: [string, number][] = [];
  for (let run = 0; run < 3; run++) {
    const p = await planWith(store, withoutDropped);
    assert.equal(p.stats.status, "ok");
    assert.equal(p.stats.healthy, true);
    assert.equal(p.reconciliation.reconciled, true);
    const acts = destructive(p);
    assert.equal(acts.length, 1, "only the dropped venue gets a lifecycle action");
    assert.equal(acts[0].key, DROPPED);
    assert.equal(acts[0].kind, "venue");
    assert.equal(acts[0].canonicalId, venueId);
    steps.push([acts[0].transition, acts[0].misses]);
    await store.apply(p, { commit: true });
  }
  assert.deepEqual(steps, [["mark-stale", 1], ["mark-missing", 2], ["mark-gone", 3]]);
  assert.equal((await linkOf(store, DROPPED)).sourceStatus, "gone");
  assert.equal(store.venues.find((v) => v.id === venueId)!.isActive, false, "gone deactivates");

  // once gone, further healthy runs leave it alone (no-op), and the row was never removed
  const after = await planWith(store, withoutDropped);
  assert.deepEqual(destructive(after), []);
  assert.equal(after.reconciliation.actions.find((a) => a.key === DROPPED)!.transition, "no-op");
  assert.ok(store.venues.some((v) => v.id === venueId), "the venue row still exists — no hard delete");
  // no lifecycle transition the engine can emit is a delete or a cancellation
  for (const a of after.reconciliation.actions) {
    assert.ok(["no-op", "keep-active", "mark-stale", "mark-missing", "mark-gone"].includes(a.transition), a.transition);
  }

  // seen again: reactivated in place, misses reset
  const back = await planWith(store, async () => FIXTURE);
  assert.equal(back.reconciliation.actions.find((a) => a.key === DROPPED)!.transition, "keep-active");
  await store.apply(back, { commit: true });
  const link = await linkOf(store, DROPPED);
  assert.deepEqual([link.sourceStatus, link.consecutiveMisses, link.canonicalId], ["active", 0, venueId]);
  assert.equal(store.venues.find((v) => v.id === venueId)!.isActive, true);
});

test("[lifecycle B] failed, empty, collapsed and partial runs change NO venue lifecycle state for a venue they did not return", async () => {
  const scenarios: [string, (store: InMemoryCanonicalStore) => ReturnType<typeof planWith>][] = [
    ["failed (Overpass error)", (s) => planWith(s, async () => { throw new Error("Overpass returned an error remark: runtime error"); })],
    ["degraded (empty snapshot)", (s) => planWith(s, async () => ({ elements: [] }))],
    ["degraded (collapsed snapshot)", (s) => planWith(s, async () => ({ elements: (FIXTURE.elements ?? []).filter((e) => e.id === 1001) }))],
    ["partial run", (s) => {
      const provider = createOsmConfigProvider([BELGRADE]);
      const adapter = createOsmOverpassAdapter({ targets: [BELGRADE], config: CONFIG, transport: async () => ({ elements: (FIXTURE.elements ?? []).filter((e) => e.id === 1001) }), now: () => NOW });
      return planSync({ adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store: s, now: NOW, runId: "r", completeness: "partial" });
    }],
  ];
  for (const [name, run] of scenarios) {
    const { store } = await syncedBelgrade();
    const before = await linkOf(store, DROPPED);
    const venueId = before.canonicalId;
    const p = await run(store);
    assert.deepEqual(destructive(p), [], `${name}: no stale / missing / gone action`);
    assert.equal(p.reconciliation.actions.some((a) => a.key === DROPPED), false, `${name}: the absent venue is not reconciled at all`);
    if (name !== "partial run") {
      assert.equal(p.stats.healthy, false, `${name}: unhealthy`);
      assert.equal(p.reconciliation.reconciled, false, `${name}: reconciliation skipped`);
      assert.ok(p.reconciliation.skippedReason, `${name}: skip reason recorded`);
    }
    await store.apply(p, { commit: true });
    const link = await linkOf(store, DROPPED);
    assert.equal(link.sourceStatus, "active", `${name}: lifecycle unchanged`);
    assert.equal(link.consecutiveMisses, 0, `${name}: miss counter unchanged`);
    const venue = store.venues.find((v) => v.id === venueId)!;
    assert.ok(venue, `${name}: venue row kept`);
    assert.equal(venue.isActive, true, `${name}: is_active unchanged`);
  }
});

test("[lifecycle C] a venue with NO events is not a lifecycle candidate: OSM reconciles venues only, driven by source presence", async () => {
  const provider = createOsmConfigProvider([BELGRADE]);
  assert.deepEqual(provider.source(OSM_SOURCE_KEY)!.kinds, ["venue"], "OSM reconciliation never looks at events");

  const { store, synced } = await syncedBelgrade();
  assert.equal(store.events.length, 0, "no venue has any event");
  const p = await planWith(store, async () => FIXTURE);
  assert.equal(p.reconciliation.reconciled, true);
  assert.deepEqual(destructive(p), [], "event absence produces no lifecycle action");
  assert.equal(p.reconciliation.actions.length, synced);
  assert.ok(p.reconciliation.actions.every((a) => a.kind === "venue" && a.transition === "keep-active"));
  await store.apply(p, { commit: true });
  for (const v of store.venues) assert.equal(v.isActive, true, `${v.name} stays active`);
  for (const l of await store.listSourceLinks("venue", OSM_SOURCE_KEY)) assert.equal(l.sourceStatus, "active");
});

// ── [lifecycle S*] persisted through SupabaseCanonicalStore (fake Supabase) ──
type FakeRow = Record<string, unknown>;
const without8008: OverpassResponse = { elements: (FIXTURE.elements ?? []).filter((e) => e.id !== 8008) };

/** Belgrade synced once through the Supabase store; plus a hand-seeded venue, a
 * venue owned by another source, an OSM venue in an out-of-scope city, and two
 * historical events at the venue that will disappear (node/8008). */
async function lifecycleDb() {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [
    { id: "city-bg", country_id: "RS", name: "Belgrade" },
    { id: "city-ns", country_id: "RS", name: "Novi Sad" },
  ]);
  fake.seed("data_sources", [
    { id: "ds-osm", name: "OpenStreetMap", type: "api" },
    { id: "ds-g", name: "gigstix", type: "scraper" },
  ]);
  fake.seed("venues", [
    { id: "v-manual", city_id: "city-bg", name: "Hand Seeded Lounge", name_normalized: "hand seeded lounge", is_active: true, source_status: "active", consecutive_misses: 0, created_at: NOW, updated_at: NOW },
    { id: "v-gigs", city_id: "city-bg", name: "Gigs Only Hall", name_normalized: "gigs only hall", is_active: true, source_status: "active", consecutive_misses: 0, source_id: "ds-g", external_id: "gigs-venue-1", created_at: NOW, updated_at: NOW },
    { id: "v-ns", city_id: "city-ns", name: "Novi Sad Bar", name_normalized: "novi sad bar", is_active: true, source_status: "active", consecutive_misses: 0, source_id: "ds-osm", external_id: "node/7777777", created_at: NOW, updated_at: NOW },
  ]);
  const store = new SupabaseCanonicalStore(fake.asClient(), { now: () => NOW });
  await runStore(store);
  const dropped = fake.tables.venues.find((r) => r.external_id === "node/8008")!;
  fake.seed("events", [
    { id: "ev-past", venue_id: dropped.id, title: "Past gig", start_at: "2026-03-01T20:00:00.000Z", is_cancelled: false, source_id: "ds-g", external_id: "G-1", created_at: NOW, updated_at: NOW },
    { id: "ev-next", venue_id: dropped.id, title: "Next gig", start_at: "2026-12-01T20:00:00.000Z", is_cancelled: false, source_id: "ds-g", external_id: "G-2", created_at: NOW, updated_at: NOW },
  ]);
  fake.writes.length = 0;
  return { fake, store, droppedId: String(dropped.id) };
}
const lifecycleOf = (r: FakeRow) => [r.source_status ?? "active", r.consecutive_misses ?? 0, r.is_active];
const rowById = (fake: FakeSupabase, id: string) => fake.tables.venues.find((r) => r.id === id)!;
/** Writes in the log that touch row `id`. */
const writesTo = (fake: FakeSupabase, id: string) => fake.writes.filter((w) => w.filters.some(([c, v]) => c === "id" && v === id));
const lifecycleWrites = (fake: FakeSupabase) => fake.writes.filter((w) => "source_status" in w.values || "consecutive_misses" in w.values);

test("[lifecycle S1] healthy misses #1-#4: stale/active → missing/active → gone/INACTIVE → gone (no further write); events byte-identical, nothing deleted", async () => {
  const { fake, store, droppedId } = await lifecycleDb();
  const events = JSON.stringify(fake.tables.events);
  const venueCount = fake.tables.venues.length;
  const expected = [
    ["mark-stale", ["stale", 1, true]],
    ["mark-missing", ["missing", 2, true]],
    ["mark-gone", ["gone", 3, false]],
    ["no-op", ["gone", 3, false]],
  ] as const;
  for (const [i, [transition, state]] of expected.entries()) {
    fake.writes.length = 0;
    const p = await runStore(store, without8008);
    assert.equal(p.stats.healthy, true);
    assert.equal(p.reconciliation.actions.find((a) => a.key === DROPPED)!.transition, transition, `miss #${i + 1}`);
    assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), state, `miss #${i + 1}`);
    // only the dropped venue's lifecycle is written; nothing at all on miss #4
    assert.deepEqual(
      lifecycleWrites(fake).map((w) => w.filters.find(([c]) => c === "id")![1]),
      transition === "no-op" ? [] : [droppedId],
      `miss #${i + 1}`,
    );
    if (transition === "no-op") assert.deepEqual(writesTo(fake, droppedId), [], "a gone venue is not written again");
    assert.equal(JSON.stringify(fake.tables.events), events, "historical + future events untouched");
    assert.ok(!fake.writes.some((w) => w.table === "events"), "no event write");
    assert.equal(fake.tables.venues.length, venueCount, "no venue removed or added");
  }
  // every other Belgrade OSM venue stayed active with no misses
  for (const r of fake.tables.venues.filter((v) => v.source_id === "ds-osm" && v.city_id === "city-bg" && v.id !== droppedId)) {
    assert.deepEqual(lifecycleOf(r), ["active", 0, true], String(r.name));
  }
});

test("[lifecycle S2] a GONE venue seen again: same row reactivated, misses reset, no duplicate; then idempotent", async () => {
  const { fake, store, droppedId } = await lifecycleDb();
  for (let i = 0; i < 3; i++) await runStore(store, without8008);
  assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["gone", 3, false]);
  const venueCount = fake.tables.venues.length;

  const back = await runStore(store);
  const up = back.upserts.find((u) => u.record.provenance.externalId === "node/8008")!;
  assert.deepEqual([up.operation, up.identity.tier, up.canonicalId], ["link-only", 0, droppedId], "matched to its own row");
  assert.equal(back.reconciliation.actions.find((a) => a.key === DROPPED)!.transition, "keep-active");
  assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["active", 0, true]);
  assert.equal(fake.tables.venues.length, venueCount, "no duplicate venue");
  assert.equal(fake.tables.venues.filter((r) => r.external_id === "node/8008").length, 1);

  // repeated identical healthy snapshots: no lifecycle write, no new rows, nothing NEW
  for (let i = 0; i < 2; i++) {
    fake.writes.length = 0;
    const again = await runStore(store);
    assert.deepEqual(lifecycleWrites(fake), []);
    assert.ok(!fake.writes.some((w) => w.op === "insert"), "no insert");
    assert.equal(again.stats.byChangeStatus.NEW, 0);
    assert.equal(fake.tables.venues.length, venueCount);
  }
});

test("[lifecycle S3] stale / missing venues seen again reset to active (still active), misses 0", async () => {
  for (const misses of [1, 2]) {
    const { fake, store, droppedId } = await lifecycleDb();
    for (let i = 0; i < misses; i++) await runStore(store, without8008);
    assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), [misses === 1 ? "stale" : "missing", misses, true]);
    await runStore(store);
    assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["active", 0, true]);
  }
});

test("[lifecycle S4] failed / empty / collapsed / partial runs: no lifecycle write, no miss increment, no is_active change — even for a SEEN stale venue in a partial run", async () => {
  const provider = createOsmConfigProvider([BELGRADE]);
  async function planAndApply(s: SupabaseCanonicalStore, transport: () => Promise<OverpassResponse>, completeness?: "partial") {
    const adapter = createOsmOverpassAdapter({ targets: [BELGRADE], config: CONFIG, transport, now: () => NOW });
    const p = await planSync({ adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store: s, now: NOW, runId: "r", completeness });
    const res = await s.apply(p, { commit: true });
    assert.equal(res.error, null);
  }
  const only = (...ids: number[]) => async (): Promise<OverpassResponse> => ({ elements: (FIXTURE.elements ?? []).filter((e) => ids.includes(e.id)) });
  const scenarios: [string, (s: SupabaseCanonicalStore) => Promise<void>][] = [
    ["failed", (s) => planAndApply(s, async () => { throw new Error("Overpass returned an error remark: runtime error"); })],
    ["empty", (s) => planAndApply(s, async () => ({ elements: [] }))],
    ["collapsed", (s) => planAndApply(s, only(1001))],
    ["partial (8008 seen)", (s) => planAndApply(s, only(1001, 8008), "partial")],
    ["partial (8008 unseen)", (s) => planAndApply(s, only(1001), "partial")],
  ];
  for (const [name, run] of scenarios) {
    const { fake, store, droppedId } = await lifecycleDb();
    await runStore(store, without8008); // one healthy miss → stale
    const before = JSON.stringify(fake.tables.venues.map(lifecycleOf));
    fake.writes.length = 0;
    await run(store);
    assert.deepEqual(lifecycleWrites(fake), [], `${name}: no lifecycle write`);
    assert.ok(!fake.writes.some((w) => "is_active" in w.values), `${name}: no is_active write`);
    assert.equal(JSON.stringify(fake.tables.venues.map(lifecycleOf)), before, `${name}: every venue's lifecycle unchanged`);
    assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["stale", 1, true], name);
  }
});

test("[lifecycle S5] only this source's in-scope venues are reconciled: hand-seeded, other-source and out-of-scope-city venues are never touched", async () => {
  const { fake, store } = await lifecycleDb();
  for (let i = 0; i < 4; i++) await runStore(store, without8008);
  for (const id of ["v-manual", "v-gigs", "v-ns"]) {
    assert.deepEqual(lifecycleOf(rowById(fake, id)), ["active", 0, true], id);
    assert.deepEqual(writesTo(fake, id), [], `${id}: never written`);
  }
});

test("[lifecycle S6] zero events, present in OSM → stays active across healthy runs with no lifecycle writes", async () => {
  const { fake, store } = await lifecycleDb();
  fake.seed("events", []); // no venue has any event
  for (let i = 0; i < 4; i++) {
    fake.writes.length = 0;
    await runStore(store);
    assert.deepEqual(lifecycleWrites(fake), []);
  }
  for (const r of fake.tables.venues.filter((v) => v.source_id === "ds-osm" && v.city_id === "city-bg")) {
    assert.deepEqual(lifecycleOf(r), ["active", 0, true], String(r.name));
  }
});

test("[lifecycle S7] content sync is unchanged alongside lifecycle: a reappearing gone venue with changed tags is reactivated AND updated", async () => {
  const { fake, store, droppedId } = await lifecycleDb();
  for (let i = 0; i < 3; i++) await runStore(store, without8008);
  const changed: OverpassResponse = {
    elements: (FIXTURE.elements ?? []).map((e) => (e.id === 8008 ? { ...e, tags: { ...e.tags, website: "https://random.example" } } : e)),
  };
  const first = await runStore(store, changed);
  const up = first.upserts.find((u) => u.record.provenance.externalId === "node/8008")!;
  assert.equal(up.canonicalId, droppedId);
  assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["active", 0, true]);
  if (rowById(fake, droppedId).website !== "https://random.example") await runStore(store, changed);
  assert.equal(rowById(fake, droppedId).website, "https://random.example", "the OSM content update is still applied");
  assert.equal(fake.tables.venues.filter((r) => r.external_id === "node/8008").length, 1);
});

test("[lifecycle S8] a curated is_active = false on an ACTIVE-lifecycle OSM venue is kept while OSM still has it (only GONE → seen reactivates)", async () => {
  const { fake, store, droppedId } = await lifecycleDb();
  rowById(fake, droppedId).is_active = false; // hidden by a curator; lifecycle still active
  fake.writes.length = 0;
  await runStore(store);
  await runStore(store);
  assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["active", 0, false]);
  assert.ok(!fake.writes.some((w) => "is_active" in w.values));
});

// ── is_active has TWO meanings (one column) ──────────────────────────────
// `venues.is_active` is both (a) source-lifecycle availability — set false by
// the sync at `gone`, true again when the source returns it — and (b) a
// curator's manual hide. There is no separate column for either. The sync
// therefore only ever writes is_active on its OWN transitions (→ gone,
// gone → seen); content sync never writes it (OSM omits isActive) and a
// stale/missing reset leaves it alone. These tests pin both sides, including
// the one case where the meanings collide.

test("[lifecycle S9] curated hide survives a stale/missing → active reset: lifecycle resets, is_active stays false", async () => {
  for (const misses of [1, 2]) {
    const { fake, store, droppedId } = await lifecycleDb();
    for (let i = 0; i < misses; i++) await runStore(store, without8008);
    rowById(fake, droppedId).is_active = false; // hidden by a curator while stale / missing
    fake.writes.length = 0;
    await runStore(store);
    assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["active", 0, false], `after ${misses} miss(es)`);
    assert.ok(!fake.writes.some((w) => "is_active" in w.values), "the reset writes source_status / consecutive_misses only");
  }
});

test("[lifecycle S10] KNOWN CONFLICT (current behaviour): a curator hide on a GONE venue is overridden when OSM returns it", async () => {
  const { fake, store, droppedId } = await lifecycleDb();
  for (let i = 0; i < 3; i++) await runStore(store, without8008);
  assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["gone", 3, false]);
  // a curator also hides it while gone: indistinguishable from the lifecycle's own false
  rowById(fake, droppedId).is_active = false;
  await runStore(store);
  // locked rule 6 wins: reappearance after gone → is_active = true
  assert.deepEqual(lifecycleOf(rowById(fake, droppedId)), ["active", 0, true]);
});

test("[lifecycle S11] locked contract, end to end on one venue: present → 3 misses → gone/inactive → 4th miss stays gone → back → active (no-write on miss #4: S1)", async () => {
  const { fake, store, droppedId } = await lifecycleDb();
  const trace: unknown[] = [lifecycleOf(rowById(fake, droppedId))];
  for (let i = 0; i < 4; i++) {
    await runStore(store, without8008);
    trace.push(lifecycleOf(rowById(fake, droppedId)));
  }
  await runStore(store);
  trace.push(lifecycleOf(rowById(fake, droppedId)));
  assert.deepEqual(trace, [
    ["active", 0, true],
    ["stale", 1, true],
    ["missing", 2, true],
    ["gone", 3, false],
    ["gone", 3, false],
    ["active", 0, true],
  ]);
  assert.equal(fake.tables.venues.filter((r) => r.external_id === "node/8008").length, 1, "same row throughout");
});
