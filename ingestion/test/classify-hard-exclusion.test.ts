/**
 * Institutional HARD EXCLUSIONS (`../src/classify.ts#INSTITUTIONAL_HARD_EXCLUSIONS`):
 * place_of_worship / school / university / hospital / clinic / library (and
 * healthcare=hospital|clinic, office=government) are never nightlife venues.
 * They are checked before the pinned excluded-amenity exception and before any
 * Layer C rescue, so nothing can bypass them — and an excluded element never
 * becomes a venue record, so it never reaches identity matching or an upsert.
 *
 * Regression: Crkva Svetog Petra (OSM way/794688668, amenity=place_of_worship).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INSTITUTIONAL_HARD_EXCLUSIONS,
  PINNED_RESCUE_BYPASSABLE_AMENITIES,
  classifyOsmElement,
  institutionalHardExclusion,
} from "../src/classify.ts";
import { toNormalizedVenue } from "../src/normalize.ts";
import { RESCUE_ENTRIES, type RescueEntry } from "../src/rescue.ts";
import { parseOverpassVenues } from "../src/sources/osm-overpass.ts";
import { OSM_SOURCE_KEY, createOsmConfigProvider, createOsmOverpassAdapter } from "../src/sync/adapters/osm-overpass.ts";
import { planSync } from "../src/sync/engine.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../src/sync/store.ts";
import type { IngestionTarget } from "../src/targets.ts";
import type { OverpassElement, OverpassResponse } from "../src/types.ts";

const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const PETAR_REF = "way/794688668";
/** The element's real OSM tags (Overpass, 2026-09-27). */
const PETAR_TAGS: Record<string, string> = {
  "addr:housenumber": "23",
  "addr:street": "Македонска",
  amenity: "place_of_worship",
  building: "yes",
  "building:levels": "2",
  denomination: "roman_catholic",
  int_name: "Crkva Svetog Petra",
  name: "Црква Светог Петра",
  "name:en": "St. Peter's Parrish Church (Jesuit)",
  "name:sr": "Црква Светог Петра",
  "name:sr-Latn": "Crkva Svetog Petra",
  religion: "christian",
  wikidata: "Q110048364",
  wikipedia: "sr:Црква Светог Петра у Београду",
};
const PETAR_ELEMENT: OverpassElement = { type: "way", id: 794688668, center: { lat: 44.81602, lon: 20.46398 }, tags: PETAR_TAGS };
const BAR_ELEMENT: OverpassElement = { type: "node", id: 1, lat: 44.8161, lon: 20.4641, tags: { amenity: "bar", name: "Test Bar" } };

const SAVA_REF = "way/203161878";
const SAVA_TAGS = { amenity: "conference_centre", name: "Сава центар", "name:sr-Latn": "Sava centar" };

const reason = (r: ReturnType<typeof classifyOsmElement>) => (r.accepted ? `ACCEPTED ${r.via}` : r.reason);
const PETAR_REASON = "institutional hard exclusion: amenity=place_of_worship";

/** Run `fn` with temporary extra rescue entries; always removed afterwards. */
async function withEntries<T>(entries: RescueEntry[], fn: () => T | Promise<T>): Promise<T> {
  RESCUE_ENTRIES.push(...entries);
  try {
    return await fn();
  } finally {
    for (const e of entries) RESCUE_ENTRIES.splice(RESCUE_ENTRIES.indexOf(e), 1);
  }
}
const PINNED_PETAR: RescueEntry = {
  countryId: "RS", cityName: "Belgrade", name: "Crkva Svetog Petra", aliases: ["Crkva Svetog Petra"],
  category: "concert_hall", osmRef: PETAR_REF, note: "test-only (Recall Audit n/a)",
};
const PINNED_PETAR_OPT_IN = { ...PINNED_PETAR, excludedAmenityAllowed: "place_of_worship" } as unknown as RescueEntry;
const NAMED_PETAR: RescueEntry = { ...PINNED_PETAR, osmRef: undefined };

