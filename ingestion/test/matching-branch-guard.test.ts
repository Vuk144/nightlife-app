/**
 * Tier 2 (same city + exact normalized name) must never merge two DISTINCT
 * objects of the same source. Real Belgrade case (OSM, 2026-09-29): two
 * "Tegla bar" places ~9.3 km apart, run by different operators —
 *   node/12790155919  amenity=bar   operator "Strafta bar d.o.o."   (canonical)
 *   node/6777839389   amenity=cafe  operator "KAMELEON FRESH ID d.o.o."  Баба-Вишњина 48
 * A shared name is no evidence they are one place, and the source itself lists
 * them as different objects: they are two venues. Tier 2 never merges them
 * (no match, flagged for review), and the outcome is the same whichever
 * object an OSM run meets first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveMatch, type MatchContext } from "../src/matching.ts";
import { OSM_SOURCE_KEY, createOsmConfigProvider, createOsmOverpassAdapter } from "../src/sync/adapters/osm-overpass.ts";
import { planSync } from "../src/sync/engine.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../src/sync/store.ts";
import { matchVenue, resolveVenueIdentity } from "../src/sync/venue-identity.ts";
import type { IngestionTarget } from "../src/targets.ts";
import type { ExistingVenue, NormalizedVenue, OverpassElement } from "../src/types.ts";

const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const OSM = "ds-osm";
const TEGLA_A = { ref: "node/12790155919", lat: 44.8356695, lon: 20.3674883 };
const TEGLA_B = { ref: "node/6777839389", lat: 44.8017079, lon: 20.4748766 };

function existing(over: Partial<ExistingVenue> & { id: string }): ExistingVenue {
  return {
    name: "Tegla bar", name_normalized: "tegla", source_id: OSM, external_id: TEGLA_A.ref, source_url: null,
    latitude: TEGLA_A.lat, longitude: TEGLA_A.lon, coordinates_source: "source", address: null, website: null,
    opening_hours: null, wikidata: null, ...over,
  };
}
function incoming(over: Partial<NormalizedVenue> = {}): NormalizedVenue {
  return {
    externalId: TEGLA_B.ref, osmType: "node", osmId: 6777839389, sourceUrl: `https://www.openstreetmap.org/${TEGLA_B.ref}`,
    name: "Tegla Bar", nameNormalized: "tegla", latitude: TEGLA_B.lat, longitude: TEGLA_B.lon,
    address: "Баба-Вишњина 48", website: null, openingHours: null, wikidata: null, category: "bar", ...over,
  };
}
const ctx = (rows: ExistingVenue[]): MatchContext => ({ target: BELGRADE, osmSourceId: OSM, existing: rows, consumed: new Set() });

// ── the matcher (Tier 2) ────────────────────────────────────────────────
test("Tier 2: a second OSM object sharing a canonical venue's exact name (a different branch) is NOT merged — no match, flagged", () => {
  const out = resolveMatch(incoming(), ctx([existing({ id: "v-tegla" })]));
  assert.equal(out.kind, "new");
  assert.equal(out.kind === "new" && out.review, true);
  assert.match(out.kind === "new" ? out.note ?? "" : "", /same source lists them as different objects — not merged by name/);
});

test("Tier 2: the guard is independent of distance — even a same-name object next door is not merged", () => {
  const out = resolveMatch(incoming({ latitude: TEGLA_A.lat + 0.0001, longitude: TEGLA_A.lon }), ctx([existing({ id: "v-tegla" })]));
  assert.equal(out.kind, "new");
});

test("Tier 0 still wins: the SAME OSM object re-imported matches its own row", () => {
  const out = resolveMatch(incoming({ externalId: TEGLA_A.ref, latitude: TEGLA_A.lat, longitude: TEGLA_A.lon }), ctx([existing({ id: "v-tegla" })]));
  assert.deepEqual(out.kind === "match" ? [out.tier, out.venue.id] : out, [0, "v-tegla"]);
});

test("Tier 2 is unchanged for an UNOWNED seed row and for another source's row (cross-source name match still links)", () => {
  for (const row of [
    existing({ id: "v-seed", source_id: null, external_id: null }), // manual seed: OSM claims it (existing behaviour)
    existing({ id: "v-other", source_id: "ds-other", external_id: "other-7" }), // another source's row
  ]) {
    const out = resolveMatch(incoming(), ctx([row]));
    assert.deepEqual(out.kind === "match" ? [out.tier, out.venue.id] : out, [2, row.id]);
  }
});

test("Tier 2 ambiguity (two same-name rows) is unchanged", () => {
  const out = resolveMatch(incoming(), ctx([existing({ id: "v-1", source_id: null, external_id: null }), existing({ id: "v-2", source_id: null, external_id: null })]));
  assert.equal(out.kind, "skip");
  assert.match(out.kind === "skip" ? out.note : "", /2 existing venues share/);
});

// ── the engine's venue identity wrapper ─────────────────────────────────
test("resolveVenueIdentity: same source, different object, same name → a new candidate, never the other object's canonical id", () => {
  const r = resolveVenueIdentity({
    incoming: { source: { sourceKey: "OpenStreetMap", externalId: TEGLA_B.ref, sourceUrl: null }, name: "Tegla Bar", normalizedName: "tegla", coordinates: { latitude: TEGLA_B.lat, longitude: TEGLA_B.lon }, address: null, website: null, wikidata: null },
    scope: { countryCode: "RS", cityName: "Belgrade" },
    existingInCity: [{ id: "v-tegla", name: "Tegla bar", normalizedName: "tegla", sourceKey: "OpenStreetMap", externalId: TEGLA_A.ref, sourceUrl: null, coordinates: { latitude: TEGLA_A.lat, longitude: TEGLA_A.lon }, coordinatesSource: "source", address: null, website: null, wikidata: null }],
  });
  assert.deepEqual([r.decision, r.canonicalId, r.reasonCode], ["new_candidate", null, "venue-new-candidate"]);
});

test("Tier 2 guard: every real OSM ref type (node / way / relation) on both sides is guarded", () => {
  for (const [a, b] of [["way/41234985", "node/6777839389"], ["relation/1", "way/2"], ["node/1", "relation/2"]]) {
    const out = resolveMatch(incoming({ externalId: b }), ctx([existing({ id: "v-tegla", external_id: a })]));
    assert.equal(out.kind, "new", `${a} vs ${b}`);
    assert.equal(out.kind === "new" && out.review, true);
  }
});

// ── the event pipeline shares the matcher: its ids are not OSM object refs ──
// An event source keys a venue by its own venue id, or — with no id — by the
// synthetic `name:<normalized>` fallback (engine.ts / event-venue-match.ts),
// which identifies no source object. Tier 2 keeps its existing behaviour there.
function eventMatch(existingExternalId: string, incomingExternalId: string) {
  return matchVenue({
    incoming: { source: { sourceKey: "gigstix", externalId: incomingExternalId, sourceUrl: null }, name: "Dom Omladine", normalizedName: "dom omladine", coordinates: null, address: null, website: null, wikidata: null },
    scope: { countryCode: "RS", cityName: "Belgrade" },
    existingInCity: [{ id: "v-dom", name: "Dom Omladine", normalizedName: "dom omladine", sourceKey: "gigstix", externalId: existingExternalId, sourceUrl: null, coordinates: null, coordinatesSource: null, address: null, website: null, wikidata: null }],
  });
}

test("event path: a synthetic name: fallback id (either side) still links at Tier 2 to the same source's same-name venue", () => {
  for (const [a, b] of [["name:dom omladine", "venue-42"], ["venue-42", "name:dom omladine"], ["venue-42", "venue-99"]]) {
    const out = eventMatch(a, b);
    assert.deepEqual(out.kind === "match" ? [out.tier, out.venue.id] : out, [2, "v-dom"], `${a} -> ${b}`);
  }
});

test("event path: a synthetic name: id never trips the OSM guard even against an OSM-ref row of the same source key", () => {
  for (const [a, b] of [["node/12790155919", "name:tegla"], ["name:tegla", "node/6777839389"]]) {
    const out = resolveMatch(incoming({ externalId: b }), ctx([existing({ id: "v-tegla", external_id: a })]));
    assert.deepEqual(out.kind === "match" ? [out.tier, out.venue.id] : out, [2, "v-tegla"], `${a} -> ${b}`);
  }
});

// ── a full OSM sync plan, both element orders ───────────────────────────
function canonicalTegla(): CanonicalVenue {
  return {
    id: "v-tegla", cityId: "city-bg", cityName: "Belgrade", countryCode: "RS", name: "Tegla bar", normalizedName: "tegla",
    address: null, coordinates: { latitude: TEGLA_A.lat, longitude: TEGLA_A.lon }, coordinatesSource: "source", website: null,
    wikidata: null, openingHours: "Mo-Sa 08:00-20:00; Su 09:00-18:30", description: null, openingTime: null, closingTime: null,
    isActive: true, sourceKey: OSM_SOURCE_KEY, externalId: TEGLA_A.ref, sourceUrl: `https://www.openstreetmap.org/${TEGLA_A.ref}`,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
}
const A_ELEMENT: OverpassElement = { type: "node", id: 12790155919, lat: TEGLA_A.lat, lon: TEGLA_A.lon, tags: { amenity: "bar", name: "Tegla bar", opening_hours: "Mo-Sa 08:00-20:00; Su 09:00-18:30", operator: "Strafta bar d.o.o." } };
// the real node is amenity=cafe (not discovered today); tagged as a bar here so the sync sees it
const B_ELEMENT: OverpassElement = { type: "node", id: 6777839389, lat: TEGLA_B.lat, lon: TEGLA_B.lon, tags: { amenity: "bar", name: "Tegla Bar", "addr:street": "Баба-Вишњина", "addr:housenumber": "48", operator: "KAMELEON FRESH ID d.o.o." } };

// Both objects in one snapshot: the engine already reserves the canonical row
// for its own object (engine.ts#reserveOwnedVenues), in either order.
for (const [label, elements] of [["canonical first", [A_ELEMENT, B_ELEMENT]], ["branch first", [B_ELEMENT, A_ELEMENT]]] as const) {
  test(`OSM sync plan, both objects present (${label}): the canonical row keeps its own object; the branch is its own new venue`, async () => {
    const store = new InMemoryCanonicalStore({ cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade" }], venues: [canonicalTegla()] });
    const adapter = createOsmOverpassAdapter({
      targets: [BELGRADE],
      config: { supabaseUrl: "", supabaseServiceRoleKey: "", overpassUrl: "https://overpass.test", overpassUserAgent: "t" },
      transport: async () => ({ elements: [...elements] }),
      now: () => "2026-09-29T00:00:00.000Z",
    });
    const config = createOsmConfigProvider([BELGRADE]);
    const plan = await planSync({ adapter, source: config.source(OSM_SOURCE_KEY)!, config, store, now: "2026-09-29T00:00:00.000Z", runId: "t" });

    const a = plan.upserts.find((u) => u.record.provenance.externalId === TEGLA_A.ref);
    assert.deepEqual([a?.identity.tier, a?.canonicalId], [0, "v-tegla"], "the canonical object matches its own row");
    const b = plan.upserts.find((u) => u.record.provenance.externalId === TEGLA_B.ref);
    assert.deepEqual([b?.operation, b?.changeStatus, b?.canonicalId, b?.identity.decision], ["insert", "NEW", null, "new_candidate"], "the branch is a new venue, not merged");
    assert.deepEqual(plan.reviewItems, []);

    await store.apply(plan, { commit: true });
    const tegla = store.venues.find((v) => v.id === "v-tegla")!;
    assert.deepEqual(tegla.coordinates, { latitude: TEGLA_A.lat, longitude: TEGLA_A.lon }, "the branch never overwrote the canonical row");
    assert.equal(tegla.externalId, TEGLA_A.ref);
    const branch = store.venues.filter((v) => v.id !== "v-tegla");
    assert.deepEqual(branch.map((v) => [v.externalId, v.coordinates]), [[TEGLA_B.ref, { latitude: TEGLA_B.lat, longitude: TEGLA_B.lon }]]);
  });
}

// The gap the Tier-2 guard closes: the canonical's own object is NOT in this
// snapshot (dropped / retagged in OSM, a partial run), so nothing reserves its
// row — before the guard the branch merged onto it at Tier 2 and overwrote it.
test("OSM sync plan, canonical's own object absent: the same-name branch is NOT merged onto the canonical row", async () => {
  const store = new InMemoryCanonicalStore({ cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade" }], venues: [canonicalTegla()] });
  const adapter = createOsmOverpassAdapter({
    targets: [BELGRADE],
    config: { supabaseUrl: "", supabaseServiceRoleKey: "", overpassUrl: "https://overpass.test", overpassUserAgent: "t" },
    transport: async () => ({ elements: [B_ELEMENT] }),
    now: () => "2026-09-29T00:00:00.000Z",
  });
  const config = createOsmConfigProvider([BELGRADE]);
  const plan = await planSync({ adapter, source: config.source(OSM_SOURCE_KEY)!, config, store, now: "2026-09-29T00:00:00.000Z", runId: "t", completeness: "partial" });

  const b = plan.upserts.find((u) => u.record.provenance.externalId === TEGLA_B.ref);
  assert.deepEqual([b?.operation, b?.canonicalId, b?.identity.decision], ["insert", null, "new_candidate"], "not linked to v-tegla");
  assert.equal(plan.upserts.some((u) => u.canonicalId === "v-tegla" || u.identity.canonicalId === "v-tegla"), false);

  await store.apply(plan, { commit: true });
  const tegla = store.venues.find((v) => v.id === "v-tegla")!;
  assert.deepEqual([tegla.externalId, tegla.coordinates], [TEGLA_A.ref, { latitude: TEGLA_A.lat, longitude: TEGLA_A.lon }], "canonical row untouched");
});
