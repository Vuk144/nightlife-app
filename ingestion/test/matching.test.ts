import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewNotesForNewVenues,
  resolveMatch,
  type MatchContext,
} from "../src/matching.ts";
import { VENUE_ALIASES } from "../src/aliases.ts";
import type { ExistingVenue, NormalizedVenue } from "../src/types.ts";

const BELGRADE = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };

function existingVenue(
  overrides: Partial<ExistingVenue> & { id: string; name: string },
): ExistingVenue {
  return {
    name_normalized: null,
    source_id: null,
    external_id: null,
    source_url: null,
    latitude: null,
    longitude: null,
    coordinates_source: null,
    address: null,
    website: null,
    opening_hours: null,
    wikidata: null,
    ...overrides,
  };
}

function incomingVenue(
  overrides: Partial<NormalizedVenue> & {
    name: string;
    nameNormalized: string;
    externalId: string;
    latitude: number;
    longitude: number;
  },
): NormalizedVenue {
  return {
    osmType: "node",
    osmId: 1,
    sourceUrl: `https://www.openstreetmap.org/${overrides.externalId}`,
    address: null,
    website: null,
    openingHours: null,
    wikidata: null,
    category: "bar",
    ...overrides,
  };
}

// Seeded Belgrade venues, post name_normalized backfill. Real coordinates.
const DRUGSTORE = existingVenue({
  id: "v-drugstore",
  name: "Drugstore",
  name_normalized: "drugstore",
  latitude: 44.8185264,
  longitude: 20.488357,
  coordinates_source: "manual",
});
const KST = existingVenue({
  id: "v-kst",
  name: "KST",
  name_normalized: "kst",
  latitude: 44.8055631,
  longitude: 20.4762304,
  coordinates_source: "manual",
});
const V2044 = existingVenue({
  id: "v-2044",
  name: "20/44",
  name_normalized: "20 44",
});
const SEEDED = [DRUGSTORE, KST, V2044];

function ctx(existing: ExistingVenue[], consumed: string[] = []): MatchContext {
  return {
    target: BELGRADE,
    osmSourceId: "osm-src",
    existing,
    consumed: new Set(consumed),
  };
}

// ---- required cases -------------------------------------------------------

test("Tier 3: Драгстор -> existing Drugstore (~90 m, no review flag)", () => {
  const incoming = incomingVenue({
    name: "Драгстор",
    nameNormalized: "dragstor",
    externalId: "node/5302622223",
    latitude: 44.8191,
    longitude: 20.48915,
    address: "Поенкареова 36",
  });
  const outcome = resolveMatch(incoming, ctx(SEEDED));
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") {
    assert.equal(outcome.tier, 3);
    assert.equal(outcome.venue.id, "v-drugstore");
    assert.ok(!outcome.review);
  }
});

test("Tier 3: Клуб студената технике -> existing KST (~74 m, no review flag)", () => {
  const incoming = incomingVenue({
    name: "Клуб студената технике",
    nameNormalized: "studenata tehnike",
    externalId: "node/4162210293",
    latitude: 44.80596,
    longitude: 20.47548,
    wikidata: "Q12752834",
  });
  const outcome = resolveMatch(incoming, ctx(SEEDED));
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") {
    assert.equal(outcome.tier, 3);
    assert.equal(outcome.venue.id, "v-kst");
    assert.ok(!outcome.review);
  }
});

test("Tier 2: 20/44 -> existing 20/44", () => {
  const incoming = incomingVenue({
    name: "20/44",
    nameNormalized: "20 44",
    externalId: "node/13111157561",
    latitude: 44.81408,
    longitude: 20.45124,
  });
  const outcome = resolveMatch(incoming, ctx(SEEDED));
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") {
    assert.equal(outcome.tier, 2);
    assert.equal(outcome.venue.id, "v-2044");
  }
});