// ── 1–2. the exclusion itself ────────────────────────────────────────────
test("every institutional category is hard excluded", () => {
  const cases: [Record<string, string>, string][] = [
    [{ amenity: "place_of_worship" }, "amenity=place_of_worship"],
    [{ amenity: "school" }, "amenity=school"],
    [{ amenity: "university" }, "amenity=university"],
    [{ amenity: "hospital" }, "amenity=hospital"],
    [{ amenity: "clinic" }, "amenity=clinic"],
    [{ amenity: "library" }, "amenity=library"],
    [{ healthcare: "hospital", amenity: "bar" }, "healthcare=hospital"],
    [{ healthcare: "clinic", amenity: "nightclub" }, "healthcare=clinic"],
    [{ office: "government", amenity: "bar" }, "office=government"],
  ];
  for (const [tags, what] of cases) {
    assert.equal(reason(classifyOsmElement({ name: "X", ...tags }, "node/9", BELGRADE)), `institutional hard exclusion: ${what}`, what);
    assert.equal(institutionalHardExclusion(tags), `institutional hard exclusion: ${what}`);
  }
  // even a strong nightlife signal does not rescue an institution
  assert.equal(reason(classifyOsmElement({ amenity: "place_of_worship", name: "X", live_music: "yes", concert: "yes" })), "institutional hard exclusion: amenity=place_of_worship");
});

test("Crkva Svetog Petra (way/794688668, real tags) is hard excluded", () => {
  assert.equal(reason(classifyOsmElement(PETAR_TAGS, PETAR_REF, BELGRADE)), PETAR_REASON);
  assert.equal(reason(classifyOsmElement(PETAR_TAGS)), PETAR_REASON);
});

// ── 3–5. no rescue can bypass it ─────────────────────────────────────────
test("a pinned rescue on the exact ref cannot override place_of_worship — not even one declaring the opt-in", async () => {
  await withEntries([PINNED_PETAR], () => assert.equal(reason(classifyOsmElement(PETAR_TAGS, PETAR_REF, BELGRADE)), PETAR_REASON));
  await withEntries([PINNED_PETAR_OPT_IN], () => assert.equal(reason(classifyOsmElement(PETAR_TAGS, PETAR_REF, BELGRADE)), PETAR_REASON));
});

test("a name-only rescue cannot override place_of_worship", async () => {
  await withEntries([NAMED_PETAR], () => {
    assert.equal(reason(classifyOsmElement(PETAR_TAGS, PETAR_REF, BELGRADE)), PETAR_REASON);
    assert.equal(reason(classifyOsmElement({ ...PETAR_TAGS, name: "Crkva Svetog Petra" }, "way/1", BELGRADE)), PETAR_REASON);
  });
});

test("a wrong OSM ref cannot bypass the exclusion (the pin is for another object)", async () => {
  await withEntries([PINNED_PETAR_OPT_IN], () => {
    for (const ref of ["way/1", "node/794688668", "relation/794688668", "way/7946886680"]) {
      assert.equal(reason(classifyOsmElement(PETAR_TAGS, ref, BELGRADE)), PETAR_REASON, ref);
    }
  });
});

// ── 6. candidate boundary ────────────────────────────────────────────────
test("a hard-excluded element never becomes a venue candidate (toNormalizedVenue / parseOverpassVenues), even when pinned", async () => {
  await withEntries([PINNED_PETAR_OPT_IN], () => {
    assert.deepEqual(toNormalizedVenue(PETAR_ELEMENT, BELGRADE), { excluded: { ref: PETAR_REF, name: "Црква Светог Петра", reason: PETAR_REASON } });
    const { venues, excluded } = parseOverpassVenues({ elements: [PETAR_ELEMENT, BAR_ELEMENT] } as OverpassResponse, BELGRADE);
    assert.deepEqual(venues.map((v) => v.externalId), ["node/1"]);
    assert.deepEqual(excluded, [{ ref: PETAR_REF, name: "Црква Светог Петра", reason: PETAR_REASON }]);
  });
});

