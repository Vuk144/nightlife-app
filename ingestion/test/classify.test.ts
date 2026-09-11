import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOsmElement,
  nightlifeSignal,
  KAFANA_NAME_OVERPASS,
  KAFANA_NAME_REGEX,
  SHISHA_NAME_OVERPASS,
  SHISHA_NAME_REGEX,
  SPLAV_NAME_OVERPASS,
  SPLAV_NAME_REGEX,
} from "../src/classify.ts";
import type { IngestionTarget } from "../src/targets.ts";

const BELGRADE: IngestionTarget = {
  countryId: "RS",
  cityName: "Belgrade",
  osmRelationId: 2728438,
};

function accept(tags: Record<string, string>, ref?: string): string {
  const r = classifyOsmElement(tags, ref, BELGRADE);
  assert.ok(r.accepted, `expected accepted, got: ${JSON.stringify(r)}`);
  return r.accepted ? r.category : "";
}
function reject(tags: Record<string, string>): string {
  const r = classifyOsmElement(tags, "node/1", BELGRADE);
  assert.ok(!r.accepted, `expected rejected, got: ${JSON.stringify(r)}`);
  return r.accepted ? "" : r.reason;
}
function classify(tags: Record<string, string>, ref?: string) {
  return classifyOsmElement(tags, ref, BELGRADE);
}
function sig(tags: Record<string, string>, amenity = "", name = "") {
  return nightlifeSignal(tags, amenity, name);
}

// ── Layer A — automatic, music optional ───────────────────────────────
test("Layer A accepts core nightlife categories unconditionally", () => {
  assert.equal(accept({ amenity: "nightclub", name: "A" }), "nightclub");
  assert.equal(accept({ amenity: "music_venue", name: "B" }), "nightclub");
  assert.equal(accept({ club: "music", name: "C" }), "nightclub");
  assert.equal(accept({ amenity: "bar", name: "D" }), "bar");
  assert.equal(accept({ amenity: "pub", name: "E" }), "pub_brewery");
  assert.equal(accept({ amenity: "biergarten", name: "F" }), "pub_brewery");
  assert.equal(accept({ club: "nightlife", name: "G" }), "other_nightlife");
});

test("Layer A: a bar with no music metadata is still accepted", () => {
  assert.equal(accept({ amenity: "bar", name: "Plain Bar" }), "bar");
  assert.equal(accept({ amenity: "pub", name: "Plain Pub" }), "pub_brewery");
});

test("Layer A: karaoke, dance and brewpub", () => {
  assert.equal(accept({ amenity: "bar", karaoke: "yes", name: "K" }), "bar");
  assert.equal(accept({ karaoke: "yes", amenity: "cafe", name: "Karaoke Room" }), "other_nightlife");
  assert.equal(accept({ leisure: "dance", name: "Tango" }), "other_nightlife");
  reject({ leisure: "dance", "dance:teaching": "yes", name: "School" });
  assert.equal(accept({ craft: "brewery", amenity: "pub", name: "Brewpub" }), "pub_brewery");
});

test("club=social is NOT Layer A — needs a signal", () => {
  reject({ club: "social", name: "Društveni klub" });
  assert.equal(accept({ club: "social", live_music: "yes", name: "Social Club w/ gigs" }), "nightlife_venue");
});

// ── Layer B — strong / medium / weak ─────────────────────────────────
test("Layer B: strong signal accepts (silent)", () => {
  const r = classify({ amenity: "restaurant", live_music: "yes", name: "Live" });
  assert.ok(r.accepted && !r.review);
  assert.equal(accept({ amenity: "cafe", music: "live", name: "M" }), "nightlife_venue");
  assert.equal(accept({ amenity: "restaurant", dancing: "yes", name: "D" }), "other_nightlife");
  assert.equal(accept({ amenity: "restaurant", microbrewery: "yes", name: "BP" }), "pub_brewery");
});

test("Layer B: concert hall / performance venue -> concert_hall", () => {
  assert.equal(
    accept({ amenity: "theatre", "theatre:type": "concert_hall", name: "Hall" }),
    "concert_hall",
  );
  assert.equal(accept({ amenity: "arts_centre", concert: "yes", name: "Arts" }), "concert_hall");
  assert.equal(
    accept({ amenity: "community_centre", community_centre: "music", name: "DK" }),
    "nightlife_venue",
  );
});