test("Karmakoma does NOT match Drugstore even though it is closer (~58 m)", () => {
  const incoming = incomingVenue({
    name: "Karmakoma",
    nameNormalized: "karmakoma",
    externalId: "node/13359500428",
    latitude: 44.819,
    longitude: 20.48866,
  });
  const outcome = resolveMatch(incoming, ctx(SEEDED));
  assert.equal(outcome.kind, "new");
});

test("Haaï does NOT match Mala Scena 011 despite identical address and ~3 m coords", () => {
  const malaScena = existingVenue({
    id: "v-mala",
    name: "Mala Scena 011",
    name_normalized: "mala scena 011",
    latitude: 44.8036,
    longitude: 20.45475,
    coordinates_source: "source",
    address: "Сарајевска 26",
    source_id: "osm-src",
    external_id: "node/11445995855",
  });
  const incoming = incomingVenue({
    name: "Haaï",
    nameNormalized: "haai",
    externalId: "node/4162210291",
    latitude: 44.80363,
    longitude: 20.45477,
    address: "Сарајевска 26",
  });
  const outcome = resolveMatch(incoming, ctx([...SEEDED, malaScena]));
  assert.equal(outcome.kind, "new");
});

test("Хангар and Хангар 3 stay separate, and are flagged as look-alikes", () => {
  const hangar = incomingVenue({
    name: "Хангар",
    nameNormalized: "hangar",
    externalId: "node/13257326394",
    latitude: 44.82599,
    longitude: 20.47491,
  });
  const hangar3 = incomingVenue({
    name: "Хангар 3",
    nameNormalized: "hangar 3",
    externalId: "node/5260118422",
    latitude: 44.82702,
    longitude: 20.47548,
  });

  const context = ctx(SEEDED);
  assert.equal(resolveMatch(hangar, context).kind, "new");
  assert.equal(resolveMatch(hangar3, context).kind, "new");

  const notes = reviewNotesForNewVenues([hangar, hangar3], SEEDED);
  assert.match(notes.get("node/13257326394") ?? "", /Хангар 3/);
  assert.match(notes.get("node/5260118422") ?? "", /Хангар/);
});

// ---- other tiers --------------------------------------------------------

test("Tier 0: same source + external_id wins over everything", () => {
  const linked = existingVenue({
    id: "v-x",
    name: "X",
    name_normalized: "x",
    source_id: "osm-src",
    external_id: "node/999",
  });
  const incoming = incomingVenue({
    name: "Renamed",
    nameNormalized: "renamed",
    externalId: "node/999",
    latitude: 44.8,
    longitude: 20.4,
  });
  const outcome = resolveMatch(incoming, ctx([linked]));
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") {
    assert.equal(outcome.tier, 0);
    assert.equal(outcome.venue.id, "v-x");
  }
});

test("Tier 1: equal non-null Wikidata QID matches", () => {
  const venue = existingVenue({
    id: "v-w",
    name: "W",
    name_normalized: "w",
    wikidata: "Q42",
  });
  const incoming = incomingVenue({
    name: "Totally different",
    nameNormalized: "totally different",
    externalId: "node/1",
    latitude: 44.8,
    longitude: 20.4,
    wikidata: "Q42",
  });
  const outcome = resolveMatch(incoming, ctx([venue]));
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") assert.equal(outcome.tier, 1);
});

test("Tier 1: same dedicated domain matches; a shared platform host does not", () => {
  const dedicated = existingVenue({
    id: "v-d",
    name: "D",
    name_normalized: "d",
    website: "https://drugstore.rs/",
  });
  const incomingSame = incomingVenue({
    name: "D2",
    nameNormalized: "d2",
    externalId: "node/1",
    latitude: 44.8,
    longitude: 20.4,
    website: "http://www.drugstore.rs/events",
  });
  assert.equal(resolveMatch(incomingSame, ctx([dedicated])).kind, "match");

  const facebookVenue = existingVenue({
    id: "v-fb",
    name: "FB",
    name_normalized: "fb",
    website: "https://facebook.com/venue-one",
  });
  const incomingFacebook = incomingVenue({
    name: "FB2",
    nameNormalized: "fb2",
    externalId: "node/2",
    latitude: 44.8,
    longitude: 20.4,
    website: "https://facebook.com/venue-two",
  });
  assert.equal(resolveMatch(incomingFacebook, ctx([facebookVenue])).kind, "new");
});

