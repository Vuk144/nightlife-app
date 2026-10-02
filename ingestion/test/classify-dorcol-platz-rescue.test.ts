/**
 * The pinned Dorćol Platz rescue (`../src/rescue.ts`, OSM node/4773685799,
 * amenity=arts_centre with no music tag). Evidence-backed and exact-ref only:
 * generic arts_centre stays signal-gated, institutional hard exclusions still
 * win, and only this one node id is added to the Overpass query.
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
const DORCOL_REF = "node/4773685799";
/** The element's real OSM tags (OSM API, 2026-09-29, version 4). */
const DORCOL_TAGS: Record<string, string> = {
  "addr:housenumber": "59b",
  "addr:street": "Добрачина",
  amenity: "arts_centre",
  email: "office@dorcolplatz.rs",
  name: "Dorćol Platz",
  "name:sr": "Дорћол плац",
  "name:sr-Latn": "Dorćol plac",
  phone: "+381 62 8325207",
  website: "http://dorcolplatz.rs/sr/naslovna/",
  wikidata: "Q87988668",
  wikipedia: "sr:Дорћол Platz",
};
const DORCOL_ELEMENT: OverpassElement = { type: "node", id: 4773685799, lat: 44.8233363, lon: 20.4669818, tags: DORCOL_TAGS };
const NO_SIGNAL = "arts_centre without a documented nightlife signal";

const classify = (tags: Record<string, string>, ref: string = DORCOL_REF, target: IngestionTarget = BELGRADE) =>
  classifyOsmElement(tags, ref, target);
const reason = (r: ReturnType<typeof classifyOsmElement>) => (r.accepted ? `ACCEPTED ${r.via}` : r.reason);

// ── the pinned rescue ───────────────────────────────────────────────────
test("Dorćol Platz node/4773685799 (amenity=arts_centre, no signal) is accepted through its pinned Layer C rescue as concert_hall", () => {
  assert.deepEqual(classify(DORCOL_TAGS), {
    accepted: true,
    category: "concert_hall",
    via: "Layer C rescue: Dorćol Platz",
    rescued: true,
    review: true,
  });
});

test("…and through the real parse path, as a rescued, review-flagged venue", () => {
  const { venues, excluded, invalid } = parseOverpassVenues({ elements: [DORCOL_ELEMENT] } as OverpassResponse, BELGRADE);
  assert.deepEqual(excluded, []);
  assert.deepEqual(invalid, []);
  assert.equal(venues.length, 1);
  assert.equal(venues[0].externalId, DORCOL_REF);
  assert.equal(venues[0].name, "Dorćol Platz");
  assert.equal(venues[0].category, "concert_hall");
  assert.equal(venues[0].rescued, true);
  assert.equal(venues[0].review, true);
  assert.equal(venues[0].wikidata, "Q87988668");
});

test("the entry is pinned by exact osmRef, Belgrade-only, with no excluded-amenity opt-in", () => {
  const entries = RESCUE_ENTRIES.filter((e) => e.osmRef === DORCOL_REF || e.name === "Dorćol Platz");
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.countryId, "RS");
  assert.equal(entry.cityName, "Belgrade");
  assert.equal(entry.osmRef, DORCOL_REF);
  assert.equal(entry.category, "concert_hall");
  assert.equal(entry.excludedAmenityAllowed, undefined);
  assert.deepEqual(entry.aliases, ["Dorćol Platz", "Dorcol Platz", "Dorćol plac", "Дорћол плац"]);
});

// ── generic arts_centre is unchanged ────────────────────────────────────
test("any other signal-less arts_centre is still rejected", () => {
  assert.equal(reason(classify({ amenity: "arts_centre", name: "Some Arts Centre" }, "node/1")), NO_SIGNAL);
  assert.equal(reason(classify({ amenity: "arts_centre", name: "Kulturni centar X" }, "way/2")), NO_SIGNAL);
  // no ref / no target: the rescue list is never consulted, even for the real tags
  assert.equal(reason(classifyOsmElement(DORCOL_TAGS)), NO_SIGNAL);
  assert.equal(reason(classifyOsmElement(DORCOL_TAGS, DORCOL_REF)), NO_SIGNAL);
  // control: a signalled arts_centre still enters through Layer B as before
  assert.equal(reason(classify({ amenity: "arts_centre", live_music: "yes", name: "AC" }, "node/3")), "ACCEPTED Layer B strong: live_music=yes");
});

