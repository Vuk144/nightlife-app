import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESCUE_ENTRIES,
  KNOWN_DUPLICATE_OSM_OBJECTS,
  findRescue,
  rescueNameOverpass,
  rescueOsmRefs,
} from "../src/rescue.ts";
import { computeNameNormalized } from "../src/name.ts";
import { classifyOsmElement } from "../src/classify.ts";
import type { IngestionTarget } from "../src/targets.ts";

const BELGRADE: IngestionTarget = {
  countryId: "RS",
  cityName: "Belgrade",
  osmRelationId: 2728438,
};

test("every rescue entry is sourced and (now) has a confirmed osmRef", () => {
  for (const e of RESCUE_ENTRIES) {
    assert.ok(e.note.includes("Recall Audit"), `${e.name} has no evidence note`);
    assert.ok(e.aliases.length >= 1);
    assert.ok(e.countryId && e.cityName);
    assert.match(e.osmRef ?? "", /^(node|way|relation)\/\d+$/, `${e.name} needs an osmRef`);
  }
});

test("findRescue matches an entry ONLY by its confirmed osmRef", () => {
  // Tri šešira is osmRef way/150590534.
  assert.equal(
    findRescue("RS", "Belgrade", "way/150590534", computeNameNormalized("anything"))?.name,
    "Tri šešira",
  );
  // The same name on a DIFFERENT object is NOT rescued (kills the node/way dup).
  assert.equal(
    findRescue("RS", "Belgrade", "node/999999", computeNameNormalized("Три шешира")),
    null,
  );
});

test("findRescue is city-scoped", () => {
  assert.equal(findRescue("RS", "Novi Sad", "way/150590534", ""), null);
  assert.equal(findRescue("FR", "Paris", "node/12872107296", ""), null);
});

test("Cvijeta Zuzorić is fixed with a confirmed osmRef", () => {
  const entry = RESCUE_ENTRIES.find((e) => e.name === "Cvijeta Zuzorić");
  assert.equal(entry?.osmRef, "way/23671766");
  assert.equal(
    findRescue("RS", "Belgrade", "way/23671766", "")?.name,
    "Cvijeta Zuzorić",
  );
});

test("Dorian Grey was added to the rescue list as a genuine bar", () => {
  const entry = RESCUE_ENTRIES.find((e) => e.name === "Dorian Grey");
  assert.equal(entry?.osmRef, "node/6782874303");
  assert.equal(entry?.category, "bar");
});

test("the Bitef rescue points only at the events venue, not the theatre", () => {
  const bitef = RESCUE_ENTRIES.find((e) => e.name === "Bitef Art Café");
  assert.equal(bitef?.osmRef, "node/6844070707");
  assert.equal(
    findRescue("RS", "Belgrade", "node/12856588350", computeNameNormalized("БИТЕФ театар")),
    null,
    "BITEF teatar must NOT be rescued",
  );
});

test("rescueOsmRefs lists the confirmed ids; rescueNameOverpass is empty (all ref'd)", () => {
  const refs = rescueOsmRefs("RS", "Belgrade");
  assert.ok(refs.way.includes(41234985));
  assert.ok(refs.node.includes(12872107296));
  assert.ok(refs.node.includes(6782874303));
  assert.equal(rescueNameOverpass("RS", "Belgrade"), "");
});

test("known node/way duplicates are documented (not merged in code)", () => {
  assert.ok(KNOWN_DUPLICATE_OSM_OBJECTS.length >= 3);
  for (const d of KNOWN_DUPLICATE_OSM_OBJECTS) {
    assert.match(d.canonical, /^(node|way)\/\d+$/);
    assert.match(d.other, /^(node|way)\/\d+$/);
  }
});

// ── rescue via the classifier ───────────────────────────────────────
test("classifier rescues a Skadarlija kafana by osmRef, tagged only as restaurant", () => {
  const r = classifyOsmElement(
    { amenity: "restaurant", cuisine: "serbian", name: "Три шешира" },
    "way/150590534",
    BELGRADE,
  );
  assert.ok(r.accepted);
  if (r.accepted) {
    assert.equal(r.category, "kafana");
    assert.equal(r.rescued, true);
    assert.equal(r.review, true);
    assert.match(r.via, /Layer C rescue/);
  }
});

test("classifier rescues Dom omladine / Kolarac as concert halls by osmRef", () => {
  const dob = classifyOsmElement(
    { amenity: "arts_centre", name: "Дом омладине Београда" },
    "way/41234985",
    BELGRADE,
  );
  assert.ok(dob.accepted && dob.category === "concert_hall");
  const kol = classifyOsmElement(
    { amenity: "arts_centre", name: "Задужбина Илије М. Коларца" },
    "way/393274192",
    BELGRADE,
  );
  assert.ok(kol.accepted && kol.category === "concert_hall");
});

test("a hard exclusion still wins over a rescue entry", () => {
  const r = classifyOsmElement(
    { "disused:amenity": "restaurant", name: "Tri šešira" },
    "way/150590534",
    BELGRADE,
  );
  assert.ok(!r.accepted);
  if (!r.accepted) assert.match(r.reason, /lifecycle/);
});

test("the non-canonical duplicate object is not rescued and falls through", () => {
  // Grčka kraljica's canonical is node/13045146275; the building way is not.
  const r = classifyOsmElement(
    { building: "retail", name: "Грчка краљица" },
    "way/170969052",
    BELGRADE,
  );
  assert.ok(!r.accepted);
});
