/**
 * The narrow pinned-rescue exception to the hard amenity exclusion
 * (`../src/classify.ts#PINNED_RESCUE_BYPASSABLE_AMENITIES` +
 * `../src/rescue.ts#RescueEntry.excludedAmenityAllowed`), introduced for
 * Sava Centar (OSM way/203161878, amenity=conference_centre).
 *
 * The bypass needs ALL of: an entry pinned by the exact `osmRef`, that entry
 * declaring the amenity in `excludedAmenityAllowed`, and the amenity being in
 * the classifier's allowlist. Every other hard exclusion still wins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyOsmElement } from "../src/classify.ts";
import { RESCUE_ENTRIES, rescueNameOverpass, type RescueEntry } from "../src/rescue.ts";
import { buildOverpassQuery, parseOverpassVenues } from "../src/sources/osm-overpass.ts";
import type { IngestionTarget } from "../src/targets.ts";
import type { OverpassResponse } from "../src/types.ts";

const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const SAVA_REF = "way/203161878";
/** The element's real OSM tags (Overpass, 2026-09-27). */
const SAVA_TAGS: Record<string, string> = {
  "addr:housenumber": "9",
  "addr:street": "Милентија Поповића",
  amenity: "conference_centre",
  building: "yes",
  "building:levels": "4",
  int_name: "Sava centar",
  name: "Сава центар",
  "name:en": "Congress Center Sava",
  "name:sr": "Сава центар",
  "name:sr-Latn": "Sava centar",
  website: "http://www.savacentar.net/",
  wikidata: "Q1278216",
  wikipedia: "sr:Сава центар",
};
const classify = (tags: Record<string, string>, ref: string = SAVA_REF) => classifyOsmElement(tags, ref, BELGRADE);
const reason = (r: ReturnType<typeof classify>) => (r.accepted ? `ACCEPTED ${r.via}` : r.reason);

/** Run `fn` with a temporary extra rescue entry; always removed afterwards. */
function withEntry<T>(entry: RescueEntry, fn: () => T): T {
  RESCUE_ENTRIES.push(entry);
  try {
    return fn();
  } finally {
    RESCUE_ENTRIES.splice(RESCUE_ENTRIES.indexOf(entry), 1);
  }
}

// ── the pinned Sava Centar rescue ───────────────────────────────────────
test("Sava Centar way/203161878 (amenity=conference_centre) is accepted through its pinned Layer C rescue", () => {
  assert.deepEqual(classify(SAVA_TAGS), {
    accepted: true,
    category: "concert_hall",
    via: "Layer C rescue: Sava Centar",
    rescued: true,
    review: true,
  });
});

test("…and through the real parse path, as a rescued, review-flagged venue", () => {
  const element = { type: "way", id: 203161878, center: { lat: 44.8092156, lon: 20.4320957 }, tags: SAVA_TAGS };
  const { venues, excluded } = parseOverpassVenues({ elements: [element] } as OverpassResponse, BELGRADE);
  assert.deepEqual(excluded, []);
  assert.equal(venues.length, 1);
  assert.equal(venues[0].externalId, SAVA_REF);
  assert.equal(venues[0].rescued, true);
  assert.equal(venues[0].review, true);
  assert.equal(venues[0].category, "concert_hall");
});

// ── only the explicitly pinned object ───────────────────────────────────
test("the same conference_centre tags under ANY other OSM ref stay rejected", () => {
  for (const ref of ["way/1", "node/203161878", "relation/203161878", "way/2031618780"]) {
    assert.equal(reason(classify(SAVA_TAGS, ref)), "amenity=conference_centre", ref);
  }
  // no ref / no target: the rescue list is never consulted
  assert.equal(reason(classifyOsmElement(SAVA_TAGS)), "amenity=conference_centre");
  assert.equal(reason(classifyOsmElement(SAVA_TAGS, SAVA_REF)), "amenity=conference_centre");
});

test("a NAME-matched rescue cannot bypass the hard amenity exclusion — even one that declares the opt-in", () => {
  const nameEntry: RescueEntry = {
    countryId: "RS",
    cityName: "Belgrade",
    name: "Test Congress Hall",
    aliases: ["Test Congress Hall"],
    category: "concert_hall",
    excludedAmenityAllowed: "conference_centre", // no osmRef: must not count
    note: "test-only (Recall Audit n/a)",
  };
  withEntry(nameEntry, () => {
    assert.equal(reason(classify({ amenity: "conference_centre", name: "Test Congress Hall" }, "way/42")), "amenity=conference_centre");
    // control: the same name rescue DOES work for a non-excluded amenity
    assert.equal(reason(classify({ amenity: "arts_centre", name: "Test Congress Hall" }, "way/42")), "ACCEPTED Layer C rescue: Test Congress Hall");
  });
});