test("Tier 2: more than one exact name match -> skip, never guess", () => {
  const a = existingVenue({ id: "a", name: "Twin", name_normalized: "twin" });
  const b = existingVenue({ id: "b", name: "Twin", name_normalized: "twin" });
  const incoming = incomingVenue({
    name: "Twin",
    nameNormalized: "twin",
    externalId: "node/1",
    latitude: 44.8,
    longitude: 20.4,
  });
  assert.equal(resolveMatch(incoming, ctx([a, b])).kind, "skip");
});

test("Tier 3: alias but > 1 km from the canonical venue -> not linked, review", () => {
  const incoming = incomingVenue({
    name: "Драгстор",
    nameNormalized: "dragstor",
    externalId: "node/9",
    latitude: 45.25,
    longitude: 19.83,
  });
  const outcome = resolveMatch(incoming, ctx(SEEDED));
  assert.equal(outcome.kind, "new");
  if (outcome.kind === "new") {
    assert.equal(outcome.review, true);
    assert.match(outcome.note ?? "", /not linked/);
  }
});

test("Tier 3: alias 300-1000 m from canonical -> linked but flagged for review", () => {
  // ~500 m due north of the seeded Drugstore
  const incoming = incomingVenue({
    name: "Драгстор",
    nameNormalized: "dragstor",
    externalId: "node/10",
    latitude: 44.823018,
    longitude: 20.488357,
  });
  const outcome = resolveMatch(incoming, ctx(SEEDED));
  assert.equal(outcome.kind, "match");
  if (outcome.kind === "match") {
    assert.equal(outcome.tier, 3);
    assert.equal(outcome.review, true);
  }
});

test("Tier 3: a second element aliasing to an already-linked venue -> new + review", () => {
  const context = ctx(SEEDED);
  const first = incomingVenue({
    name: "Драгстор",
    nameNormalized: "dragstor",
    externalId: "node/a",
    latitude: 44.8191,
    longitude: 20.48915,
  });
  const firstOutcome = resolveMatch(first, context);
  assert.equal(firstOutcome.kind, "match");
  if (firstOutcome.kind === "match") context.consumed.add(firstOutcome.venue.id);

  const second = incomingVenue({
    name: "Драгстор",
    nameNormalized: "dragstor",
    externalId: "node/b",
    latitude: 44.8191,
    longitude: 20.48915,
  });
  const secondOutcome = resolveMatch(second, context);
  assert.equal(secondOutcome.kind, "new");
  if (secondOutcome.kind === "new") assert.equal(secondOutcome.review, true);
});

test("Tier 4: nothing matches -> plain new, no review flag", () => {
  const incoming = incomingVenue({
    name: "Some Brand New Place",
    nameNormalized: "some brand new place",
    externalId: "node/z",
    latitude: 44.79,
    longitude: 20.4,
  });
  const outcome = resolveMatch(incoming, ctx(SEEDED));
  assert.equal(outcome.kind, "new");
  if (outcome.kind === "new") assert.ok(!outcome.review);
});

// ════════════════════════════════════════════════════════════════════════
//  AUDIT PASS — decision-flow contract (characterization + 1 KNOWN BUG)
// ════════════════════════════════════════════════════════════════════════

const plain = (over: Partial<NormalizedVenue> & { name: string; nameNormalized: string; externalId: string }) =>
  incomingVenue({ latitude: 44.8, longitude: 20.4, ...over });

