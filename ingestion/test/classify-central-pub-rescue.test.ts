/**
 * The pinned Central pub rescue (`../src/rescue.ts`, OSM node/11928740863,
 * amenity=cafe with no nightlife tag). Evidence-backed and exact-ref only:
 * generic cafes stay signal-gated, there is no "pub in name" rule,
 * institutional hard exclusions still win, and only this one node id is added
 * to the Overpass query.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyOsmElement } from "../src/classify.ts";
import { RESCUE_ENTRIES, findRescue, rescueNameOverpass, rescueOsmRefs } from "../src/rescue.ts";
import { buildOverpassQuery, parseOverpassVenues } from "../src/sources/osm-overpass.ts";
import { createOsmOverpassAdapter } from "../src/sync/adapters/osm-overpass.ts";
import type { IngestionTarget } from "../src/targets.ts";
import type { OverpassElement, OverpassResponse } from "../src/types.ts";
import { matchingClauses } from "./overpass-ql-eval.ts";

const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const NOVI_SAD: IngestionTarget = { countryId: "RS", cityName: "Novi Sad", osmRelationId: 1373766 };
const CENTRAL_REF = "node/11928740863";
/** The element's real OSM tags (OSM API, 2026-09-30, version 2). */
const CENTRAL_TAGS: Record<string, string> = {
  amenity: "cafe",
  name: "Central pub",
  opening_hours: "Su-Th 08:00-24:00, Fr,Sa 08:00-01:00",
};
const CENTRAL_ELEMENT: OverpassElement = { type: "node", id: 11928740863, lat: 44.8221097, lon: 20.4090642, tags: CENTRAL_TAGS };
const NO_SIGNAL = "cafe without a documented nightlife signal";

const classify = (tags: Record<string, string>, ref: string = CENTRAL_REF, target: IngestionTarget = BELGRADE) =>
  classifyOsmElement(tags, ref, target);
const reason = (r: ReturnType<typeof classifyOsmElement>) => (r.accepted ? `ACCEPTED ${r.via}` : r.reason);

// ── the pinned rescue ───────────────────────────────────────────────────
test("Central pub node/11928740863 (amenity=cafe, no signal) is accepted through its pinned Layer C rescue as pub_brewery", () => {
  assert.deepEqual(classify(CENTRAL_TAGS), {
    accepted: true,
    category: "pub_brewery",
    via: "Layer C rescue: Central pub",
    rescued: true,
    review: true,
  });
});

test("…and through the real parse path, as a rescued, review-flagged venue", () => {
  const { venues, excluded, invalid } = parseOverpassVenues({ elements: [CENTRAL_ELEMENT] } as OverpassResponse, BELGRADE);
  assert.deepEqual(excluded, []);
  assert.deepEqual(invalid, []);
  assert.equal(venues.length, 1);
  assert.equal(venues[0].externalId, CENTRAL_REF);
  assert.equal(venues[0].name, "Central pub");
  assert.equal(venues[0].category, "pub_brewery");
  assert.equal(venues[0].rescued, true);
  assert.equal(venues[0].review, true);
});

test("the entry is pinned by exact osmRef, Belgrade-only, with no excluded-amenity opt-in", () => {
  const entries = RESCUE_ENTRIES.filter((e) => e.osmRef === CENTRAL_REF || e.name === "Central pub");
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.countryId, "RS");
  assert.equal(entry.cityName, "Belgrade");
  assert.equal(entry.osmRef, CENTRAL_REF);
  assert.equal(entry.category, "pub_brewery");
  assert.equal(entry.excludedAmenityAllowed, undefined);
  assert.deepEqual(entry.aliases, ["Central pub", "Central Pub"]);
});

// ── generic cafes are unchanged — no "pub in name" rule ──────────────────
test("a generic cafe with no nightlife signal is still rejected", () => {
  assert.equal(reason(classify({ amenity: "cafe", name: "Some Cafe" }, "node/1")), NO_SIGNAL);
  // no ref / no target: the rescue list is never consulted, even for the real tags
  assert.equal(reason(classifyOsmElement(CENTRAL_TAGS)), NO_SIGNAL);
  assert.equal(reason(classifyOsmElement(CENTRAL_TAGS, CENTRAL_REF)), NO_SIGNAL);
  // control: a signalled cafe still enters through Layer B as before
  assert.equal(reason(classify({ amenity: "cafe", live_music: "yes", name: "C" }, "node/3")), "ACCEPTED Layer B strong: live_music=yes");
});