test("the same or a similar name under ANY other OSM ref stays rejected", () => {
  const names = ["Dorćol Platz", "Dorcol Platz", "Dorćol plac", "Дорћол плац", "DORĆOL PLATZ"];
  const refs = ["node/1", "way/4773685799", "relation/4773685799", "node/47736857990", "node/477368579"];
  for (const ref of refs) {
    for (const name of names) {
      assert.equal(reason(classify({ ...DORCOL_TAGS, name }, ref)), NO_SIGNAL, `${ref} ${name}`);
    }
  }
  assert.equal(findRescue("RS", "Belgrade", "node/1", "dorcol platz"), null, "a pinned entry never matches by name");
});

test("the exact ref in the wrong city (or country) is rejected", () => {
  assert.equal(reason(classify(DORCOL_TAGS, DORCOL_REF, NOVI_SAD)), NO_SIGNAL);
  assert.equal(reason(classify(DORCOL_TAGS, DORCOL_REF, { ...BELGRADE, countryId: "HR" })), NO_SIGNAL);
  assert.equal(findRescue("RS", "Novi Sad", DORCOL_REF, "dorcol platz"), null);
  assert.equal(findRescue("RS", "Belgrade", DORCOL_REF, ""), RESCUE_ENTRIES.find((e) => e.osmRef === DORCOL_REF));
});

// ── hard exclusions still win ───────────────────────────────────────────
test("institutional hard exclusions still win over the pinned Dorćol Platz rescue", () => {
  const cases: [Record<string, string>, string][] = [
    [{ ...DORCOL_TAGS, amenity: "place_of_worship" }, "institutional hard exclusion: amenity=place_of_worship"],
    [{ ...DORCOL_TAGS, amenity: "school" }, "institutional hard exclusion: amenity=school"],
    [{ ...DORCOL_TAGS, amenity: "university" }, "institutional hard exclusion: amenity=university"],
    [{ ...DORCOL_TAGS, amenity: "hospital" }, "institutional hard exclusion: amenity=hospital"],
    [{ ...DORCOL_TAGS, amenity: "clinic" }, "institutional hard exclusion: amenity=clinic"],
    [{ ...DORCOL_TAGS, amenity: "library" }, "institutional hard exclusion: amenity=library"],
    // arts_centre kept, institutional secondary tag added
    [{ ...DORCOL_TAGS, healthcare: "clinic" }, "institutional hard exclusion: healthcare=clinic"],
    [{ ...DORCOL_TAGS, office: "government" }, "institutional hard exclusion: office=government"],
  ];
  for (const [tags, expected] of cases) assert.equal(reason(classify(tags)), expected);
});

test("every other hard exclusion still wins over the pinned rescue", () => {
  const cases: [Record<string, string>, string][] = [
    [{ ...DORCOL_TAGS, "disused:amenity": "arts_centre" }, 'lifecycle tag "disused:amenity"'],
    [{ ...DORCOL_TAGS, disused: "yes" }, "disused / abandoned"],
    [{ ...DORCOL_TAGS, shop: "gift" }, "shop=gift"],
    [{ ...DORCOL_TAGS, office: "company" }, "office=company"],
    [{ ...DORCOL_TAGS, amenity: "casino" }, "amenity=casino"],
    [{ ...DORCOL_TAGS, amenity: "conference_centre" }, "amenity=conference_centre"],
    [{ ...DORCOL_TAGS, access: "private" }, "access=private with no public nightlife signal"],
  ];
  for (const [tags, expected] of cases) assert.equal(reason(classify(tags)), expected);
});

