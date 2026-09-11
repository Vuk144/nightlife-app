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

// ════════════════════════════════════════════════════════════════════════
//  AUDIT PASS — data integrity, osmRef isolation, helper determinism,
//  collision safety, known-duplicate contract. Characterization only.
// ════════════════════════════════════════════════════════════════════════

const VALID_CATEGORIES = new Set([
  "nightclub", "concert_hall", "bar", "pub_brewery",
  "kafana", "nightlife_venue", "other_nightlife",
]);

// ── 1. data integrity ──────────────────────────────────────────────

test("[data] every entry is structurally sound", () => {
  for (const e of RESCUE_ENTRIES) {
    assert.ok(e.name.trim().length > 0, "non-empty name");
    assert.ok(e.countryId.trim().length > 0 && e.cityName.trim().length > 0);
    assert.ok(Array.isArray(e.aliases) && e.aliases.length >= 1, `${e.name}: >=1 alias`);
    for (const a of e.aliases) {
      assert.equal(typeof a, "string");
      assert.equal(a.trim(), a, `${e.name}: alias "${a}" has surrounding whitespace`);
      assert.ok(a.length > 0, `${e.name}: empty alias`);
      assert.ok(computeNameNormalized(a).length > 0, `${e.name}: alias "${a}" normalizes to ""`);
    }
    assert.ok(VALID_CATEGORIES.has(e.category), `${e.name}: category ${e.category}`);
    assert.match(e.osmRef ?? "", /^(node|way|relation)\/[1-9]\d*$/, `${e.name}: osmRef`);
    assert.match(e.note, /Recall Audit/);
  }
});

test("[data] no duplicate osmRef, name, or (country,city,name) across entries", () => {
  const refs = RESCUE_ENTRIES.map((e) => e.osmRef);
  assert.equal(refs.length, new Set(refs).size, "osmRefs unique");
  const names = RESCUE_ENTRIES.map((e) => e.name);
  assert.equal(names.length, new Set(names).size, "names unique");
  const ids = RESCUE_ENTRIES.map((e) => `${e.countryId}|${e.cityName}|${e.name}`);
  assert.equal(ids.length, new Set(ids).size, "(country,city,name) unique");
});

test("[data][collision] no two entries in the same city share a normalized alias", () => {
  // Highest-priority invariant: an osmRef-less entry (none today) added later
  // must not normalize to the same key as another entry in its city, or
  // findRescue would be order-dependent. Enforced now so it stays true.
  const byCity = new Map<string, Map<string, string>>();
  for (const e of RESCUE_ENTRIES) {
    const cityKey = `${e.countryId}|${e.cityName}`;
    const seen = byCity.get(cityKey) ?? new Map<string, string>();
    for (const alias of e.aliases) {
      const norm = computeNameNormalized(alias);
      const owner = seen.get(norm);
      assert.ok(
        owner === undefined || owner === e.name,
        `${cityKey}: normalized alias "${norm}" claimed by both "${owner}" and "${e.name}"`,
      );
      seen.set(norm, e.name);
    }
    byCity.set(cityKey, seen);
  }
});

// ── 2. osmRef matching isolation ──────────────────────────────────

test("[osmRef] each entry is reachable by its own confirmed ref and returns itself", () => {
  for (const e of RESCUE_ENTRIES) {
    const hit = findRescue(e.countryId, e.cityName, e.osmRef!, "");
    assert.equal(hit?.name, e.name, `${e.osmRef} -> ${e.name}`);
  }
});

test("[osmRef] a ref only matches on EXACT string equality — type prefix is significant", () => {
  const tri = RESCUE_ENTRIES.find((e) => e.name === "Tri šešira")!;
  assert.equal(tri.osmRef, "way/150590534");
  const strongName = computeNameNormalized("Три шешира");
  // right ref -> match regardless of the incoming name
  assert.equal(findRescue("RS", "Belgrade", "way/150590534", strongName)?.name, "Tri šešira");
  // same numeric id, wrong type -> no match
  assert.equal(findRescue("RS", "Belgrade", "node/150590534", strongName), null);
  assert.equal(findRescue("RS", "Belgrade", "relation/150590534", strongName), null);
  // "(unknown)" (nameless element) and a bare id never match
  assert.equal(findRescue("RS", "Belgrade", "(unknown)", strongName), null);
  assert.equal(findRescue("RS", "Belgrade", "150590534", strongName), null);
});

test("[osmRef] country + city scoping is exact and case-sensitive (single source of truth: TARGETS)", () => {
  assert.equal(findRescue("RS", "Belgrade", "way/150590534", "")?.name, "Tri šešira");
  assert.equal(findRescue("RS", "Novi Sad", "way/150590534", ""), null);
  assert.equal(findRescue("FR", "Belgrade", "way/150590534", ""), null);
  assert.equal(findRescue("rs", "belgrade", "way/150590534", ""), null); // case-sensitive by design
});