test("other pub-named cafes / restaurants are NOT admitted — there is no general pub-in-name rule", () => {
  const cases: [Record<string, string>, string, string][] = [
    [{ amenity: "restaurant", name: "Gastro pub Fontana" }, "node/9817869691", "restaurant without a documented nightlife signal"],
    [{ amenity: "cafe", name: "Dalton’s Pub", opening_hours: "15:00-23:00" }, "way/1287966789", NO_SIGNAL],
    [{ amenity: "restaurant", name: "Republika Gastro Pub" }, "node/13762805664", "restaurant without a documented nightlife signal"],
    [{ amenity: "cafe", name: "Irish Pub" }, "node/5", NO_SIGNAL],
  ];
  for (const [tags, ref, expected] of cases) assert.equal(reason(classify(tags, ref)), expected, `${ref} ${tags.name}`);
});

test("the same or a similar name under ANY other OSM ref stays rejected", () => {
  const names = ["Central pub", "Central Pub", "CENTRAL PUB", "Central"];
  const refs = ["node/1", "way/11928740863", "relation/11928740863", "node/119287408630", "node/1192874086"];
  for (const ref of refs) {
    for (const name of names) {
      assert.equal(reason(classify({ ...CENTRAL_TAGS, name }, ref)), NO_SIGNAL, `${ref} ${name}`);
    }
  }
  assert.equal(findRescue("RS", "Belgrade", "node/1", "central pub"), null, "a pinned entry never matches by name");
});

test("the exact ref in the wrong city (or country) is rejected", () => {
  assert.equal(reason(classify(CENTRAL_TAGS, CENTRAL_REF, NOVI_SAD)), NO_SIGNAL);
  assert.equal(reason(classify(CENTRAL_TAGS, CENTRAL_REF, { ...BELGRADE, countryId: "HR" })), NO_SIGNAL);
  assert.equal(findRescue("RS", "Novi Sad", CENTRAL_REF, "central pub"), null);
  assert.equal(findRescue("RS", "Belgrade", CENTRAL_REF, ""), RESCUE_ENTRIES.find((e) => e.osmRef === CENTRAL_REF));
});

// ── hard exclusions still win ───────────────────────────────────────────
test("institutional hard exclusions still win over the pinned Central pub rescue", () => {
  const cases: [Record<string, string>, string][] = [
    [{ ...CENTRAL_TAGS, amenity: "place_of_worship" }, "institutional hard exclusion: amenity=place_of_worship"],
    [{ ...CENTRAL_TAGS, amenity: "school" }, "institutional hard exclusion: amenity=school"],
    [{ ...CENTRAL_TAGS, amenity: "university" }, "institutional hard exclusion: amenity=university"],
    [{ ...CENTRAL_TAGS, amenity: "hospital" }, "institutional hard exclusion: amenity=hospital"],
    [{ ...CENTRAL_TAGS, amenity: "clinic" }, "institutional hard exclusion: amenity=clinic"],
    [{ ...CENTRAL_TAGS, amenity: "library" }, "institutional hard exclusion: amenity=library"],
    // cafe kept, institutional secondary tag added
    [{ ...CENTRAL_TAGS, healthcare: "clinic" }, "institutional hard exclusion: healthcare=clinic"],
    [{ ...CENTRAL_TAGS, office: "government" }, "institutional hard exclusion: office=government"],
  ];
  for (const [tags, expected] of cases) assert.equal(reason(classify(tags)), expected);
});

test("every other hard exclusion still wins over the pinned rescue", () => {
  const cases: [Record<string, string>, string][] = [
    [{ ...CENTRAL_TAGS, "disused:amenity": "cafe" }, 'lifecycle tag "disused:amenity"'],
    [{ ...CENTRAL_TAGS, disused: "yes" }, "disused / abandoned"],
    [{ ...CENTRAL_TAGS, shop: "alcohol" }, "shop=alcohol"],
    [{ ...CENTRAL_TAGS, office: "company" }, "office=company"],
    [{ ...CENTRAL_TAGS, amenity: "fast_food" }, "amenity=fast_food"],
    [{ ...CENTRAL_TAGS, amenity: "casino" }, "amenity=casino"],
    [{ ...CENTRAL_TAGS, access: "private" }, "access=private with no public nightlife signal"],
  ];
  for (const [tags, expected] of cases) assert.equal(reason(classify(tags)), expected);
});