test("Layer B: medium signal accepts WITH a review flag", () => {
  const r = classify({ amenity: "restaurant", bar: "yes", name: "Resto+Bar" });
  assert.ok(r.accepted && r.review === true);
});

test("Layer B: a plain restaurant / cafe / theatre is rejected", () => {
  reject({ amenity: "restaurant", cuisine: "italian", name: "Ordinary" });
  reject({ amenity: "cafe", name: "Coffee Shop" });
  reject({ amenity: "theatre", name: "Narodno pozorište" });
  reject({ amenity: "arts_centre", tourism: "gallery", name: "Gallery" });
});

test("Layer B: arts_centre is NOT automatic — needs a signal", () => {
  reject({ amenity: "arts_centre", name: "Bare Arts Centre" });
  assert.equal(accept({ amenity: "arts_centre", live_music: "yes", name: "AC w/ music" }), "concert_hall");
});

// ── Cafe tightening ─────────────────────────────────────────────────
test("cafe + bar=yes ALONE is a WEAK signal -> rejected", () => {
  const reason = reject({ amenity: "cafe", bar: "yes", name: "Rocket Coffee" });
  assert.match(reason, /weak signal/);
});
test("cafe + bar=yes + a strong signal -> accepted", () => {
  assert.equal(accept({ amenity: "cafe", bar: "yes", live_music: "yes", name: "Music Cafe" }), "nightlife_venue");
});

// ── Regional name layers ───────────────────────────────────────────
test("kafana / mehana / birtija / krčma names -> kafana", () => {
  assert.equal(accept({ amenity: "restaurant", name: "Kafana Znak Pitanja" }), "kafana");
  assert.equal(accept({ amenity: "bar", name: "Стара механа" }), "kafana");
  reject({ amenity: "restaurant", name: "Restoran Dva Jelena" }); // no rescue ref, name not a kafana word
});

test("splav: bar/nightclub accept; restaurant needs a meaningful signal", () => {
  assert.equal(accept({ amenity: "bar", name: "Splav Bar X" }), "other_nightlife");
  assert.equal(accept({ amenity: "nightclub", name: "Splav Freestyler" }), "nightclub");
  // restaurant + splav name, no signal, no drinking-venue word -> excluded
  assert.match(reject({ amenity: "restaurant", name: "Splav Riblji Restoran" }), /splav/);
  // restaurant + splav name + "cocktail bar" in the name -> accepted + review
  const named = classify({ amenity: "restaurant", name: "Splav Sunset Cocktail Bar" });
  assert.ok(named.accepted && named.review === true);
  // restaurant + splav name + a real signal -> accepted + review
  const signalled = classify({ amenity: "restaurant", live_music: "yes", name: "Splav Y" });
  assert.ok(signalled.accepted && signalled.review === true);
  reject({ amenity: "cafe", name: "Splav Cafe Z" });
});

test("shisha: a named shisha lounge (cafe) is medium; a plain cafe with shisha tag is weak", () => {
  const named = classify({ amenity: "cafe", name: "Nargila Lounge" });
  assert.ok(named.accepted && named.review === true);
  reject({ amenity: "cafe", shisha: "yes", name: "Ordinary Cafe" });
  assert.equal(accept({ amenity: "bar", shisha: "yes", name: "Shisha Bar" }), "bar"); // bar is Layer A anyway
});

// ── Hard exclusions ────────────────────────────────────────────────
test("hard exclusions win over everything", () => {
  assert.match(reject({ shop: "wine", name: "Vinoteka" }), /shop/);
  assert.match(reject({ office: "company", name: "Firma" }), /office/);
  assert.match(reject({ amenity: "fast_food", name: "Burek" }), /fast_food/);
  assert.match(reject({ amenity: "cinema", name: "Bioskop" }), /cinema/);
  assert.match(reject({ amenity: "casino", name: "Casino" }), /casino/);
  assert.match(reject({ amenity: "conference_centre", name: "Sava Centar" }), /conference_centre/);
  assert.match(reject({ amenity: "social_facility", name: "Prihvatilište" }), /social_facility/);
  assert.match(reject({ "disused:amenity": "nightclub", name: "Former" }), /lifecycle/);
  assert.match(reject({ amenity: "bar", disused: "yes", name: "Gone" }), /disused/);
  assert.match(reject({ tourism: "hotel", name: "Hotel Moskva" }), /lodging/);
  assert.match(reject({ club: "chess", name: "Šahovski klub" }), /club=chess/);
  assert.match(
    reject({ amenity: "community_centre", community_centre: "for_the_elderly", name: "Penzioneri" }),
    /community_centre/,
  );
});