// ── 7. never reaches identity matching or an upsert ─────────────────────
test("the OSM sync adapter emits no record for it, so the engine never matches it — even to a same-named canonical venue", async () => {
  const sameName: CanonicalVenue = {
    id: "v-petar", cityId: "city-bg", cityName: "Belgrade", countryCode: "RS",
    name: "Crkva Svetog Petra", normalizedName: "crkva svetog petra",
    address: null, coordinates: null, coordinatesSource: null, website: null, wikidata: null, openingHours: null,
    description: null, openingTime: null, closingTime: null, isActive: true,
    sourceKey: null, externalId: null, sourceUrl: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const run = async () => {
    const store = new InMemoryCanonicalStore({ cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade" }], venues: [sameName] });
    const adapter = createOsmOverpassAdapter({
      targets: [BELGRADE],
      config: { supabaseUrl: "", supabaseServiceRoleKey: "", overpassUrl: "https://overpass.test", overpassUserAgent: "t" },
      transport: async () => ({ elements: [PETAR_ELEMENT, BAR_ELEMENT] }),
      now: () => "2026-09-27T00:00:00.000Z",
    });
    // the adapter's parse output is exactly what the engine matches
    const refs = [];
    const ctx = { defaultCountryCode: "RS", defaultTimeZone: "Europe/Belgrade", scopeConfig: {}, userAgent: "t", cities: ["Belgrade"], limit: 0, verbose: false };
    for await (const r of adapter.discover(ctx)) refs.push(r);
    const parsed = adapter.parse(await adapter.fetch(refs[0], ctx), ctx);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.records.map((r) => r.provenance.externalId), ["node/1"]);

    const config = createOsmConfigProvider([BELGRADE]);
    const plan = await planSync({ adapter, source: config.source(OSM_SOURCE_KEY)!, config, store, now: "2026-09-27T00:00:00.000Z", runId: "t" });
    const touches = (id: string) =>
      plan.upserts.some((u) => u.record.provenance.externalId === PETAR_REF || u.canonicalId === id || u.identity.canonicalId === id) ||
      plan.reviewItems.some((r) => r.record.provenance.externalId === PETAR_REF || r.suggestedCanonicalId === id);
    assert.equal(touches("v-petar"), false, "no upsert, link or review for the church or the same-named venue");
    assert.deepEqual(plan.upserts.map((u) => [u.record.provenance.externalId, u.operation]), [["node/1", "insert"]]);
    await store.apply(plan, { commit: true });
    assert.deepEqual(store.venues.map((v) => v.name).sort(), ["Crkva Svetog Petra", "Test Bar"], "only the bar was inserted; the canonical row is untouched");
    assert.equal(store.venues.find((v) => v.id === "v-petar")?.sourceKey, null);
  };
  await run();
  await withEntries([PINNED_PETAR_OPT_IN], run);
});

// ── 8–9. the Sava Centar exception is unchanged and stays narrow ───────
test("Sava Centar's exact pinned conference_centre rescue still works", () => {
  const r = classifyOsmElement(SAVA_TAGS, SAVA_REF, BELGRADE);
  assert.equal(reason(r), "ACCEPTED Layer C rescue: Sava Centar");
});

test("an unrelated conference_centre is not accepted (no pin, or a pin for another object)", () => {
  assert.equal(reason(classifyOsmElement({ amenity: "conference_centre", name: "Some Congress Hall" }, "way/42", BELGRADE)), "amenity=conference_centre");
  assert.equal(reason(classifyOsmElement(SAVA_TAGS, "way/42", BELGRADE)), "amenity=conference_centre");
});

test("the bypassable allowlist is exactly conference_centre and shares nothing with the institutional exclusions", () => {
  assert.deepEqual([...PINNED_RESCUE_BYPASSABLE_AMENITIES], ["conference_centre"]);
  for (const a of PINNED_RESCUE_BYPASSABLE_AMENITIES) assert.equal(INSTITUTIONAL_HARD_EXCLUSIONS.amenity.has(a), false, a);
});

// ── 10. only the institutional tag excludes ─────────────────────────────
test("the same object tagged as an ordinary nightlife amenity goes through normal classification", () => {
  assert.equal(reason(classifyOsmElement({ ...PETAR_TAGS, amenity: "bar" }, PETAR_REF, BELGRADE)), "ACCEPTED Layer A: amenity=bar");
  assert.equal(reason(classifyOsmElement({ ...PETAR_TAGS, amenity: "cafe" }, PETAR_REF, BELGRADE)), "cafe without a documented nightlife signal");
  assert.equal(institutionalHardExclusion({ amenity: "bar", building: "church", religion: "christian" }), null, "a church BUILDING used as a bar is not excluded by building/religion alone");
});