// ── neighbouring rescues unchanged ──────────────────────────────────────
test("the other pinned rescues still work and no excluded-amenity opt-in was added", () => {
  assert.equal(reason(classify({ amenity: "conference_centre", name: "Сава центар" }, "way/203161878")), "ACCEPTED Layer C rescue: Sava Centar");
  assert.equal(reason(classify({ amenity: "arts_centre", name: "Dorćol Platz" }, "node/4773685799")), "ACCEPTED Layer C rescue: Dorćol Platz");
  const optIns = RESCUE_ENTRIES.filter((e) => e.excludedAmenityAllowed).map((e) => e.name);
  assert.deepEqual(optIns, ["Sava Centar"], "Central pub adds no excluded-amenity opt-in");
});

test("every rescue entry is still ref-pinned and nothing is fetched by name", () => {
  assert.ok(RESCUE_ENTRIES.every((e) => e.osmRef), "no by-name rescue entries");
  assert.equal(rescueNameOverpass("RS", "Belgrade"), "");
});

// ── discovery boundary ──────────────────────────────────────────────────
test("the Overpass query fetches node/11928740863 by exact id, although no Layer B clause would match it", () => {
  const q = buildOverpassQuery(BELGRADE);
  assert.ok(rescueOsmRefs("RS", "Belgrade").node.includes(11928740863));
  assert.match(q, /\n  node\(id:[0-9,]*\b11928740863[,)]/);
  // it appears exactly once, and only in the Layer C id clause
  assert.equal(q.split("11928740863").length - 1, 1);
  // evaluated against the real tags, the ONLY clause that returns the node is
  // its Layer C id clause (no Layer B signal or name clause matches it)
  const idClause = q.split("\n").find((l) => /^ {2}node\(id:/.test(l))!.trim();
  assert.deepEqual(matchingClauses(q, { type: "node", id: 11928740863, tags: CENTRAL_TAGS }), [idClause]);
  // …and the same tags under any other id are not fetched at all
  assert.deepEqual(matchingClauses(q, { type: "node", id: 1, tags: CENTRAL_TAGS }), []);
  assert.doesNotMatch(q, /\["amenity"="cafe"\]\(area/, "no unconditional cafe clause");
});

test("a different city's query never fetches the Central pub node", () => {
  assert.equal(rescueOsmRefs("RS", "Novi Sad").node.includes(11928740863), false);
  assert.doesNotMatch(buildOverpassQuery(NOVI_SAD), /11928740863/);
});

test("the OSM sync adapter emits Central pub as a venue record; a signal-less cafe beside it is dropped", async () => {
  const other: OverpassElement = { type: "node", id: 2, lat: 44.82, lon: 20.41, tags: { amenity: "cafe", name: "Other Cafe" } };
  const adapter = createOsmOverpassAdapter({
    targets: [BELGRADE],
    config: { supabaseUrl: "", supabaseServiceRoleKey: "", overpassUrl: "https://overpass.test", overpassUserAgent: "t" },
    transport: async () => ({ elements: [CENTRAL_ELEMENT, other] }),
    now: () => "2026-09-30T00:00:00.000Z",
  });
  const ctx = { defaultCountryCode: "RS", defaultTimeZone: "Europe/Belgrade", scopeConfig: {}, userAgent: "t", cities: ["Belgrade"], limit: 0, verbose: false };
  const refs = [];
  for await (const r of adapter.discover(ctx)) refs.push(r);
  const parsed = adapter.parse(await adapter.fetch(refs[0], ctx), ctx);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.records.map((r) => r.provenance.externalId), [CENTRAL_REF]);
  const [record] = parsed.records;
  assert.equal(record.kind, "venue");
  assert.equal(record.provenance.reported.category, "pub_brewery");
  assert.equal(record.provenance.reported.rescued, true);
});
