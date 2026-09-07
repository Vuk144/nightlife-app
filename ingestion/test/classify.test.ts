import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOsmElement, nightlifeSignal } from "../src/classify.ts";
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