// ── neighbouring rescues unchanged ──────────────────────────────────────
test("Sava Centar's pinned conference_centre rescue still works", () => {
  assert.equal(
    reason(classify({ amenity: "conference_centre", name: "Сава центар" }, "way/203161878")),
    "ACCEPTED Layer C rescue: Sava Centar",
  );
  const optIns = RESCUE_ENTRIES.filter((e) => e.excludedAmenityAllowed).map((e) => e.name);
  assert.deepEqual(optIns, ["Sava Centar"], "Dorćol Platz adds no excluded-amenity opt-in");
});

test("every rescue entry is still ref-pinned and nothing is fetched by name", () => {
  assert.ok(RESCUE_ENTRIES.every((e) => e.osmRef), "no by-name rescue entries");
  assert.equal(rescueNameOverpass("RS", "Belgrade"), "");
});

// ── discovery boundary ──────────────────────────────────────────────────
test("the Overpass query fetches node/4773685799 by exact id, although no Layer B clause would match it", () => {
  const q = buildOverpassQuery(BELGRADE);
  assert.ok(rescueOsmRefs("RS", "Belgrade").node.includes(4773685799));
  assert.match(q, /\n  node\(id:[0-9,]*\b4773685799[,)]/);
  // it appears exactly once, and only in the Layer C id clause
  assert.equal(q.split("4773685799").length - 1, 1);
  // arts_centre is only ever requested together with a signal filter: every
  // clause naming arts_centre carries a second tag filter, and — evaluated
  // against the real tags — the ONLY clause that returns the node is its
  // Layer C id clause (no Layer B signal or name clause matches it)
  const artsClauses = q.split("\n").filter((line) => line.includes("arts_centre"));
  assert.ok(artsClauses.length > 0);
  for (const line of artsClauses) {
    const filters = line.match(/\["[^"]+"(?:[=~]"[^"]*"(?:,i)?)?\]/g) ?? [];
    assert.equal(filters.length, 2, line);
  }
  const idClause = q.split("\n").find((l) => /^ {2}node\(id:/.test(l))!.trim();
  assert.deepEqual(matchingClauses(q, { type: "node", id: 4773685799, tags: DORCOL_TAGS }), [idClause]);
  assert.doesNotMatch(q, /\["amenity"="arts_centre"\]\(area/, "no unconditional arts_centre clause");
});

test("a different city's query never fetches the Dorćol Platz node", () => {
  assert.equal(rescueOsmRefs("RS", "Novi Sad").node.includes(4773685799), false);
  assert.doesNotMatch(buildOverpassQuery(NOVI_SAD), /4773685799/);
});

test("the OSM sync adapter emits Dorćol Platz as a venue record; a signal-less arts_centre beside it is dropped", async () => {
  const other: OverpassElement = { type: "node", id: 2, lat: 44.82, lon: 20.46, tags: { amenity: "arts_centre", name: "Other Arts Centre" } };
  const adapter = createOsmOverpassAdapter({
    targets: [BELGRADE],
    config: { supabaseUrl: "", supabaseServiceRoleKey: "", overpassUrl: "https://overpass.test", overpassUserAgent: "t" },
    transport: async () => ({ elements: [DORCOL_ELEMENT, other] }),
    now: () => "2026-09-29T00:00:00.000Z",
  });
  const ctx = { defaultCountryCode: "RS", defaultTimeZone: "Europe/Belgrade", scopeConfig: {}, userAgent: "t", cities: ["Belgrade"], limit: 0, verbose: false };
  const refs = [];
  for await (const r of adapter.discover(ctx)) refs.push(r);
  const parsed = adapter.parse(await adapter.fetch(refs[0], ctx), ctx);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.records.map((r) => r.provenance.externalId), [DORCOL_REF]);
  const [record] = parsed.records;
  assert.equal(record.kind, "venue");
  assert.equal(record.provenance.reported.category, "concert_hall");
  assert.equal(record.provenance.reported.rescued, true);
});