test("a hotel node that is ALSO a bar is kept", () => {
  assert.equal(accept({ amenity: "bar", tourism: "hotel", name: "Rooftop Bar" }), "bar");
});

test("private/members without a signal is rejected; with club=music or a signal it is kept", () => {
  assert.match(reject({ amenity: "bar", access: "private", name: "Private" }), /access=private/);
  assert.equal(accept({ club: "music", access: "members", name: "Members Music Club" }), "nightclub");
  assert.equal(
    accept({ amenity: "restaurant", access: "private", live_music: "yes", name: "Speakeasy" }),
    "nightlife_venue",
  );
});

// ── nightlifeSignal tiers ─────────────────────────────────────────
test("nightlifeSignal returns the strongest tier found", () => {
  assert.equal(sig({ live_music: "regularly" }).strength, "strong");
  assert.equal(sig({ concert: "yes" }).strength, "strong");
  assert.equal(sig({ "theatre:type": "concert_hall" }).strength, "strong");
  assert.equal(sig({ community_centre: "music" }).strength, "strong");
  assert.equal(sig({ bar: "yes" }, "restaurant").strength, "medium");
  assert.equal(sig({ bar: "yes" }, "cafe").strength, "weak");
  assert.equal(sig({ live_music: "no" }).strength, "none");
  assert.equal(sig({ cuisine: "pizza" }).strength, "none");
  assert.equal(sig({ smoking: "yes", live_music: "yes" }).strength, "strong");
  assert.match(sig({}, "cafe", "Jazz Club Foo").reason ?? "", /music\/performance/);
});

// ════════════════════════════════════════════════════════════════════════
//  AUDIT PASS — characterization + one regression (shop=no / office=no)
// ════════════════════════════════════════════════════════════════════════

const TRI_SESIRA_REF = "way/150590534"; // a confirmed Layer C rescue osmRef

// ── REGRESSION — `shop=no` / `office=no` are NEGATIONS, not exclusions ──
test("[regression] shop=no / office=no must NOT exclude a venue (they mean 'not a shop/office')", () => {
  assert.equal(accept({ amenity: "bar", shop: "no", name: "Bar not a shop" }), "bar");
  assert.equal(accept({ amenity: "bar", office: "no", name: "Bar not an office" }), "bar");
  assert.equal(accept({ amenity: "nightclub", shop: "no", name: "Club" }), "nightclub");
  // a real shop value still excludes
  assert.match(reject({ amenity: "bar", shop: "wine", name: "Wine Bar Shop" }), /shop=wine/);
  assert.match(reject({ amenity: "bar", shop: "vacant", name: "Vacant" }), /shop=vacant/);
});

// ── hard exclusion beats a curated rescue — every exclusion kind ──
test("[precedence] every hard-exclusion kind still wins over a rescue osmRef", () => {
  const withRef = (tags: Record<string, string>) => classifyOsmElement(tags, TRI_SESIRA_REF, BELGRADE);
  assert.match((withRef({ shop: "wine", name: "Tri šešira" }) as { reason: string }).reason, /shop=wine/);
  assert.match((withRef({ office: "company", name: "Tri šešira" }) as { reason: string }).reason, /office=company/);
  assert.match((withRef({ amenity: "fast_food", name: "Tri šešira" }) as { reason: string }).reason, /fast_food/);
  assert.match((withRef({ "disused:amenity": "restaurant", name: "Tri šešira" }) as { reason: string }).reason, /lifecycle/);
  assert.match((withRef({ tourism: "hotel", name: "Tri šešira" }) as { reason: string }).reason, /lodging/);
  assert.match(
    (withRef({ amenity: "community_centre", community_centre: "for_the_elderly", name: "Tri šešira" }) as { reason: string }).reason,
    /community_centre/,
  );
});