// ── TIER PRECEDENCE — stronger evidence dominates, checked in order 0→4 ──
test("[precedence] Tier 0 (source+external_id) beats a separate Tier 1 Wikidata candidate", () => {
  const t0 = existingVenue({ id: "v-t0", name: "T0", name_normalized: "t0", source_id: "osm-src", external_id: "node/9" });
  const t1 = existingVenue({ id: "v-t1", name: "T1", name_normalized: "t1", wikidata: "Q5" });
  const r = resolveMatch(plain({ name: "X", nameNormalized: "x", externalId: "node/9", wikidata: "Q5" }), ctx([t1, t0]));
  assert.equal(r.kind, "match");
  if (r.kind === "match") { assert.equal(r.tier, 0); assert.equal(r.venue.id, "v-t0"); }
});

test("[precedence] Tier 1 Wikidata beats Tier 1 website (checked first)", () => {
  const byQid = existingVenue({ id: "v-q", name: "Q", name_normalized: "q", wikidata: "Q5" });
  const byWeb = existingVenue({ id: "v-w", name: "W", name_normalized: "w", website: "https://venue.rs" });
  const r = resolveMatch(
    plain({ name: "X", nameNormalized: "x", externalId: "node/1", wikidata: "Q5", website: "https://venue.rs" }),
    ctx([byWeb, byQid]),
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match") { assert.equal(r.tier, 1); assert.equal(r.venue.id, "v-q"); }
});

test("[precedence] Tier 1 website beats a Tier 2 exact-name candidate", () => {
  const byWeb = existingVenue({ id: "v-w", name: "W", name_normalized: "w", website: "https://venue.rs" });
  const byName = existingVenue({ id: "v-n", name: "Same", name_normalized: "same" });
  const r = resolveMatch(
    plain({ name: "Same", nameNormalized: "same", externalId: "node/1", website: "https://www.venue.rs/x" }),
    ctx([byName, byWeb]),
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match") { assert.equal(r.tier, 1); assert.equal(r.venue.id, "v-w"); }
});

test("[precedence] Tier 2 exact-name beats a Tier 3 curated alias", () => {
  // an existing venue literally normalized to "dragstor" -> Tier 2, not the alias
  const literal = existingVenue({ id: "v-lit", name: "Dragstor Bar", name_normalized: "dragstor" });
  const r = resolveMatch(plain({ name: "Драгстор", nameNormalized: "dragstor", externalId: "node/1" }), ctx([...SEEDED, literal]));
  assert.equal(r.kind, "match");
  if (r.kind === "match") { assert.equal(r.tier, 2); assert.equal(r.venue.id, "v-lit"); }
});

// ── AMBIGUITY — Tier 2 & Tier 3 count candidates and refuse to guess ──
test("[ambiguity] Tier 2: two exact-name candidates -> skip in EITHER candidate order", () => {
  const a = existingVenue({ id: "t-a", name: "Twin", name_normalized: "twin" });
  const b = existingVenue({ id: "t-b", name: "Twin", name_normalized: "twin" });
  const i = plain({ name: "Twin", nameNormalized: "twin", externalId: "node/1" });
  assert.equal(resolveMatch(i, ctx([a, b])).kind, "skip");
  assert.equal(resolveMatch(i, ctx([b, a])).kind, "skip");
});

test("[ambiguity] Tier 3: two venues normalize to the alias canonical -> skip in EITHER order", () => {
  const a = existingVenue({ id: "d-a", name: "Drugstore", name_normalized: "drugstore", latitude: 44.8185, longitude: 20.4883 });
  const b = existingVenue({ id: "d-b", name: "Drugstore", name_normalized: "drugstore", latitude: 44.8186, longitude: 20.4884 });
  const i = plain({ name: "Драгстор", nameNormalized: "dragstor", externalId: "node/1", latitude: 44.8185, longitude: 20.4883 });
  assert.equal(resolveMatch(i, ctx([a, b])).kind, "skip");
  assert.equal(resolveMatch(i, ctx([b, a])).kind, "skip");
});

// ── Tier 1 ambiguity — collect ALL free candidates and refuse to guess ──
test("[ambiguity] Tier 1 website: 2+ existing venues on one dedicated domain -> skip (both candidate orders)", () => {
  // A venue GROUP legitimately lists one top-level website on every hall, and
  // `venues.website` has NO unique constraint. Tier 1b must not first-match.
  const salaA = existingVenue({ id: "v-salaA", name: "Sala A", name_normalized: "sala a", website: "https://kcns.rs" });
  const salaB = existingVenue({ id: "v-salaB", name: "Sala B", name_normalized: "sala b", website: "https://www.kcns.rs/" });
  const incC = plain({ name: "Sala C", nameNormalized: "sala c", externalId: "node/NEW", website: "http://kcns.rs/program" });

  for (const order of [[salaA, salaB], [salaB, salaA]] as const) {
    const r = resolveMatch(incC, ctx([...order]));
    assert.equal(r.kind, "skip");
    if (r.kind === "skip") assert.match(r.note, /ambiguous: 2 existing venues share website domain kcns\.rs/);
  }
});

test("[ambiguity] Tier 1 Wikidata: 2+ existing venues sharing a QID -> skip (both candidate orders)", () => {
  // `venues.wikidata` also has no unique constraint.
  const a = existingVenue({ id: "w-a", name: "A", name_normalized: "a", wikidata: "Q1" });
  const b = existingVenue({ id: "w-b", name: "B", name_normalized: "b", wikidata: "Q1" });
  const i = plain({ name: "Z", nameNormalized: "zzz", externalId: "node/1", wikidata: "Q1" });
  for (const order of [[a, b], [b, a]] as const) {
    const r = resolveMatch(i, ctx([...order]));
    assert.equal(r.kind, "skip");
    if (r.kind === "skip") assert.match(r.note, /ambiguous: 2 existing venues share wikidata Q1/);
  }
});

test("[ambiguity] Tier 1: exactly ONE free candidate still matches at tier 1 (note format preserved)", () => {
  const q = existingVenue({ id: "v-q", name: "Q", name_normalized: "q", wikidata: "Q7" });
  const rQ = resolveMatch(plain({ name: "X", nameNormalized: "x", externalId: "n/1", wikidata: "Q7" }), ctx([q]));
  assert.equal(rQ.kind, "match");
  if (rQ.kind === "match") { assert.equal(rQ.tier, 1); assert.equal(rQ.note, "wikidata Q7"); }

  const d = existingVenue({ id: "v-d", name: "D", name_normalized: "d", website: "https://drugstore.rs/" });
  const rW = resolveMatch(plain({ name: "X", nameNormalized: "x", externalId: "n/2", website: "http://www.drugstore.rs/x" }), ctx([d]));
  assert.equal(rW.kind, "match");
  if (rW.kind === "match") { assert.equal(rW.tier, 1); assert.equal(rW.note, "website domain drugstore.rs"); }
});

test("[ambiguity] Tier 1: a consumed duplicate does not count toward ambiguity -> the one free candidate matches", () => {
  const a = existingVenue({ id: "w-a", name: "A", name_normalized: "a", wikidata: "Q1" });
  const b = existingVenue({ id: "w-b", name: "B", name_normalized: "b", wikidata: "Q1" });
  const i = plain({ name: "Z", nameNormalized: "zzz", externalId: "n/1", wikidata: "Q1" });
  const r = resolveMatch(i, ctx([a, b], ["w-a"])); // w-a already consumed this run
  assert.equal(r.kind, "match");
  if (r.kind === "match") { assert.equal(r.tier, 1); assert.equal(r.venue.id, "w-b"); }
});

test("[ambiguity] Tier 1: zero identity matches falls through to a Tier 2 exact-name match", () => {
  const named = existingVenue({ id: "v-n", name: "Only Name", name_normalized: "only name" });
  const r = resolveMatch(
    plain({ name: "Only Name", nameNormalized: "only name", externalId: "n/1", wikidata: "Q999", website: "https://nowhere.rs" }),
    ctx([named]),
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match") { assert.equal(r.tier, 2); assert.equal(r.venue.id, "v-n"); }
});

test("[safe] Tier 0 first-match IS safe — the DB `unique (source_id, external_id)` guarantees at most one candidate", () => {
  const only = existingVenue({ id: "v-only", name: "Only", name_normalized: "only", source_id: "osm-src", external_id: "node/9" });
  const other = existingVenue({ id: "v-other", name: "Other", name_normalized: "other", source_id: "osm-src", external_id: "node/DIFFERENT" });
  const i = plain({ name: "Re", nameNormalized: "re", externalId: "node/9" });
  assert.equal((resolveMatch(i, ctx([only, other])) as { venue: ExistingVenue }).venue.id, "v-only");
  assert.equal((resolveMatch(i, ctx([other, only])) as { venue: ExistingVenue }).venue.id, "v-only");
});

// ── WEBSITE / DOMAIN — integration of the (already-fixed) aliases.ts helpers ──
test("[website] the aliases.ts compound-suffix fix flows through Tier 1: two `.co.rs` registrants do NOT merge", () => {
  const a = existingVenue({ id: "v-a", name: "Klub A", name_normalized: "klub a", website: "https://klub-a.co.rs" });
  const i = plain({ name: "Klub C", nameNormalized: "klub c", externalId: "node/1", website: "https://klub-c.co.rs" });
  assert.equal(resolveMatch(i, ctx([a])).kind, "new");

  // …but the SAME `.co.rs` registrant (www / path) still matches at Tier 1
  const same = plain({ name: "Klub A2", nameNormalized: "klub a2", externalId: "node/2", website: "https://www.klub-a.co.rs/events" });
  const r = resolveMatch(same, ctx([a]));
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.tier, 1);
});

test("[website] null / different / malformed websites never match at Tier 1", () => {
  const a = existingVenue({ id: "v-a", name: "A", name_normalized: "a", website: "https://one.rs" });
  assert.equal(resolveMatch(plain({ name: "B", nameNormalized: "b", externalId: "n/1", website: null }), ctx([a])).kind, "new");
  assert.equal(resolveMatch(plain({ name: "B", nameNormalized: "b", externalId: "n/1", website: "https://two.rs" }), ctx([a])).kind, "new");
  assert.equal(resolveMatch(plain({ name: "B", nameNormalized: "b", externalId: "n/1", website: "not a url" }), ctx([a])).kind, "new");
});

// ── PROXIMITY GUARD (Tier 3) ─────────────────────────────────────────
test("[proximity] Tier 3: incoming with NaN coordinates never gets a distance-based link", () => {
  const r = resolveMatch(
    { ...incomingVenue({ name: "Драгстор", nameNormalized: "dragstor", externalId: "node/1", latitude: 44.8, longitude: 20.4 }), latitude: Number.NaN, longitude: Number.NaN },
    ctx(SEEDED),
  );
  assert.equal(r.kind, "new");
  if (r.kind === "new") assert.equal(r.review, true);
});

test("[proximity] Tier 3: canonical venue has NO coordinates -> alias links unconditionally (matcher policy)", () => {
  const noCoords = existingVenue({ id: "v-ds", name: "Drugstore", name_normalized: "drugstore" });
  const r = resolveMatch(
    incomingVenue({ name: "Драгстор", nameNormalized: "dragstor", externalId: "node/1", latitude: 44.8, longitude: 20.4 }),
    ctx([noCoords]),
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match") { assert.equal(r.tier, 3); assert.match(r.note ?? "", /no coordinates to cross-check/); }
});

test("[proximity] coordinates alone never merge two venues (different name, no alias, ~5 m apart)", () => {
  const near = existingVenue({ id: "v-near", name: "Alpha", name_normalized: "alpha", latitude: 44.80000, longitude: 20.40000 });
  const r = resolveMatch(
    incomingVenue({ name: "Beta", nameNormalized: "beta", externalId: "node/1", latitude: 44.80003, longitude: 20.40003 }),
    ctx([near]),
  );
  assert.equal(r.kind, "new");
});

// ── IMMUTABILITY / DETERMINISM ───────────────────────────────────────
test("[purity] resolveMatch mutates nothing: incoming, ctx.existing, ctx.consumed, VENUE_ALIASES", () => {
  const existing = [
    existingVenue({ id: "v-1", name: "Драгстор dup", name_normalized: "dragstor" }),
    existingVenue({ id: "v-ds", name: "Drugstore", name_normalized: "drugstore", latitude: 44.8185, longitude: 20.4883 }),
  ];
  const incoming = incomingVenue({ name: "Драгстор", nameNormalized: "dragstor", externalId: "node/1", latitude: 44.8185, longitude: 20.4883 });
  const consumed = new Set<string>();
  const context: MatchContext = { target: BELGRADE, osmSourceId: "osm-src", existing, consumed };

  const existingBefore = JSON.stringify(existing);
  const incomingBefore = JSON.stringify(incoming);
  const aliasesBefore = JSON.stringify(VENUE_ALIASES);

  resolveMatch(incoming, context);

  assert.equal(JSON.stringify(existing), existingBefore, "ctx.existing unchanged");
  assert.equal(JSON.stringify(incoming), incomingBefore, "incoming unchanged");
  assert.equal(context.consumed.size, 0, "resolveMatch never adds to ctx.consumed (the caller does)");
  assert.equal(JSON.stringify(VENUE_ALIASES), aliasesBefore, "the curated alias table is untouched");
});

test("[determinism] identical input + identical candidate order -> identical outcome (repeat)", () => {
  const i = incomingVenue({ name: "20/44", nameNormalized: "20 44", externalId: "node/1", latitude: 44.814, longitude: 20.451 });
  const first = resolveMatch(i, ctx(SEEDED));
  for (let k = 0; k < 5; k++) assert.deepEqual(resolveMatch(i, ctx(SEEDED)), first);
});

// ── consumed / free() ───────────────────────────────────────────────
test("[consumed] a venue consumed earlier this run is invisible to Tier 1 and Tier 2", () => {
  const v = existingVenue({ id: "v-x", name: "X", name_normalized: "x", wikidata: "Q9", website: "https://x.rs" });
  const context = ctx([v], ["v-x"]); // already consumed
  assert.equal(resolveMatch(plain({ name: "X2", nameNormalized: "x", externalId: "n/1", wikidata: "Q9" }), context).kind, "new");
  assert.equal(resolveMatch(plain({ name: "X2", nameNormalized: "x", externalId: "n/1", website: "https://x.rs" }), context).kind, "new");
});

// ── reviewNotesForNewVenues is advisory only ─────────────────────────
test("[advisory] reviewNotesForNewVenues never changes a decision and does not mutate its inputs", () => {
  const newVenues = [
    incomingVenue({ name: "Klub North", nameNormalized: "klub north", externalId: "node/a", latitude: 44.8000, longitude: 20.4000 }),
  ];
  const existing = [existingVenue({ id: "v-e", name: "Klub South", name_normalized: "klub south", latitude: 44.80005, longitude: 20.40005 })];
  const before = JSON.stringify([newVenues, existing]);
  const notes = reviewNotesForNewVenues(newVenues, existing);
  assert.equal(JSON.stringify([newVenues, existing]), before);
  assert.ok(notes instanceof Map);
});
