/**
 * Curated cross-source identity: GIGS TIX venue `barrel-house` (Belgrade,
 * Žorža Klemansoa 19) → the existing OSM venue "Belgrade Urban Distillery"
 * (node/12068261369, same address). The names share nothing, so only the
 * curated identity can link them — never a name tier, never a new venue.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGigstixConfigProvider } from "../../src/sync/adapters/gigstix-config.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { planSync } from "../../src/sync/engine.ts";
import type { NormalizedEvent } from "../../src/sync/event-contract.ts";
import { matchEventVenue } from "../../src/sync/event-venue-match.ts";
import { serbianProfile } from "../../src/sync/normalization.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import {
  CROSS_SOURCE_VENUE_IDENTITIES,
  type CrossSourceVenueIdentity,
} from "../../src/sync/venue-cross-source-identity.ts";

const NOW = "2026-09-27T20:00:00.000Z";
const CITIES = [
  { id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: null },
  { id: "city-ns", countryCode: "RS", name: "Novi Sad", timeZone: null },
];

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
    sourceKey: "OpenStreetMap",
    externalId: null,
    sourceUrl: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const DISTILLERY = venue({
  id: "v-bud",
  name: "Belgrade Urban Distillery",
  externalId: "node/12068261369",
  address: "Жоржа Клемансоа 19",
  coordinates: { latitude: 44.8221, longitude: 20.4692 },
  website: "https://belgrade-distillery.com",
});
const DRAGSTOR = venue({ id: "v-ds", name: "Драгстор", externalId: "node/5302622223" });
const WITHOUT_BARREL = CROSS_SOURCE_VENUE_IDENTITIES.filter((i) => i.externalId !== "barrel-house");

const HINT = {
  name: "Barrel house",
  sourceVenueId: "barrel-house",
  address: null,
  coordinates: null,
  cityText: "Beograd",
};

/** GIGS event 26407 ("Belgrade Bar Show Fall edition 2026.") as the GIGS adapter shapes it. */
const EVENT: NormalizedEvent = {
  kind: "event",
  provenance: {
    sourceKey: "gigstix",
    externalId: "26407",
    sourceUrl: "https://new.gigstix.com/event/belgrade-bar-show-fall-edition-2026/",
    confidence: 1,
    fetchedAt: NOW,
    reported: {},
  },
  scope: { countryCode: "RS", cityText: "Beograd", coordinates: null },
  fields: {
    title: "Belgrade Bar Show Fall edition 2026.",
    description: null,
    startLocal: "2026-10-23T19:00",
    endLocal: null,
    doorsLocal: null,
    timeZone: "Europe/Belgrade",
    startPrecision: "datetime",
    status: "scheduled",
    promoter: null,
    ticketUrl: null,
    coverImageUrl: null,
    lineup: [],
  },
  links: { venue: HINT },
};

const match = (identities: CrossSourceVenueIdentity[], venues: CanonicalVenue[] = [DISTILLERY, DRAGSTOR]) =>
  matchEventVenue({
    sourceKey: "gigstix",
    hint: HINT,
    city: { countryCode: "RS", cityName: "Belgrade" },
    venues,
    normalizeName: serbianProfile.normalizeName,
    crossSourceIdentities: identities,
  });

function plan(store: InMemoryCanonicalStore, identities: CrossSourceVenueIdentity[]) {
  const config = createGigstixConfigProvider();
  return planSync({
    adapter: createInMemoryAdapter({ key: "gigstix", items: [{ externalId: "26407", kind: "event", payload: EVENT }] }),
    source: config.source("gigstix")!,
    config,
    store,
    now: NOW,
    runId: "t",
    crossSourceIdentities: identities,
  });
}

test("the shipped Belgrade identity: gigstix `barrel-house` → OpenStreetMap node/12068261369", () => {
  const entries = CROSS_SOURCE_VENUE_IDENTITIES.filter((i) => i.sourceKey === "gigstix" && i.externalId === "barrel-house");
  assert.deepEqual(
    entries.map((i) => [i.countryCode, i.cityName, i.canonical]),
    [["RS", "Belgrade", { sourceKey: "OpenStreetMap", externalId: "node/12068261369" }]],
  );
});

test("matcher: GIGS `barrel-house` resolves to the existing 'Belgrade Urban Distillery' through the curated identity", () => {
  const r = match(CROSS_SOURCE_VENUE_IDENTITIES);
  assert.equal(r.status, "matched");
  if (r.status !== "matched") return;
  assert.equal(r.venueId, "v-bud");
  assert.equal(r.tier, 0);
  assert.match(r.note, /source identity/);
});

test("matcher: without the curated entry, no name tier links 'Barrel house' to the distillery", () => {
  assert.deepEqual(
    [match(WITHOUT_BARREL).status, (match(WITHOUT_BARREL) as { reasonCode?: string }).reasonCode],
    ["unresolved", "no-existing-venue"],
  );
});

test("matcher: the identity is Belgrade-only — the same GIGS id in Novi Sad does not resolve through it", () => {
  const nsDistillery = { ...DISTILLERY, id: "v-ns", cityId: "city-ns", cityName: "Novi Sad" };
  const r = matchEventVenue({
    sourceKey: "gigstix",
    hint: HINT,
    city: { countryCode: "RS", cityName: "Novi Sad" },
    venues: [nsDistillery],
    normalizeName: serbianProfile.normalizeName,
    crossSourceIdentities: CROSS_SOURCE_VENUE_IDENTITIES,
  });
  assert.equal(r.status, "unresolved");
});

test("engine: GIGS 26407 at `barrel-house` plans an event on the existing distillery venue — no venue candidate, no review", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [DISTILLERY, DRAGSTOR] });
  const p = await plan(store, CROSS_SOURCE_VENUE_IDENTITIES);
  assert.deepEqual(
    p.upserts.map((u) => [u.kind, u.operation, u.changeStatus, u.resolvedVenueId]),
    [["event", "insert", "NEW", "v-bud"]],
  );
  assert.deepEqual(p.reviewItems, []);
  assert.equal(p.stats.venuesMatched, 1);
  assert.equal(p.stats.venuesNew, 0);
  assert.deepEqual(store.venues.map((v) => v.id), ["v-bud", "v-ds"], "planning creates nothing");
});

test("engine: without the curated entry the event has no venue (the prior REVIEW outcome)", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [DISTILLERY, DRAGSTOR] });
  const p = await plan(store, WITHOUT_BARREL);
  assert.equal(p.upserts.find((u) => u.kind === "event")?.resolvedVenueId, null);
  assert.deepEqual(p.reviewItems.map((r) => r.reasonCode), ["city-not-event-first-enabled"]);
});
