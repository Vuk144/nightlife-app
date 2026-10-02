/**
 * Discovery ↔ classification alignment: every OSM object the CURRENT
 * classifier (`../src/classify.ts#classifyOsmElement`) accepts must be one the
 * production Overpass query (`../src/sources/osm-overpass/query.ts`) actually
 * fetches — otherwise the classifier rule can never take effect. The query may
 * fetch MORE (the classifier gates post-fetch); it must never fetch LESS.
 *
 * Regressions from the 2026-09-29 Belgrade audit:
 *   - Ben Akiba Comedy Club & Bar (node/7526304270, amenity=community_centre):
 *     accepted by the performance-name rule, never fetched.
 *   - DC Krov (node/10594728522, community_centre + club=social): fetched, and
 *     rejected by the classifier ON PURPOSE (club=social is signal-gated).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LAYER_B_AMENITIES, classifyOsmElement } from "../src/classify.ts";
import { buildOverpassQuery } from "../src/sources/osm-overpass.ts";
import type { IngestionTarget } from "../src/targets.ts";
import { matchingClauses, queryFetches, type QlElement } from "./overpass-ql-eval.ts";

const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const Q = buildOverpassQuery(BELGRADE);
let nextId = 9_000_000_000;
const el = (tags: Record<string, string>, type: QlElement["type"] = "node", id = nextId++): QlElement => ({ type, id, tags });
const accepts = (e: QlElement) => classifyOsmElement(e.tags, `${e.type}/${e.id}`, BELGRADE);

// ── the audit regressions ──────────────────────────────────────────────
/** Real tags, OSM 2026-09-29. */
const BEN_AKIBA = el({ amenity: "community_centre", "check_date": "2025-09-01", name: "Ben Akiba Comedy Club & Bar" }, "node", 7526304270);
const DC_KROV = el(
  { "addr:city": "Београд", "addr:floor": "4", "addr:housenumber": "47", "addr:street": "Краљице Марије", amenity: "community_centre", club: "social", name: "DC Krov", website: "https://dckrov.rs/", wikipedia: "sr:Društveni centar Krov" },
  "node",
  10594728522,
);

test("Ben Akiba (node/7526304270): the production query fetches it, and the existing classifier accepts it", () => {
  assert.deepEqual(accepts(BEN_AKIBA), {
    accepted: true,
    category: "nightlife_venue",
    via: "Layer B medium: name indicates a music/performance venue",
    review: true,
  });
  const clauses = matchingClauses(Q, BEN_AKIBA);
  assert.equal(clauses.length, 1, "exactly one clause: the Layer B performance-name clause");
  assert.match(clauses[0], /^nwr\["amenity"~"\^\(restaurant\|cafe\|theatre\|arts_centre\|community_centre\|social_centre\|events_venue\)\$"\]\["name"~"[^"]*comedy club[^"]*",i\]\(area\.bg\);$/);
});

test("club=social (DC Krov, node/10594728522): still fetched, still rejected on purpose — the classifier gates club=social on a signal", () => {
  assert.ok(queryFetches(Q, DC_KROV));
  assert.deepEqual(accepts(DC_KROV), { accepted: false, reason: "community_centre without a documented nightlife signal" });
  // club=social is fetched as a Layer B base, NOT as a Layer A "always nightlife" club value
  assert.match(Q, /\n {2}nwr\["club"~"\^\(music\|nightlife\)\$"\]\(area\.bg\);\n/);
  assert.match(Q, /\n {2}nwr\["club"="social"\]\(area\.bg\);\n/);
  assert.doesNotMatch(Q, /music\|nightlife\|social/);
});

test("club=social: accepted only with a documented signal; the query fetches every such object", () => {
  const cases: [Record<string, string>, boolean][] = [
    [{ club: "social", name: "Social Club" }, false], // no signal
    [{ club: "social", name: "Social Club", live_music: "yes" }, true],
    [{ club: "social", name: "Social Club", dancing: "yes" }, true],
    [{ club: "social", name: "Social Club", stage: "yes" }, true],
    [{ club: "social", name: "Social Club", amenity: "community_centre", concert: "yes" }, true],
  ];
  for (const [tags, accepted] of cases) {
    const e = el(tags);
    assert.equal(accepts(e).accepted, accepted, JSON.stringify(tags));
    assert.ok(queryFetches(Q, e), `fetched: ${JSON.stringify(tags)}`);
  }
  // the club fetch set is unchanged by moving `social` from Layer A to a Layer B base
  for (const v of ["music", "nightlife", "social"]) assert.ok(queryFetches(Q, el({ club: v, name: "x" })), v);
  for (const v of ["sport", "chess", "amateur_radio"]) assert.equal(queryFetches(Q, el({ club: v, name: "x" })), false, v);
});

