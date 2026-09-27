/**
 * `../../src/sync/engine.ts#planSync` resolves an event's venue hint through
 * the curated cross-source identities (`PlanSyncInput.crossSourceIdentities`)
 * before the name tiers — the same rule as `matchEventVenue`. Regression for
 * GIGS 25772 (Intercell): the planner said READY on OSM node/5302622223
 * 'Драгстор', but the engine planned the event with no venue (the name
 * "Drugstore" never reaches "dragstor"), so `apply` deferred it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createGigstixConfigProvider } from "../../src/sync/adapters/gigstix-config.ts";
import { parseGigstixEventRecord } from "../../src/sync/adapters/gigstix-event.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { planSync } from "../../src/sync/engine.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import {
  CROSS_SOURCE_VENUE_IDENTITIES,
  type CrossSourceVenueIdentity,
} from "../../src/sync/venue-cross-source-identity.ts";

const INTERCELL = readFileSync(new URL("../events/fixtures/gigstix-event-intercell.html", import.meta.url), "utf8");
const URL_ = "https://new.gigstix.com/event/intercell-with-dvs1-beograd-30-oktobar-2026/";
const NOW = "2026-09-27T20:00:00.000Z";

const CITIES = [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: null }];
const DRAGSTOR: CanonicalVenue = {
  id: "v-ds",
  cityId: "city-bg",
  cityName: "Belgrade",
  countryCode: "RS",
  name: "Драгстор",
  normalizedName: "dragstor",
  address: "Поенкареова 36",
  coordinates: { latitude: 44.8185264, longitude: 20.488357 },
  coordinatesSource: "manual",
  website: null,
  wikidata: null,
  openingHours: null,
  description: null,
  openingTime: null,
  closingTime: "04:00",
  isActive: true,
  sourceKey: "OpenStreetMap",
  externalId: "node/5302622223",
  sourceUrl: "https://www.openstreetmap.org/node/5302622223",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function intercell() {
  const r = parseGigstixEventRecord(INTERCELL, URL_, { fetchedAt: NOW });
  assert.ok(r.ok);
  return r.record;
}

function run(store: InMemoryCanonicalStore, crossSourceIdentities?: CrossSourceVenueIdentity[]) {
  const record = intercell();
  const config = createGigstixConfigProvider();
  return planSync({
    adapter: createInMemoryAdapter({ key: "gigstix", items: [{ externalId: "25772", kind: "event", payload: record }] }),
    source: config.source("gigstix")!,
    config,
    store,
    now: NOW,
    runId: "t",
    crossSourceIdentities,
  });
}

test("GIGS 25772: the engine resolves venue hint `drugstore` to the existing OSM 'Драгстор' via the curated identity", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [DRAGSTOR] });
  const plan = await run(store, CROSS_SOURCE_VENUE_IDENTITIES);

  assert.equal(plan.upserts.length, 1, "exactly the event — no venue candidate");
  const [u] = plan.upserts;
  assert.equal(u.kind, "event");
  assert.equal(u.operation, "insert");
  assert.equal(u.changeStatus, "NEW");
  assert.equal(u.resolvedVenueId, "v-ds");
  assert.deepEqual(plan.reviewItems, []);
  assert.equal(plan.stats.venuesMatched, 1);
  assert.equal(plan.stats.venuesNew, 0);

  // applied: one event on the existing venue, no venue created; a re-run is UNCHANGED
  const applied = await store.apply(plan, { commit: true });
  assert.equal(applied.inserted, 1);
  assert.deepEqual(store.venues.map((v) => v.id), ["v-ds"]);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].venueId, "v-ds");

  const again = await run(store, CROSS_SOURCE_VENUE_IDENTITIES);
  assert.deepEqual(
    again.upserts.map((x) => [x.kind, x.operation, x.changeStatus, x.resolvedVenueId]),
    [["event", "link-only", "UNCHANGED", "v-ds"]],
  );
  assert.equal(store.events.length, 1);
});

test("GIGS 25772: without curated identities the engine behaves exactly as before (no venue, review item)", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [DRAGSTOR] });
  const plan = await run(store);
  const event = plan.upserts.find((u) => u.kind === "event");
  assert.equal(event?.resolvedVenueId, null);
  assert.deepEqual(plan.reviewItems.map((r) => r.reasonCode), ["city-not-event-first-enabled"]);
});

test("GIGS 25772: a curated identity pointing at no venue is a review item, never a name-tier guess or a new venue", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [{ ...DRAGSTOR, externalId: "node/1" }] });
  const plan = await run(store, CROSS_SOURCE_VENUE_IDENTITIES);
  assert.deepEqual(plan.reviewItems.map((r) => r.reasonCode), ["venue-identity-target-missing"]);
  assert.deepEqual(plan.upserts.map((u) => [u.kind, u.resolvedVenueId]), [["event", null]]);
});
