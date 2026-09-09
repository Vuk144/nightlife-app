/**
 * `../../src/sync/store.ts#InMemoryCanonicalStore` — persistence-boundary
 * correctness. The store is a double for `SupabaseCanonicalStore`; a real
 * persistence layer never hands out live references to its storage, never
 * shares state with the caller's input, and never claims a successful write
 * that leaves it internally inconsistent (a link to a canonical row that does
 * not exist, a venue with a dangling `cityId`, an event with a dangling
 * `venueId`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryCanonicalStore,
  type CanonicalEvent,
  type CanonicalVenue,
  type CityRecord,
  type SourceLink,
} from "../../src/sync/store.ts";
import type { CanonicalUpsert, GeoPoint, SyncPlan } from "../../src/sync/types.ts";

const NOW = "2026-06-01T00:00:00.000Z";

function city(over: Partial<CityRecord> = {}): CityRecord {
  return { id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade", ...over };
}

function venue(over: Partial<CanonicalVenue> = {}): CanonicalVenue {
  return {
    id: "v1",
    cityId: "city-bg",
    cityName: "Belgrade",
    countryCode: "RS",
    name: "Depo",
    normalizedName: "depo",
    address: "Karadjordjeva 1",
    coordinates: { latitude: 44.8, longitude: 20.45 },
    coordinatesSource: "source",
    website: null,
    wikidata: null,
    openingHours: null,
    description: null,
    openingTime: null,
    closingTime: null,
    isActive: true,
    sourceKey: "osm",
    externalId: "osm-1",
    sourceUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function event(over: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: "e1",
    venueId: "v1",
    title: "DJ Night",
    description: null,
    startLocal: "2026-07-01T22:00",
    timeZone: "Europe/Belgrade",
    endLocal: null,
    status: "scheduled",
    ticketUrl: null,
    coverImageUrl: null,
    canonicalSourceKey: "entrio-hr",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function link(over: Partial<SourceLink> = {}): SourceLink {
  return {
    id: "l1",
    kind: "event",
    sourceKey: "entrio-hr",
    externalId: "E1",
    sourceUrl: null,
    canonicalId: "e1",
    contentHash: "h",
    comparableFields: { title: "DJ Night" },
    reported: { raw: { note: "seed" } },
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSyncedAt: NOW,
    sourceStatus: "active",
    consecutiveMisses: 0,
    ...over,
  };
}

/** Minimal apply-able plan wrapping one hand-built upsert. */
function planWith(...upserts: CanonicalUpsert[]): SyncPlan {
  return {
    run: { runId: "r1", sourceKey: "s", startedAt: NOW, mode: "apply", scope: { countries: [], cities: [] } },
    upserts,
    reconciliation: { reconciled: false, runStatus: "ok", actions: [], skippedReason: "n/a" },
    reviewItems: [],
    stats: {} as SyncPlan["stats"],
  };
}

function venueUpsert(over: Partial<CanonicalUpsert> = {}, coords: GeoPoint | null = { latitude: 44.8, longitude: 20.45 }): CanonicalUpsert {
  return {
    kind: "venue",
    operation: "insert",
    changeStatus: "NEW",
    canonicalId: null,
    fieldDeltas: [],
    record: {
      kind: "venue",
      provenance: { sourceKey: "osm", externalId: "osm-1", sourceUrl: null, confidence: 0.9, fetchedAt: NOW, reported: {} },
      scope: { countryCode: "RS", cityText: "Belgrade", coordinates: null },
      fields: {
        name: "Depo", normalizedName: "depo", address: null, coordinates: coords,
        coordinatesSource: coords ? "source" : null, website: null, wikidata: null, openingHours: null,
      },
      links: {},
    },
    identity: { entity: "venue", decision: "new_candidate", tier: 4, canonicalId: null, reasonCode: "x", note: "" },
    ...over,
  };
}