// ── the systematic property: accepted ⇒ fetched ────────────────────────
/** Every strong / medium signal `nightlifeSignal` recognises (one fixture each). */
const SIGNALS: Record<string, string>[] = [
  { live_music: "yes" }, { music: "live" }, { music: "dj" }, { "music:live": "yes" }, { dj: "yes" },
  { karaoke: "yes" }, { concert: "yes" }, { concerts: "yes" },
  { "theatre:type": "concert_hall" }, { "theatre:type": "music" }, { "theatre:type": "cabaret" },
  { community_centre: "music" }, { community_centre: "arts" },
  { dancing: "yes" }, { disco: "yes" }, { dancefloor: "yes" }, { nightclub: "yes" }, { stage: "yes" },
  { "theatre:genre": "comedy" }, { "theatre:genre": "cabaret" }, { "theatre:genre": "stand_up" },
  { microbrewery: "yes" }, { brewery: "yes" }, { real_ale: "yes" }, { bar: "yes" },
  { name: "Jazz Club Test" }, { name: "Blues Club Test" }, { name: "Music Club Test" }, { name: "Live Music Test" },
  { name: "Open Mic Test" }, { name: "Test Comedy Club" }, { name: "Stand-up Test" }, { name: "Standup Test" },
  { name: "Kabare Test" }, { name: "Cabaret Test" }, { name: "Koncert Test" }, { name: "Nastup Test" },
];
const BASES: Record<string, string>[] = [
  ...[...LAYER_B_AMENITIES].map((amenity) => ({ amenity })),
  { craft: "brewery" },
  { club: "social" },
  { craft: "brewery", amenity: "restaurant" },
];
/** Layer A, regional name layers and brewpubs. */
const OTHER_ACCEPTED: Record<string, string>[] = [
  { amenity: "nightclub" }, { amenity: "music_venue" }, { amenity: "bar" }, { amenity: "pub" }, { amenity: "biergarten" },
  { amenity: "karaoke_box" }, { club: "music" }, { club: "nightlife" }, { karaoke: "yes" }, { leisure: "karaoke" },
  { leisure: "dance" }, { craft: "brewery", amenity: "pub" }, { craft: "brewery", amenity: "bar" },
  { amenity: "restaurant", name: "Kafana Test" }, { amenity: "cafe", name: "Кафана Тест" }, { amenity: "restaurant", name: "Mehana Test" },
  { amenity: "bar", name: "Splav Test" }, { amenity: "nightclub", name: "Splav Test" }, { amenity: "restaurant", name: "Splav Test", live_music: "yes" },
  { amenity: "restaurant", name: "Splav bar Test" }, { amenity: "cafe", name: "Shisha Lounge Test" },
];

test("every object the current classifier accepts is fetched by the production query (signal × base matrix + Layer A / regional)", () => {
  const accepted: QlElement[] = [];
  const rejected: QlElement[] = [];
  for (const base of BASES) {
    for (const signal of SIGNALS) {
      const e = el({ name: "Test Venue", ...base, ...signal });
      (accepts(e).accepted ? accepted : rejected).push(e);
    }
  }
  for (const tags of OTHER_ACCEPTED) {
    const e = el({ name: "Test Venue", ...tags });
    assert.ok(accepts(e).accepted, `fixture should be accepted: ${JSON.stringify(tags)}`);
    accepted.push(e);
  }
  assert.ok(accepted.length > 250, `non-vacuous: ${accepted.length} accepted fixtures`);
  const missed = accepted.filter((e) => !queryFetches(Q, e)).map((e) => JSON.stringify(e.tags));
  assert.deepEqual(missed, [], "accepted by the classifier but never fetched");
  // the only signal × base rejections: `bar=yes` is a signal on a restaurant
  // alone (medium; weak on a cafe; nothing elsewhere) — classifier behaviour
  assert.ok(rejected.length > 0);
  for (const e of rejected) {
    assert.equal(e.tags.bar, "yes", JSON.stringify(e.tags));
    assert.notEqual(e.tags.amenity, "restaurant", JSON.stringify(e.tags));
  }
});

// ── the query stays gated — no "fetch everything" ─────────────────────
test("the query is still server-gated: plain restaurants / cafes / cultural venues and non-signal names are NOT fetched", () => {
  const notFetched: Record<string, string>[] = [
    { amenity: "cafe", name: "Test Cafe" },
    { amenity: "restaurant", name: "Test Restaurant", cuisine: "serbian" },
    { amenity: "restaurant", name: "Test", outdoor_seating: "yes", opening_hours: "Mo-Su 08:00-02:00" },
    { amenity: "arts_centre", name: "Test Arts Centre" },
    { amenity: "theatre", name: "Test Theatre", "theatre:type": "drama" },
    { amenity: "events_venue", name: "Test Hall" },
    { amenity: "community_centre", name: "Test Community Centre" },
    // audit candidates that need a NEW relevance rule — deliberately still not fetched
    { amenity: "cafe", name: "Central pub" },
    { amenity: "restaurant", name: "Beervana gastro pub" },
    { amenity: "cafe", name: "Different Cafe and Lounge" },
    // not a Layer B base, so a performance name alone does not fetch it
    { amenity: "fast_food", name: "Comedy Club Burgers" },
    { amenity: "school", name: "Music Club School" },
  ];
  for (const tags of notFetched) assert.equal(queryFetches(Q, el(tags)), false, JSON.stringify(tags));
});

test("institutional objects stay rejected even when a fetched base/signal is present", () => {
  const institutional: Record<string, string>[] = [
    { amenity: "place_of_worship", club: "social", name: "x" },
    { amenity: "school", craft: "brewery", name: "x", live_music: "yes" },
  ];
  for (const tags of institutional) {
    const r = accepts(el(tags));
    assert.equal(r.accepted, false);
    assert.match(r.accepted ? "" : r.reason, /^institutional hard exclusion/);
  }
});

test("the evaluator understands every clause the builder emits (no silently skipped syntax)", () => {
  // parse errors would throw inside queryFetches; exercise the whole query once
  assert.equal(queryFetches(Q, el({ unrelated: "tag" })), false);
});