test("[precedence] access=private with no signal is a step-0 exclusion — it blocks even a rescue osmRef", () => {
  const r = classifyOsmElement({ amenity: "restaurant", access: "private", name: "Tri šešira" }, TRI_SESIRA_REF, BELGRADE);
  assert.ok(!r.accepted);
  if (!r.accepted) assert.match(r.reason, /access=private/);
  // …but a public signal lets the same element through (and the rescue then wins)
  const withSignal = classifyOsmElement(
    { amenity: "restaurant", access: "private", live_music: "yes", name: "Tri šešira" },
    TRI_SESIRA_REF,
    BELGRADE,
  );
  assert.ok(withSignal.accepted && withSignal.rescued === true && withSignal.review === true);
});

// ── Layer A precedence over Layer B ──
test("[precedence] a Layer A amenity is accepted at Layer A even when a Layer B path would also apply", () => {
  // craft=brewery + amenity=bar: Layer A (amenity=bar) fires before Layer B (craft=brewery)
  const r = classify({ amenity: "bar", craft: "brewery", name: "Craft Bar" });
  assert.ok(r.accepted);
  if (r.accepted) assert.match(r.via, /Layer A: amenity=bar/);
});

// ── Layer A: leisure=dance teaching-school exclusion is unconditional ──
test("[characterization] leisure=dance + dance:teaching=yes is rejected even with a strong signal", () => {
  // The teaching-school carve-out is a targeted Layer A sub-rule, not signal-gated.
  assert.match(
    reject({ leisure: "dance", "dance:teaching": "yes", live_music: "yes", name: "Dance School w/ concerts" }),
    /teaching school/,
  );
  // a non-teaching dance venue is Layer A
  assert.equal(accept({ leisure: "dance", name: "Milonga" }), "other_nightlife");
});

// ── nightlifeSignal: strength selection & tie behaviour ──
test("[signal] a weaker signal never overwrites a stronger one; equal strength keeps the FIRST", () => {
  // strong (live_music) + medium (bar=yes on restaurant) -> strong
  const s1 = sig({ live_music: "yes", bar: "yes" }, "restaurant");
  assert.equal(s1.strength, "strong");
  assert.equal(s1.kind, "music");
  // two strong signals (music + brewery) -> the first considered (music) wins the tie
  const s2 = sig({ live_music: "yes", microbrewery: "yes" }, "restaurant");
  assert.equal(s2.strength, "strong");
  assert.equal(s2.kind, "music");
});

test("[signal] multiple WEAK signals never combine into a medium/strong", () => {
  const s = sig({ alcohol: "yes", outdoor_seating: "yes", smoking: "yes", cocktails: "yes" }, "cafe");
  assert.equal(s.strength, "weak");
  // …so a plain cafe with only those is still rejected at Layer B
  assert.match(reject({ amenity: "cafe", alcohol: "yes", outdoor_seating: "yes", name: "Cafe" }), /weak signal/);
});

test("[signal] NEGATIVE values (no/none/false/0) are not signals", () => {
  for (const v of ["no", "none", "false", "0"]) {
    assert.equal(sig({ live_music: v }).strength, "none", `live_music=${v}`);
    assert.equal(sig({ brewery: v }).strength, "none", `brewery=${v}`);
  }
  assert.equal(sig({ bar: "no" }, "restaurant").strength, "none");
});

// ── regional name layers: matching, case, script, substring ──
test("[name-layer] kafana/mehana names match Latin & Cyrillic, either case, anywhere in the name", () => {
  assert.equal(accept({ amenity: "restaurant", name: "Kafana Question" }), "kafana");
  assert.equal(accept({ amenity: "restaurant", name: "Question KAFANA" }), "kafana");
  assert.equal(accept({ amenity: "bar", name: "Стара механа" }), "kafana");
  assert.equal(accept({ amenity: "pub", name: "biRTiJa Foo" }), "kafana");
  // the amenity gate: a kafana-named element that is NOT restaurant/bar/pub/cafe is not a Band-C kafana
  reject({ amenity: "theatre", name: "Kafana Theatre" });
});