test("a pinned rescue for ANOTHER excluded amenity (casino) stays rejected", () => {
  // Sava Centar's own pin allows only conference_centre
  assert.equal(reason(classify({ ...SAVA_TAGS, amenity: "casino" })), "amenity=casino");
  // a pinned entry that (mis)declares casino is still refused: casino is not bypassable
  const casinoEntry = {
    countryId: "RS",
    cityName: "Belgrade",
    name: "Test Casino",
    aliases: ["Test Casino"],
    category: "nightlife_venue",
    osmRef: "node/999999999",
    excludedAmenityAllowed: "casino",
    note: "test-only (Recall Audit n/a)",
  } as unknown as RescueEntry;
  withEntry(casinoEntry, () => {
    assert.equal(reason(classify({ amenity: "casino", name: "Test Casino" }, "node/999999999")), "amenity=casino");
  });
});

test("every other hard exclusion still wins over the pinned Sava Centar rescue", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...SAVA_TAGS, "disused:amenity": "conference_centre" }, /^lifecycle tag "disused:amenity"$/],
    [{ ...SAVA_TAGS, "was:name": "Sava" }, /^lifecycle tag "was:name"$/],
    [{ ...SAVA_TAGS, disused: "yes" }, /^disused \/ abandoned$/],
    [{ ...SAVA_TAGS, abandoned: "yes" }, /^disused \/ abandoned$/],
    [{ ...SAVA_TAGS, shop: "mall" }, /^shop=mall$/],
    [{ ...SAVA_TAGS, office: "company" }, /^office=company$/],
    [{ ...SAVA_TAGS, access: "private" }, /^access=private with no public nightlife signal$/],
    [{ ...SAVA_TAGS, access: "members" }, /^access=members with no public nightlife signal$/],
    [{ ...SAVA_TAGS, access: "permit" }, /^access=permit with no public nightlife signal$/],
  ];
  for (const [tags, expected] of cases) assert.match(reason(classify(tags)), expected);
  // lodging-only (no amenity): unchanged
  const { amenity: _amenity, ...noAmenity } = SAVA_TAGS;
  assert.match(reason(classify({ ...noAmenity, tourism: "hotel" })), /^primarily lodging \(tourism=hotel\)$/);
});

// ── nothing else changes ───────────────────────────────────────────────
test("the 13 existing rescue elements (real OSM tags) classify exactly as before", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/overpass-belgrade-rescue.sample.json", import.meta.url), "utf8")) as OverpassResponse;
  // captured from the classifier BEFORE this change
  const expected: [string, string, string][] = [
    ["node/1634937968", "kafana", "Dva jelena"],
    ["node/1634937981", "kafana", "Zlatni bokal"],
    ["node/1634938018", "kafana", "Šešir moj"],
    ["node/4118716889", "nightlife_venue", "KC Grad"],
    ["node/6782874303", "bar", "Dorian Grey"],
    ["node/6844070707", "concert_hall", "Bitef Art Café"],
    ["node/12872107296", "concert_hall", "Studentski kulturni centar (SKC)"],
    ["node/13045146275", "kafana", "Grčka kraljica"],
    ["way/23671766", "nightlife_venue", "Cvijeta Zuzorić"],
    ["way/41234985", "concert_hall", "Dom omladine Beograda"],
    ["way/149635378", "kafana", "Ima dana"],
    ["way/150590534", "kafana", "Tri šešira"],
    ["way/393274192", "concert_hall", "Kolarac"],
  ];
  const elements = fixture.elements ?? [];
  assert.equal(elements.length, 13);
  const actual = elements.map((e) => {
    const ref = `${e.type}/${e.id}`;
    return [ref, classifyOsmElement(e.tags ?? {}, ref, BELGRADE)] as const;
  });
  for (const [ref, category, name] of expected) {
    const found = actual.find(([r]) => r === ref);
    assert.ok(found, ref);
    assert.deepEqual(found[1], { accepted: true, category, via: `Layer C rescue: ${name}`, rescued: true, review: true }, ref);
  }
});

test("conference_centre is NOT a general category: only one pinned entry uses the opt-in, and the query only adds its id", () => {
  const optIns = RESCUE_ENTRIES.filter((e) => e.excludedAmenityAllowed);
  assert.deepEqual(optIns.map((e) => [e.name, e.osmRef, e.excludedAmenityAllowed]), [["Sava Centar", SAVA_REF, "conference_centre"]]);
  // an unrelated conference centre anywhere else is still rejected
  assert.equal(reason(classify({ amenity: "conference_centre", name: "Some Congress Hall" }, "node/1")), "amenity=conference_centre");
  // the category query never asks for conference_centre; Layer C adds the exact id only
  const q = buildOverpassQuery(BELGRADE);
  assert.doesNotMatch(q, /conference_centre/);
  assert.match(q, /\n  way\(id:[0-9,]*\b203161878\);\n/);
  assert.equal(rescueNameOverpass("RS", "Belgrade"), "", "still no by-name rescue clause");
});
