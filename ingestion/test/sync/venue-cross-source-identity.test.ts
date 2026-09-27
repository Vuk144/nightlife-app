/**
 * `../../src/sync/venue-cross-source-identity.ts` — curated cross-source venue
 * identities (source venue id → canonical venue), and their use by the event
 * venue matcher. Deterministic: in-memory data, in-memory store, fake Supabase.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseGigstixEventRecord } from "../../src/sync/adapters/gigstix-event.ts";
import { DEFAULT_RECONCILIATION, InMemoryConfigProvider } from "../../src/sync/config.ts";
import { matchEventVenue, matchEventVenueInStore } from "../../src/sync/event-venue-match.ts";
import { serbianProfile } from "../../src/sync/normalization.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import type { VenueLinkHint } from "../../src/sync/types.ts";
import {
  CROSS_SOURCE_VENUE_IDENTITIES,
  resolveCrossSourceIdentity,
  type CrossSourceVenueIdentity,
} from "../../src/sync/venue-cross-source-identity.ts";
import { resolveVenueIdentity } from "../../src/sync/venue-identity.ts";
import { FakeSupabase } from "./fake-supabase.ts";

const BELGRADE = { countryCode: "RS", cityName: "Belgrade" };
const NOVI_SAD = { countryCode: "RS", cityName: "Novi Sad" };

function venue(over: Partial<CanonicalVenue> & { id: string; name: string }): CanonicalVenue {
  return {
    cityId: "city-bg",
    cityName: "Belgrade",
    countryCode: "RS",
    normalizedName: serbianProfile.normalizeName(over.name),
    address: null,
    coordinates: null,
    coordinatesSource: null,
    website: null,
    wikidata: null,
    openingHours: null,
    description: null,
    openingTime: null,
    closingTime: null,
    isActive: true,
    sourceKey: null,
    externalId: null,
    sourceUrl: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

// The real Belgrade rows since the OSM name took over.
const DRAGSTOR = venue({ id: "v-ds", name: "Драгстор", sourceKey: "OpenStreetMap", externalId: "node/5302622223" });
const KST = venue({ id: "v-kst", name: "Клуб студената технике", sourceKey: "OpenStreetMap", externalId: "node/4162210293" });
const HANGAR = venue({ id: "v-hangar", name: "Hangar", sourceKey: "OpenStreetMap", externalId: "node/777" });
const NS_DRAGSTOR = venue({ id: "v-ns", name: "Драгстор", cityId: "city-ns", cityName: "Novi Sad" });
const VENUES = [DRAGSTOR, KST, HANGAR, NS_DRAGSTOR];

const hint = (over: Partial<VenueLinkHint>): VenueLinkHint => ({
  name: "Drugstore",
  sourceVenueId: "drugstore",
  address: null,
  coordinates: null,
  cityText: "Beograd",
  ...over,
});

const eventMatch = (h: VenueLinkHint, over: { city?: typeof BELGRADE | null; venues?: CanonicalVenue[]; identities?: CrossSourceVenueIdentity[] } = {}) =>
  matchEventVenue({
    sourceKey: "gigstix",
    hint: h,
    city: over.city === undefined ? BELGRADE : over.city,
    venues: over.venues ?? VENUES,
    normalizeName: serbianProfile.normalizeName,
    crossSourceIdentities: over.identities ?? CROSS_SOURCE_VENUE_IDENTITIES,
  });

const matchedId = (r: ReturnType<typeof eventMatch>) => (r.status === "matched" ? r.venueId : `(${r.status})`);

// ── the curated data ────────────────────────────────────────────────────
test("1. GIGS `drugstore` + Belgrade → the existing canonical 'Драгстор'", () => {
  assert.equal(matchedId(eventMatch(hint({}))), "v-ds");
});

test("2. GIGS `kst` + Belgrade → the existing canonical 'Клуб студената технике'", () => {
  assert.equal(matchedId(eventMatch(hint({ name: "KST", sourceVenueId: "kst" }))), "v-kst");
});

test("the source identity is authoritative even with a completely different display name", () => {
  assert.equal(matchedId(eventMatch(hint({ name: "Some Completely Different Display Name" }))), "v-ds");
  assert.equal(matchedId(eventMatch(hint({ name: "", sourceVenueId: "kst" }))), "v-kst", "no name at all");
});

test("5. an explicit identity wins over a display name that names ANOTHER existing venue", () => {
  // the page says "Hangar" (an exact name of a different Belgrade venue) but its
  // GIGS venue id is `drugstore`
  assert.equal(matchedId(eventMatch(hint({ name: "Hangar" }))), "v-ds");
});

test("the shipped data is conflict-free: one entry per (country, city, source, external id)", () => {
  const keys = CROSS_SOURCE_VENUE_IDENTITIES.map((i) => `${i.countryCode}|${i.cityName}|${i.sourceKey}|${i.externalId}`);
  assert.equal(new Set(keys).size, keys.length);
});

// ── generic, not GIGS-specific ──────────────────────────────────────────
test("generic: any source, any city, target by canonical venue id", () => {
  const zagrebClub = venue({ id: "v-zg", name: "Tvornica Kulture", cityId: "city-zg", cityName: "Zagreb", countryCode: "HR" });
  const identities: CrossSourceVenueIdentity[] = [
    { countryCode: "HR", cityName: "Zagreb", sourceKey: "residentadvisor", externalId: "ra-12345", canonical: { venueId: "v-zg" } },
  ];
  const r = resolveCrossSourceIdentity({
    sourceKey: "residentadvisor",
    externalId: "ra-12345",
    city: { countryCode: "HR", cityName: "Zagreb" },
    identities,
    venues: [zagrebClub, ...VENUES],
  });
  assert.deepEqual(r, { status: "matched", venueId: "v-zg", venueName: "Tvornica Kulture", note: r.status === "matched" ? r.note : "" });
  // the same external id from a DIFFERENT source is not that identity
  assert.equal(
    resolveCrossSourceIdentity({ sourceKey: "gigstix", externalId: "ra-12345", city: { countryCode: "HR", cityName: "Zagreb" }, identities, venues: [zagrebClub] }).status,
    "none",
  );
});

// ── city safety ─────────────────────────────────────────────────────────
test("3. the same GIGS venue id in the WRONG city does not resolve through the Belgrade identity", () => {
  // Novi Sad has its own "Драгстор"; the Belgrade identity must not apply, and
  // the Belgrade venue must never be returned for a Novi Sad event.
  const r = eventMatch(hint({ name: "Some Other Name", cityText: "Novi Sad" }), { city: NOVI_SAD });
  assert.notEqual(matchedId(r), "v-ds");
  assert.equal(r.status, "unresolved");
});

test("7. a same-named venue in another city is not selected (the identity is city-scoped)", () => {
  // Belgrade event with id `drugstore`: two "Драгстор" rows exist, one per city
  assert.equal(matchedId(eventMatch(hint({ name: "Драгстор" }))), "v-ds");
  // a Novi Sad event naming "Драгстор" resolves only within Novi Sad
  assert.equal(matchedId(eventMatch(hint({ name: "Драгстор", sourceVenueId: null }), { city: NOVI_SAD })), "v-ns");
});

test("a curated identity whose target sits in another city (misconfiguration) is review — never a cross-city match", () => {
  const identities: CrossSourceVenueIdentity[] = [
    { ...CROSS_SOURCE_VENUE_IDENTITIES[0], canonical: { venueId: "v-ns" } }, // Belgrade identity → Novi Sad row
  ];
  const r = eventMatch(hint({}), { identities });
  assert.equal(r.status, "review");
  if (r.status === "review") assert.equal(r.reasonCode, "venue-identity-target-missing");
  assert.equal("venueId" in r, false);
});

// ── fall-through ────────────────────────────────────────────────────────
test("4. an unknown GIGS venue id falls through to the normal matching rules", () => {
  // no curated identity for `hangar-luka-beograd`: normal Tier 2 name match
  assert.equal(matchedId(eventMatch(hint({ name: "Hangar", sourceVenueId: "hangar-luka-beograd" }))), "v-hangar");
  // …and with no name match either: unresolved
  const r = eventMatch(hint({ name: "Barutana", sourceVenueId: "barutana" }));
  assert.equal(r.status === "unresolved" && r.reasonCode, "no-existing-venue");
  assert.equal(resolveCrossSourceIdentity({ sourceKey: "gigstix", externalId: "barutana", city: BELGRADE, identities: CROSS_SOURCE_VENUE_IDENTITIES, venues: VENUES }).status, "none");
});

// ── conflicts ───────────────────────────────────────────────────────────
test("6. two curated identities for the same source id with different targets → review, both candidates, none chosen", () => {
  const identities: CrossSourceVenueIdentity[] = [
    { ...CROSS_SOURCE_VENUE_IDENTITIES[0] },
    { ...CROSS_SOURCE_VENUE_IDENTITIES[0], canonical: { venueId: "v-kst" } },
  ];
  const r = eventMatch(hint({}), { identities });
  assert.equal(r.status, "review");
  if (r.status === "review") {
    assert.equal(r.reasonCode, "venue-identity-conflict");
    assert.deepEqual(r.candidates.map((c) => c.id).sort(), ["v-ds", "v-kst"]);
  }
  // duplicates pointing at the SAME venue (by different refs) are not a conflict
  const dupes: CrossSourceVenueIdentity[] = [
    { ...CROSS_SOURCE_VENUE_IDENTITIES[0] },
    { ...CROSS_SOURCE_VENUE_IDENTITIES[0], canonical: { venueId: "v-ds" } },
  ];
  assert.equal(matchedId(eventMatch(hint({}), { identities: dupes })), "v-ds");
});

test("a curated identity that contradicts a venue's own link for the same source id → review", () => {
  // Hangar's row is (hypothetically) owned by gigstix:drugstore; the curation says Драгстор
  const hangarOwned = { ...HANGAR, sourceKey: "gigstix", externalId: "drugstore" };
  const r = eventMatch(hint({}), { venues: [DRAGSTOR, KST, hangarOwned] });
  assert.equal(r.status, "review");
  if (r.status === "review") assert.deepEqual(r.candidates.map((c) => c.id).sort(), ["v-ds", "v-hangar"]);
  // with no curated identity, that owning link is simply the normal Tier 0 match
  assert.equal(matchedId(eventMatch(hint({}), { venues: [DRAGSTOR, hangarOwned], identities: [] })), "v-hangar");
});

test("the same source id linked to TWO venues in the city → review (no arbitrary Tier 0 pick)", () => {
  const a = venue({ id: "v-a", name: "A", sourceKey: "gigstix", externalId: "twin" });
  const b = venue({ id: "v-b", name: "B", sourceKey: "gigstix", externalId: "twin" });
  const r = eventMatch(hint({ name: "A", sourceVenueId: "twin" }), { venues: [a, b], identities: [] });
  assert.equal(r.status === "review" && r.reasonCode, "venue-identity-conflict");
});

// ── only `matched` carries a venue id; nothing is ever created ──────────
test("only a matched result carries a canonical venue id", () => {
  const conflict = eventMatch(hint({}), {
    identities: [{ ...CROSS_SOURCE_VENUE_IDENTITIES[0] }, { ...CROSS_SOURCE_VENUE_IDENTITIES[0], canonical: { venueId: "v-kst" } }],
  });
  const missing = eventMatch(hint({}), { venues: [KST] });
  for (const r of [conflict, missing]) {
    assert.equal(r.status, "review");
    assert.equal("venueId" in r, false);
  }
});

const INTERCELL = readFileSync(new URL("../events/fixtures/gigstix-event-intercell.html", import.meta.url), "utf8");
const provider = () =>
  new InMemoryConfigProvider({
    countries: [{ code: "RS", name: "Serbia", enabled: true, defaultTimeZone: "Europe/Belgrade", bounds: null, normalizationProfile: "sr", extraPlaceholderPatterns: [] }],
    cities: [{ countryCode: "RS", canonicalName: "Belgrade", enabled: true, eventFirstEnabled: false, timeZone: "Europe/Belgrade", nameAliases: ["beograd"], bounds: null, sourceScope: {} }],
    sources: [],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  });
function intercell() {
  const r = parseGigstixEventRecord(INTERCELL, "https://new.gigstix.com/event/intercell-with-dvs1/", { fetchedAt: "2026-09-27T00:00:00.000Z" });
  assert.ok(r.ok);
  return r.record; // hint: "Drugstore" / `drugstore` / "Beograd"
}

test("8. end to end (real GIGS page → store): resolves to Драгстор, and nothing is created or written", async () => {
  const store = new InMemoryCanonicalStore({
    cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: null }],
    venues: [DRAGSTOR, KST],
  });
  const r = await matchEventVenueInStore(intercell(), { config: provider(), store, crossSourceIdentities: CROSS_SOURCE_VENUE_IDENTITIES });
  assert.equal(matchedId(r), "v-ds");
  assert.deepEqual(store.venues.map((v) => v.id), ["v-ds", "v-kst"]);
  assert.deepEqual(store.applied, []);

  // the same through the real Supabase store code: zero writes
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }]);
  fake.seed("venues", [
    { id: "v-ds", city_id: "city-bg", name: "Драгстор", name_normalized: "dragstor", source_id: "ds-osm", external_id: "node/5302622223", is_active: true, created_at: "x", updated_at: "x" },
  ]);
  const supa = await matchEventVenueInStore(intercell(), {
    config: provider(),
    store: new SupabaseCanonicalStore(fake.asClient()),
    crossSourceIdentities: CROSS_SOURCE_VENUE_IDENTITIES,
  });
  assert.equal(matchedId(supa), "v-ds");
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.tables.venues.length, 1);

  // an unknown source id is never turned into a new venue
  const unknown = await matchEventVenueInStore(
    { ...intercell(), links: { venue: hint({ name: "Barutana", sourceVenueId: "barutana" }) } },
    { config: provider(), store, crossSourceIdentities: CROSS_SOURCE_VENUE_IDENTITIES },
  );
  assert.equal(unknown.status, "unresolved");
  assert.deepEqual(store.venues.map((v) => v.id), ["v-ds", "v-kst"]);
});

test("9. the OSM/generic identity path does not consult curated cross-source identities", () => {
  // resolveVenueIdentity (used by the OSM venue sync) is unchanged: an incoming
  // record carrying a curated source id matches by its own rules only.
  const r = resolveVenueIdentity({
    incoming: { source: { sourceKey: "gigstix", externalId: "drugstore", sourceUrl: null }, name: "Drugstore", normalizedName: "drugstore", coordinates: null, address: null, website: null, wikidata: null },
    scope: BELGRADE,
    existingInCity: [DRAGSTOR].map((v) => ({ ...v, coordinatesSource: v.coordinatesSource })),
  });
  assert.equal(r.decision, "new_candidate");
});