test("[name-layer][latent] substring name matching can false-positive on a real word ('carda' ⊂ 'Cardamom')", () => {
  // KNOWN LIMITATION: `*_NAME_REGEX` matches vocabulary terms as substrings with
  // no word boundary (a boundary would break the Cyrillic terms — `\b` needs an
  // ASCII `\w`). The `NAME_BASE_AMENITIES` / amenity gates and the small curated
  // vocabulary limit the blast radius. Pinned so the risk stays visible.
  assert.equal(KAFANA_NAME_REGEX.test("Cardamom"), true);
  assert.equal(classify({ amenity: "restaurant", name: "Cardamom" }).accepted, true); // wrongly -> kafana
});

test("[name-layer][guard] no regional vocabulary term contains a regex metacharacter", () => {
  // `*_NAME_OVERPASS` escapes its terms (audit B6); `*_NAME_REGEX` does NOT. That
  // asymmetry is only safe while every term is a plain literal. If this fails, a
  // new term needs escaping on the RegExp side too (and check for a load-time
  // SyntaxError from an unbalanced metacharacter).
  const META = /[.*+?^${}()|[\]\\]/;
  for (const pattern of [KAFANA_NAME_OVERPASS, SPLAV_NAME_OVERPASS, SHISHA_NAME_OVERPASS]) {
    for (const term of pattern.split("|")) {
      assert.equal(META.test(term), false, `term "${term}" contains a regex metacharacter`);
    }
  }
  // sanity: the raw-term regexes are valid and match their own vocabulary
  assert.ok(KAFANA_NAME_REGEX.test("kafana"));
  assert.ok(SPLAV_NAME_REGEX.test("splav"));
  assert.ok(SHISHA_NAME_REGEX.test("nargila"));
});

test("[name-layer] splav restaurant: accepted with a signal OR a drinking-venue word, else excluded", () => {
  const named = classify({ amenity: "restaurant", name: "Splav X Cocktail Bar" });
  assert.ok(named.accepted && named.review === true);
  const signalled = classify({ amenity: "restaurant", live_music: "yes", name: "Splav Y" });
  assert.ok(signalled.accepted && signalled.review === true);
  assert.match(reject({ amenity: "restaurant", name: "Splav Fish Restaurant" }), /splav restaurant with no nightlife signal/);
});

// ── Layer C rescue semantics ──
test("[rescue] a rescue result carries rescued=true and review=true and a 'Layer C rescue' via", () => {
  const r = classifyOsmElement({ amenity: "restaurant", name: "Tri šešira" }, TRI_SESIRA_REF, BELGRADE);
  assert.ok(r.accepted);
  if (r.accepted) {
    assert.equal(r.rescued, true);
    assert.equal(r.review, true);
    assert.match(r.via, /^Layer C rescue: /);
  }
});

test("[rescue] no ref or no target -> the rescue list is never consulted", () => {
  // Tri šešira tagged only as a plain restaurant: without a ref it must NOT rescue
  assert.ok(!classifyOsmElement({ amenity: "restaurant", name: "Tri šešira" }, undefined, BELGRADE).accepted);
  assert.ok(!classifyOsmElement({ amenity: "restaurant", name: "Tri šešira" }, TRI_SESIRA_REF, undefined).accepted);
});

// ── purity / determinism ──
test("[purity] classifyOsmElement and nightlifeSignal do not mutate their inputs and are deterministic", () => {
  const tags = { amenity: "restaurant", bar: "yes", live_music: "no", name: "Resto" };
  const before = JSON.stringify(tags);
  const a = classifyOsmElement(tags, "node/1", BELGRADE);
  const b = classifyOsmElement(tags, "node/1", BELGRADE);
  nightlifeSignal(tags, "restaurant", "Resto");
  assert.equal(JSON.stringify(tags), before, "tags object untouched");
  assert.deepEqual(a, b, "same input -> same result");
});

test("[boundary] empty / minimal / unknown tag shapes", () => {
  assert.ok(!classifyOsmElement({}, "node/1", BELGRADE).accepted);
  assert.ok(!classifyOsmElement({ name: "Nameless-amenity" }, "node/1", BELGRADE).accepted);
  assert.match(reject({ amenity: "parking", name: "Garaža" }), /amenity=parking not in scope/);
  assert.match(reject({ club: "chess", name: "Šah" }), /club=chess not in scope/);
});