function eventUpsert(over: Partial<CanonicalUpsert> = {}): CanonicalUpsert {
  return {
    kind: "event",
    operation: "insert",
    changeStatus: "NEW",
    canonicalId: null,
    fieldDeltas: [],
    record: {
      kind: "event",
      provenance: { sourceKey: "entrio-hr", externalId: "E1", sourceUrl: null, confidence: 0.9, fetchedAt: NOW, reported: { audit: [1, 2] } },
      scope: { countryCode: "RS", cityText: "Belgrade", coordinates: null },
      fields: {
        title: "DJ Night", description: null, startLocal: "2026-07-01T22:00", endLocal: null, doorsLocal: null,
        timeZone: "Europe/Belgrade", startPrecision: "datetime", status: "scheduled", promoter: null,
        ticketUrl: null, coverImageUrl: null, lineup: [],
      },
      links: { venue: { name: "Depo", sourceVenueId: null, address: null, coordinates: null, cityText: "Belgrade" } },
    },
    identity: { entity: "event", decision: "new_candidate", tier: 3, canonicalId: null, reasonCode: "x", note: "" },
    resolvedVenueId: "v1",
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. READ-API MUTATION SAFETY
// ═══════════════════════════════════════════════════════════════════════

test("[read] mutating getVenueById()/getVenueBySource() results does not touch the store", async () => {
  const store = new InMemoryCanonicalStore({ cities: [city()], venues: [venue()] });

  const a = (await store.getVenueById("v1"))!;
  a.name = "HACKED";
  a.coordinates!.latitude = 0;
  a.isActive = false;

  const b = (await store.getVenueBySource("osm", "osm-1"))!;
  b.name = "ALSO HACKED";
  b.coordinates!.longitude = 999;

  const fresh = (await store.getVenueById("v1"))!;
  assert.equal(fresh.name, "Depo");
  assert.deepEqual(fresh.coordinates, { latitude: 44.8, longitude: 20.45 });
  assert.equal(fresh.isActive, true);
  assert.equal(store.venues[0].name, "Depo");
});

test("[read] mutating listVenuesInCity() / listCities() results does not touch the store", async () => {
  const store = new InMemoryCanonicalStore({ cities: [city()], venues: [venue()] });

  (await store.listVenuesInCity("city-bg")).forEach((v) => {
    v.name = "X";
    if (v.coordinates) v.coordinates.latitude = -1;
  });
  (await store.listCities()).forEach((c) => (c.name = "Y"));
  (await store.listCities("RS")).forEach((c) => (c.timeZone = "Etc/Nowhere"));

  assert.equal(store.venues[0].name, "Depo");
  assert.equal(store.venues[0].coordinates!.latitude, 44.8);
  assert.equal(store.cities[0].name, "Belgrade");
  assert.equal(store.cities[0].timeZone, "Europe/Belgrade");
});

test("[read] mutating getEventById()/getEventBySource()/findEventsAtVenueOnDate() results does not touch the store", async () => {
  const store = new InMemoryCanonicalStore({
    venues: [venue()],
    events: [event()],
    sourceLinks: [link()],
  });

  (await store.getEventById("e1"))!.title = "HACKED";
  (await store.getEventBySource("entrio-hr", "E1"))!.status = "cancelled";
  (await store.findEventsAtVenueOnDate("v1", "2026-07-01")).forEach((e) => (e.venueId = "GHOST"));

  const fresh = (await store.getEventById("e1"))!;
  assert.equal(fresh.title, "DJ Night");
  assert.equal(fresh.status, "scheduled");
  assert.equal(fresh.venueId, "v1");
});

test("[read] mutating getSourceLink()/listSourceLinks() results — including .reported and .comparableFields — does not touch the store", async () => {
  const store = new InMemoryCanonicalStore({
    venues: [venue()],
    events: [event()],
    sourceLinks: [link()],
  });

  const gl = (await store.getSourceLink("event", "entrio-hr", "E1"))!;
  gl.sourceStatus = "gone";
  gl.consecutiveMisses = 99;
  (gl.reported.raw as Record<string, unknown>).note = "TAMPERED";
  gl.comparableFields.title = "TAMPERED";

  for (const l of await store.listSourceLinks("event", "entrio-hr")) {
    l.sourceStatus = "gone";
    (l.reported.raw as Record<string, unknown>).note = "TAMPERED-2";
  }

  const stored = store.links.find((l) => l.id === "l1")!;
  assert.equal(stored.sourceStatus, "active");
  assert.equal(stored.consecutiveMisses, 0);
  assert.deepEqual(stored.reported, { raw: { note: "seed" } });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. DANGLING CANONICAL IDS / LINK CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════

test("[dangling] venue update to a non-existent canonical id is DEFERRED, no link written", async () => {
  // store has a venue, but NOT one matching this upsert's (source, external id)
  // and NOT one with id "v-ghost" -> targetId falls through to canonicalId.
  const store = new InMemoryCanonicalStore({ cities: [city()], venues: [venue({ id: "v-other", sourceKey: "osm", externalId: "different" })] });
  const res = await store.apply(
    planWith(venueUpsert({ operation: "update", canonicalId: "v-ghost" })),
    { commit: true },
  );
  assert.equal(res.updated, 0);
  assert.ok(res.deferred.some((d) => /v-ghost.*not found/.test(d)));
  assert.ok(!store.links.some((l) => l.canonicalId === "v-ghost"), "no source link to a nonexistent venue");
});

test("[dangling] venue link-only to a non-existent canonical id is DEFERRED, no link written", async () => {
  const store = new InMemoryCanonicalStore({ cities: [city()], venues: [venue({ id: "v-other", sourceKey: "osm", externalId: "different" })] });
  const res = await store.apply(
    planWith(venueUpsert({ operation: "link-only", canonicalId: "v-ghost" })),
    { commit: true },
  );
  assert.equal(res.linked, 0);
  assert.ok(res.deferred.some((d) => /v-ghost.*not found/.test(d)));
  assert.ok(!store.links.some((l) => l.canonicalId === "v-ghost"));
});

test("[dangling] event update to a non-existent canonical id is DEFERRED, no link written", async () => {
  const store = new InMemoryCanonicalStore({ venues: [venue()] });
  const res = await store.apply(
    planWith(eventUpsert({ operation: "update", canonicalId: "e-ghost" })),
    { commit: true },
  );
  assert.equal(res.updated, 0);
  assert.ok(res.deferred.some((d) => /e-ghost.*not found/.test(d)));
  assert.equal(store.links.filter((l) => l.kind === "event").length, 0);
});

test("[dangling] event link-only to a non-existent canonical id is DEFERRED, no link written", async () => {
  const store = new InMemoryCanonicalStore({ venues: [venue()] });
  const res = await store.apply(
    planWith(eventUpsert({ operation: "link-only", canonicalId: "e-ghost" })),
    { commit: true },
  );
  assert.equal(res.linked, 0);
  assert.ok(res.deferred.some((d) => /e-ghost.*not found/.test(d)));
  assert.equal(store.links.filter((l) => l.kind === "event").length, 0);
});

test("[dangling] a pre-existing link whose canonical event was removed is NOT re-linked to a ghost on re-sync", async () => {
  // link points at "e-removed" which no longer exists; the source re-lists it
  const store = new InMemoryCanonicalStore({
    venues: [venue()],
    events: [],
    sourceLinks: [link({ canonicalId: "e-removed", externalId: "E1" })],
  });
  const res = await store.apply(
    planWith(eventUpsert({ operation: "update", canonicalId: "e-removed" })),
    { commit: true },
  );
  assert.equal(res.updated, 0);
  assert.ok(res.deferred.some((d) => /e-removed.*not found/.test(d)));
  // the stale link is untouched (last-synced not bumped, still points nowhere real)
  assert.equal(store.links[0].canonicalId, "e-removed");
  assert.equal(store.links[0].lastSyncedAt, NOW);
});

// ═══════════════════════════════════════════════════════════════════════
//   INSERT PATHS — invalid foreign-key-like references
// ═══════════════════════════════════════════════════════════════════════

test("[insert] a venue whose scope.cityText resolves to no city is DEFERRED (no dangling cityId), parity with Supabase", async () => {
  const store = new InMemoryCanonicalStore({ cities: [city({ name: "Belgrade" })] });
  const res = await store.apply(
    planWith(
      venueUpsert({
        record: {
          ...venueUpsert().record,
          scope: { countryCode: "RS", cityText: "Beograd", coordinates: null }, // не Belgrade
        },
      }),
    ),
    { commit: true },
  );
  assert.equal(res.inserted, 0);
  assert.ok(res.deferred.some((d) => /Beograd.*not in cities/.test(d)));
  assert.equal(store.venues.length, 0);
});

test("[insert] a venue with a resolvable city is still inserted normally", async () => {
  const store = new InMemoryCanonicalStore({ cities: [city({ name: "Belgrade" })] });
  const res = await store.apply(planWith(venueUpsert()), { commit: true });
  assert.equal(res.inserted, 1);
  assert.equal(store.venues[0].cityId, "city-bg");
});

test("[insert] an event whose resolvedVenueId names no venue is DEFERRED (events.venue_id FK)", async () => {
  const store = new InMemoryCanonicalStore({ venues: [] }); // no v1
  const res = await store.apply(
    planWith(eventUpsert({ resolvedVenueId: "v-ghost" })),
    { commit: true },
  );
  assert.equal(res.inserted, 0);
  assert.ok(res.deferred.some((d) => /v-ghost not found/.test(d)));
  assert.equal(store.events.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. STORE SEED ISOLATION
// ═══════════════════════════════════════════════════════════════════════

test("[seed] mutating seed objects after construction does not reach store state", async () => {
  const seedCity = city();
  const seedVenue = venue();
  const seedEvent = event();
  const seedLink = link();
  const store = new InMemoryCanonicalStore({
    cities: [seedCity],
    venues: [seedVenue],
    events: [seedEvent],
    sourceLinks: [seedLink],
  });

  seedCity.name = "MUT";
  seedVenue.name = "MUT";
  seedVenue.coordinates!.latitude = 0;
  seedEvent.title = "MUT";
  seedLink.sourceStatus = "gone";
  (seedLink.reported.raw as Record<string, unknown>).note = "MUT";

  assert.equal((await store.getVenueById("v1"))!.name, "Depo");
  assert.equal((await store.getVenueById("v1"))!.coordinates!.latitude, 44.8);
  assert.equal((await store.getEventById("e1"))!.title, "DJ Night");
  assert.equal(store.cities[0].name, "Belgrade");
  assert.equal(store.links[0].sourceStatus, "active");
  assert.deepEqual(store.links[0].reported, { raw: { note: "seed" } });
});

test("[seed] mutating the store afterwards does not reach the caller's seed objects", async () => {
  const seedVenue = venue({ sourceKey: "osm", externalId: "osm-1" });
  const store = new InMemoryCanonicalStore({ cities: [city()], venues: [seedVenue] });

  // a plain update on the seeded venue (matched by source + external id)
  const up = venueUpsert({ operation: "update", canonicalId: "v1" });
  if (up.record.kind === "venue") {
    up.record.fields.name = "Renamed";
    up.record.fields.normalizedName = "renamed";
  }
  await store.apply(planWith(up), { commit: true });

  assert.equal(store.venues[0].name, "Renamed", "apply mutated the store's own copy");
  assert.equal(seedVenue.name, "Depo", "the caller's seed object is untouched by apply()");
  assert.equal(seedVenue.coordinates!.latitude, 44.8);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. APPLY INPUT MUTATION
// ═══════════════════════════════════════════════════════════════════════

test("[apply] apply(plan) does not mutate the plan / upserts / records / provenance / reconciliation", async () => {
  const store = new InMemoryCanonicalStore({ cities: [city()], venues: [venue({ id: "v1" })] });
  const plan = planWith(eventUpsert());
  plan.reconciliation = {
    reconciled: true,
    runStatus: "ok",
    actions: [{ key: "entrio-hr:E1", canonicalId: "e1", kind: "event", from: "active", transition: "keep-active", misses: 0, note: "seen" }],
    skippedReason: null,
  };
  const before = JSON.stringify(plan);
  await store.apply(plan, { commit: true });
  assert.equal(JSON.stringify(plan), before, "the plan object graph is unchanged by apply()");
});

test("[apply] mutating the plan AFTER apply() does not corrupt persisted store state (no shared coordinates / reported)", async () => {
  const store = new InMemoryCanonicalStore({ cities: [city()] });
  const up = venueUpsert({ operation: "insert" }, { latitude: 44.8, longitude: 20.45 });
  const plan = planWith(up);
  await store.apply(plan, { commit: true });

  // tamper with the plan's nested objects after the write
  if (up.record.kind === "venue") up.record.fields.coordinates!.latitude = -999;
  (up.record.provenance.reported as Record<string, unknown>).injected = true;

  const persisted = (await store.getVenueBySource("osm", "osm-1"))!;
  assert.equal(persisted.coordinates!.latitude, 44.8, "store did not alias the plan's coordinates object");

  const storedLink = store.links.find((l) => l.kind === "venue")!;
  assert.deepEqual(storedLink.reported, {}, "store did not alias the plan's provenance.reported object");
});