// ── 3. name-based matching (currently dormant) ────────────────────

test("[name] findRescue is ref-only for the current data — every entry has an osmRef", () => {
  assert.ok(RESCUE_ENTRIES.every((e) => e.osmRef), "no osmRef-less entry exists");
  // so a perfect name match with the WRONG object never rescues
  assert.equal(findRescue("RS", "Belgrade", "node/999", computeNameNormalized("Tri šešira")), null);
  assert.equal(findRescue("RS", "Belgrade", "node/999", computeNameNormalized("Dorian Grey")), null);
});

test("[name] an empty incoming normalized name can never match (guard)", () => {
  for (const bad of ["", "   ".trim()]) {
    assert.equal(findRescue("RS", "Belgrade", "no/match", bad), null);
  }
});

// ── 4. rescueNameOverpass ────────────────────────────────────────

test("[overpass] rescueNameOverpass is '' whenever every entry is ref'd, and '' for an unknown city", () => {
  assert.equal(rescueNameOverpass("RS", "Belgrade"), "");
  assert.equal(rescueNameOverpass("RS", "Novi Sad"), "");
  assert.equal(rescueNameOverpass("XX", "Nowhere"), "");
});

// ── 5. rescueOsmRefs ─────────────────────────────────────────────

test("[overpass] rescueOsmRefs: only ref'd entries, grouped by type, deterministic order, positive ints", () => {
  const refs = rescueOsmRefs("RS", "Belgrade");
  const total = refs.node.length + refs.way.length + refs.relation.length;
  assert.equal(total, RESCUE_ENTRIES.length, "every ref'd entry contributes exactly one id");
  assert.equal(refs.relation.length, 0, "no relation refs in the current data");
  for (const arr of [refs.node, refs.way, refs.relation]) {
    for (const n of arr) assert.ok(Number.isInteger(n) && n > 0, `bad id ${n}`);
  }
  // deterministic across calls
  assert.deepEqual(rescueOsmRefs("RS", "Belgrade"), refs);
  // ids correspond to the entries' osmRefs, in entry order
  const expectWay = RESCUE_ENTRIES.filter((e) => e.osmRef!.startsWith("way/")).map((e) => Number(e.osmRef!.split("/")[1]));
  assert.deepEqual(refs.way, expectWay);
});

test("[overpass] rescueOsmRefs is empty for an unknown or wrong-case city", () => {
  assert.deepEqual(rescueOsmRefs("RS", "Novi Sad"), { node: [], way: [], relation: [] });
  assert.deepEqual(rescueOsmRefs("rs", "belgrade"), { node: [], way: [], relation: [] });
});

// ── 6. KNOWN_DUPLICATE_OSM_OBJECTS contract ──────────────────────

test("[known-dup] each canonical IS a rescue osmRef; each 'other' is NOT — so only the canonical can be rescued", () => {
  const allRefs = new Set(RESCUE_ENTRIES.map((e) => e.osmRef));
  for (const d of KNOWN_DUPLICATE_OSM_OBJECTS) {
    assert.match(d.canonical, /^(node|way|relation)\/[1-9]\d*$/);
    assert.match(d.other, /^(node|way|relation)\/[1-9]\d*$/);
    assert.notEqual(d.canonical, d.other);
    assert.ok(allRefs.has(d.canonical), `${d.venue}: canonical ${d.canonical} is a rescue osmRef`);
    assert.equal(allRefs.has(d.other), false, `${d.venue}: other ${d.other} must NOT be a rescue osmRef`);
    // and findRescue confirms it: the 'other' ref rescues nothing
    assert.equal(findRescue("RS", "Belgrade", d.other, ""), null);
  }
});

// ── 7. determinism / purity / cache ──────────────────────────────

test("[purity] findRescue does not mutate RESCUE_ENTRIES and is deterministic", () => {
  const snapshot = JSON.stringify(RESCUE_ENTRIES);
  const a = findRescue("RS", "Belgrade", "way/150590534", computeNameNormalized("x"));
  const b = findRescue("RS", "Belgrade", "way/150590534", computeNameNormalized("x"));
  assert.equal(a, b, "same entry object returned (identity), cache is a safe side-channel");
  assert.equal(JSON.stringify(RESCUE_ENTRIES), snapshot, "curated data untouched");
});

// ── 8. name.ts capital Ð / ẞ fix has no effect on rescue keys ─────

test("[name-fix] no rescue alias uses U+00D0 / U+00F0 / U+1E9E, so the name.ts eth/ẞ fix shifts no rescue key", () => {
  for (const e of RESCUE_ENTRIES) {
    for (const a of e.aliases) {
      assert.equal(/[Ððẞ]/.test(a), false, `${e.name}: alias "${a}"`);
      // normalization is stable across repeated calls
      assert.equal(computeNameNormalized(a), computeNameNormalized(a));
    }
  }
});
