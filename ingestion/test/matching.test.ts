import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewNotesForNewVenues,
  resolveMatch,
  type MatchContext,
} from "../src/matching.ts";
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
