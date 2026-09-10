/**
 * `../../src/sync/store.ts` — audit-pass characterization.
 *
 * The heavy read/write behaviour and comparable round-trip parity are already
 * covered by `store-persistence-parity.test.ts`, `store-mutation-safety.test.ts`
 * and `canonical-round-trip.test.ts`. This file adds the gaps that pass surfaced:
 *
 *   - the three comparable projections are field-for-field IDENTICAL (a swap
 *     cannot hide behind the round-trip helpers)
 *   - `comparable()` timezone handling for the event branch
 *   - `listCities` / `cityIdFor` matching semantics (the country-scope gap)
 *   - `apply` dry-run / reconciliation-persistence / counter semantics via a
 *     hand-built plan (no engine)
 *   - module-level id generation
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryCanonicalStore,
  comparable,
  eventComparable,
  venueComparable,
  type CanonicalEvent,
  type CanonicalVenue,
  type CityRecord,
  type SourceLink,
} from "../../src/sync/store.ts";
import type { CanonicalUpsert, NormalizedRecord, ReconcileAction, SyncPlan } from "../../src/sync/types.ts";

const NOW = "2026-06-01T00:00:00.000Z";

// ── fixtures ──────────────────────────────────────────────────────────
function canonVenue(over: Partial<CanonicalVenue> = {}): CanonicalVenue {
  return {
    id: "v1", cityId: "c1", cityName: "Belgrade", countryCode: "RS",
    name: "Klub Depo", normalizedName: "klub depo", address: "Karađorđeva 2",
    coordinates: { latitude: 44.81, longitude: 20.45 }, coordinatesSource: "source",
    website: "https://depo.rs", wikidata: "Q123", openingHours: "Mo-Su 22:00-05:00",
    description: "a cellar", openingTime: "22:00", closingTime: "05:00", isActive: true,
    sourceKey: "osm", externalId: "n-1", sourceUrl: null,
    createdAt: NOW, updatedAt: NOW, ...over,
  };
}
function canonEvent(over: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: "e1", venueId: "v1", title: "Boris Brejcha", description: "techno night",
    startLocal: "2026-07-01T22:00", timeZone: "Europe/Belgrade", endLocal: "2026-07-02T05:00",
    status: "scheduled", ticketUrl: "https://t.rs/e/9", coverImageUrl: "https://i.rs/9.jpg",
    canonicalSourceKey: "gigstix", sourceUrl: null, createdAt: NOW, updatedAt: NOW, ...over,
  };
}
function venueRecordFrom(v: CanonicalVenue): Extract<NormalizedRecord, { kind: "venue" }> {
  return {
    kind: "venue",
    provenance: { sourceKey: v.sourceKey ?? "s", externalId: v.externalId ?? "x", sourceUrl: v.sourceUrl, confidence: 1, fetchedAt: NOW, reported: {} },
    scope: { countryCode: v.countryCode, cityText: v.cityName, coordinates: null },
    fields: {
      name: v.name, normalizedName: v.normalizedName, address: v.address,
      coordinates: v.coordinates, coordinatesSource: v.coordinatesSource as never,
      website: v.website, wikidata: v.wikidata, openingHours: v.openingHours,
      description: v.description, openingTime: v.openingTime, closingTime: v.closingTime,
      isActive: v.isActive,
    },
    links: {},
  };
}
function eventRecordFrom(e: CanonicalEvent): Extract<NormalizedRecord, { kind: "event" }> {
  return {
    kind: "event",
    provenance: { sourceKey: e.canonicalSourceKey, externalId: "x", sourceUrl: null, confidence: 1, fetchedAt: NOW, reported: {} },
    scope: { countryCode: "RS", cityText: "Belgrade", coordinates: null },
    fields: {
      title: e.title, description: e.description, startLocal: e.startLocal, endLocal: e.endLocal,
      doorsLocal: null, timeZone: e.timeZone, startPrecision: e.startLocal.length > 10 ? "datetime" : "date",
      status: e.status, promoter: null, ticketUrl: e.ticketUrl, coverImageUrl: e.coverImageUrl, lineup: [],
    },
    links: {},
  };
}
function planWith(upserts: CanonicalUpsert[], actions: ReconcileAction[] = []): SyncPlan {
  return {
    run: { runId: "r1", sourceKey: "s", startedAt: NOW, mode: "apply", scope: { countries: [], cities: [] } },
    upserts,
    reconciliation: { reconciled: actions.length > 0, runStatus: "ok", actions, skippedReason: actions.length > 0 ? null : "n/a" },
    reviewItems: [],
    stats: {} as SyncPlan["stats"],
  };
}
function link(over: Partial<SourceLink> = {}): SourceLink {
  return {
    id: "l1", kind: "event", sourceKey: "gigstix", externalId: "E1", sourceUrl: null,
    canonicalId: "e1", contentHash: "h", comparableFields: {}, reported: {},
    firstSeenAt: NOW, lastSeenAt: NOW, lastSyncedAt: NOW, sourceStatus: "active", consecutiveMisses: 0,
    ...over,
  };
}

// ═══ 2. COMPARABLE PROJECTIONS — field-for-field identity ═══════════════
test("venueComparable(row) === comparable(venue record) for a fully-populated venue (distinct values)", () => {
  const v = canonVenue();
  assert.deepEqual(venueComparable(v), comparable(venueRecordFrom(v)));
});

test("venueComparable / comparable agree on every NULL field too", () => {
  const v = canonVenue({
    address: null, coordinates: null, coordinatesSource: null, website: null,
    wikidata: null, openingHours: null, description: null, openingTime: null, closingTime: null,
  });
  const a = venueComparable(v);
  const b = comparable(venueRecordFrom(v));
  assert.deepEqual(a, b);
  assert.equal(a.lat, null);
  assert.equal(a.lon, null);
  assert.equal(a.openingTime, null);
});

test("venueComparable keys are exactly the persisted-and-reconstructable set (no extra, none missing)", () => {
  assert.deepEqual(Object.keys(venueComparable(canonVenue())).sort(), [
    "address", "closingTime", "description", "isActive", "lat", "lon",
    "name", "normalizedName", "openingHours", "openingTime", "website", "wikidata",
  ]);
  // promoter / lineup / doorsLocal / startPrecision are deliberately absent
  assert.equal("coordinates" in venueComparable(canonVenue()), false, "coords split to lat/lon");
});

test("comparable(venue) normalizes openingTime/closingTime to HH:MM regardless of incoming shape", () => {
  const rec = venueRecordFrom(canonVenue());
  rec.fields.openingTime = "20:00:00";
  rec.fields.closingTime = "4:5";
  const c = comparable(rec);
  assert.equal(c.openingTime, "20:00");
  assert.equal(c.closingTime, null, "an unparseable HH:MM is null, not passed through");
});

test("comparable(venue) coerces optional isActive/description defaults the same way the store does", () => {
  const rec = venueRecordFrom(canonVenue());
  delete (rec.fields as unknown as Record<string, unknown>).isActive;
  delete (rec.fields as unknown as Record<string, unknown>).description;
  const c = comparable(rec);
  assert.equal(c.isActive, true, "omitted isActive -> true");
  assert.equal(c.description, null, "omitted description -> null");
});

test("eventComparable(row) === comparable(event record) field-for-field (distinct values)", () => {
  const e = canonEvent();
  assert.deepEqual(eventComparable(e), comparable(eventRecordFrom(e)));
});

test("eventComparable keys are exactly the persisted-and-reconstructable set", () => {
  assert.deepEqual(Object.keys(eventComparable(canonEvent())).sort(), [
    "coverImageUrl", "description", "endInstant", "isCancelled", "startInstant", "ticketUrl", "title",
  ]);
  // promoter / lineup / startLocal / timeZone / endLocal / status(raw) are absent
});

// ═══ 3. TIMEZONE / EVENT INSTANT ══════════════════════════════════════
test("comparable(event) resolves start/end through the zone, DST-aware, matching the write path", () => {
  const summer = comparable(eventRecordFrom(canonEvent({ startLocal: "2026-07-01T22:00", endLocal: null, timeZone: "Europe/Belgrade" })));
  assert.equal(summer.startInstant, "2026-07-01T20:00:00.000Z"); // +02:00 in July
  assert.equal(summer.endInstant, null, "null endLocal stays null");

  const winter = comparable(eventRecordFrom(canonEvent({ startLocal: "2026-01-01T22:00", endLocal: null, timeZone: "Europe/Belgrade" })));
  assert.equal(winter.startInstant, "2026-01-01T21:00:00.000Z"); // +01:00 in January
});

test("comparable(event) does NOT double-convert an already-offset-bearing start", () => {
  const c = comparable(eventRecordFrom(canonEvent({ startLocal: "2026-07-01T20:00:00+00:00", endLocal: null, timeZone: "Europe/Belgrade" })));
  assert.equal(c.startInstant, "2026-07-01T20:00:00.000Z", "the explicit offset wins; the zone is ignored");
});

test("comparable(event) treats a bare YYYY-MM-DD as LOCAL midnight in the zone (persistence parity)", () => {
  const c = comparable(eventRecordFrom(canonEvent({ startLocal: "2026-07-01", endLocal: null, timeZone: "Europe/Belgrade" })));
  assert.equal(c.startInstant, "2026-06-30T22:00:00.000Z");
});

test("comparable(event) with NO zone interprets the wall-clock as UTC (never process-local)", () => {
  const c = comparable(eventRecordFrom(canonEvent({ startLocal: "2026-07-01T22:00", endLocal: null, timeZone: null })));
  assert.equal(c.startInstant, "2026-07-01T22:00:00.000Z");
});

// ═══ 4. IMMUTABILITY (light — store-mutation-safety covers the rest) ═══
test("constructor snapshots the seed; a frozen seed is accepted and later store writes don't touch it", async () => {
  const seedVenue = canonVenue();
  Object.freeze(seedVenue); // frozen input must not make the constructor throw
  const store = new InMemoryCanonicalStore({ cities: [{ id: "c1", countryCode: "RS", name: "Belgrade", timeZone: null }], venues: [seedVenue] });
  const back = (await store.getVenueById("v1"))!;
  back.name = "MUT";
  assert.equal((await store.getVenueById("v1"))!.name, "Klub Depo");
  assert.equal(seedVenue.name, "Klub Depo");
});

// ═══ 5. READ METHODS — matching semantics ═════════════════════════════
test("listCities(countryCode) matches case-insensitively on BOTH sides; no arg returns all; detached", async () => {
  const cities: CityRecord[] = [
    { id: "c-rs", countryCode: "rs", name: "Belgrade", timeZone: null },
    { id: "c-hr", countryCode: "HR", name: "Zagreb", timeZone: null },
  ];
  const store = new InMemoryCanonicalStore({ cities });
  assert.deepEqual((await store.listCities("RS")).map((c) => c.id), ["c-rs"]);
  assert.deepEqual((await store.listCities("hr")).map((c) => c.id), ["c-hr"]);
  assert.equal((await store.listCities()).length, 2);
  (await store.listCities()).forEach((c) => (c.name = "X"));
  assert.equal(store.cities[0].name, "Belgrade");
});

test("getEventBySource resolves via the event source-link; null when the link's canonical event is gone", async () => {
  const store = new InMemoryCanonicalStore({
    events: [canonEvent({ id: "e1" })],
    sourceLinks: [link({ canonicalId: "e1" }), link({ id: "l2", externalId: "E2", canonicalId: "e-missing" })],
  });
  assert.equal((await store.getEventBySource("gigstix", "E1"))!.id, "e1");
  assert.equal(await store.getEventBySource("gigstix", "E2"), null, "link exists, event does not -> null");
  assert.equal(await store.getEventBySource("gigstix", "nope"), null);
});

test("findEventsAtVenueOnDate matches on the date SLICE of startLocal (wall-clock local date)", async () => {
  const store = new InMemoryCanonicalStore({
    events: [
      canonEvent({ id: "e1", venueId: "v1", startLocal: "2026-07-01T23:30" }),
      canonEvent({ id: "e2", venueId: "v1", startLocal: "2026-07-02T00:30" }),
      canonEvent({ id: "e3", venueId: "v2", startLocal: "2026-07-01T22:00" }),
    ],
  });
  assert.deepEqual((await store.findEventsAtVenueOnDate("v1", "2026-07-01")).map((e) => e.id), ["e1"]);
  assert.deepEqual((await store.findEventsAtVenueOnDate("v1", "2026-07-01T00:00")).map((e) => e.id), ["e1"]);
});

// ═══ 6. DRY-RUN ══════════════════════════════════════════════════════
test("apply(commit:false) writes nothing, notes it, and still records applied history", async () => {
  const store = new InMemoryCanonicalStore({ cities: [{ id: "c1", countryCode: "RS", name: "Belgrade", timeZone: null }] });
  const up: CanonicalUpsert = {
    kind: "venue", operation: "insert", changeStatus: "NEW", canonicalId: null, fieldDeltas: [],
    record: venueRecordFrom(canonVenue()),
    identity: { entity: "venue", decision: "new_candidate", tier: 4, canonicalId: null, reasonCode: "x", note: "" },
  };
  const r1 = await store.apply(planWith([up]), { commit: false });
  const r2 = await store.apply(planWith([up]), { commit: false });
  assert.equal(r1.committed, false);
  assert.equal(r1.inserted, 0);
  assert.deepEqual(r1.notes, ["dry apply — nothing written"]);
  assert.equal(store.venues.length, 0);
  assert.equal(store.links.length, 0);
  assert.equal(store.applied.length, 2, "each dry apply is recorded");
});

// ═══ 7 & 13. COMMIT COUNTERS ═════════════════════════════════════════
test("apply() counters reflect exactly what happened across a mixed plan", async () => {
  const store = new InMemoryCanonicalStore({
    cities: [{ id: "c1", countryCode: "RS", name: "Belgrade", timeZone: null }],
    venues: [canonVenue({ id: "v1", sourceKey: "osm", externalId: "n-1" })],
    events: [canonEvent({ id: "e1" })],
  });
  const mk = (o: Partial<CanonicalUpsert>, externalId = "n-1"): CanonicalUpsert => ({
    kind: "venue", operation: "skip", changeStatus: "UNCHANGED", canonicalId: null, fieldDeltas: [],
    record: venueRecordFrom(canonVenue({ externalId })),
    identity: { entity: "venue", decision: "matched", tier: 2, canonicalId: "v1", reasonCode: "x", note: "" },
    ...o,
  });
  const res = await store.apply(planWith([
    mk({ operation: "skip" }),
    mk({ operation: "link-only", canonicalId: "v1" }),
    // provenance (osm, n-ghost) matches no seeded venue, and canonicalId is a ghost -> deferred
    mk({ operation: "update", canonicalId: "v-ghost" }, "n-ghost"),
  ]), { commit: true });
  assert.equal(res.committed, true);
  assert.equal(res.skipped, 1);
  assert.equal(res.linked, 1);
  assert.equal(res.updated, 0);
  assert.equal(res.deferred.length, 1);
  assert.match(res.deferred[0], /v-ghost.*not found/);
  assert.equal(res.error, null, "InMemory store never populates `error` (Supabase halts on a real DB error)");
});

// ═══ 12. RECONCILIATION PERSISTENCE ══════════════════════════════════
test("applyReconcile persists each transition onto the source link and counts only applied actions", async () => {
  const store = new InMemoryCanonicalStore({
    events: [canonEvent({ id: "e1" })],
    sourceLinks: [
      link({ id: "lA", externalId: "A", canonicalId: "e1", sourceStatus: "active", consecutiveMisses: 0 }),
      link({ id: "lB", externalId: "B", canonicalId: "e1", sourceStatus: "stale", consecutiveMisses: 1 }),
      link({ id: "lC", externalId: "C", canonicalId: "e1", sourceStatus: "stale", consecutiveMisses: 2 }),
      link({ id: "lD", externalId: "D", canonicalId: "e1", sourceStatus: "active", consecutiveMisses: 0 }),
    ],
  });
  const act = (externalId: string, transition: ReconcileAction["transition"], misses: number): ReconcileAction => ({
    key: `gigstix:${externalId}`, canonicalId: "e1", kind: "event", from: "active", transition, misses, note: "",
  });
  const res = await store.apply(planWith([], [
    act("A", "keep-active", 0),
    act("B", "mark-stale", 1),
    act("C", "mark-gone", 3),
    act("D", "no-op", 0),
    act("MISSING", "mark-missing", 2), // no such link -> ignored
  ]), { commit: true });

  const byId = (id: string) => store.links.find((l) => l.id === id)!;
  assert.equal(byId("lA").sourceStatus, "active");
  assert.equal(byId("lB").sourceStatus, "stale");
  assert.equal(byId("lB").consecutiveMisses, 1);
  assert.equal(byId("lC").sourceStatus, "gone");
  assert.equal(byId("lC").consecutiveMisses, 3);
  assert.equal(byId("lD").sourceStatus, "active", "no-op left it alone");
  assert.equal(res.reconciled, 3, "keep-active + mark-stale + mark-gone applied; no-op and missing link did not");
  // the canonical event itself is never touched by reconciliation
  assert.equal((await store.getEventById("e1"))!.status, "scheduled");
});

test("apply() skips reconciliation entirely when the plan is not reconciled", async () => {
  const store = new InMemoryCanonicalStore({
    events: [canonEvent({ id: "e1" })],
    sourceLinks: [link({ id: "lA", externalId: "A", canonicalId: "e1", sourceStatus: "active" })],
  });
  const plan = planWith([]);
  plan.reconciliation = {
    reconciled: false, runStatus: "failed", skippedReason: "run failed",
    actions: [{ key: "gigstix:A", canonicalId: "e1", kind: "event", from: "active", transition: "mark-gone", misses: 9, note: "" }],
  };
  const res = await store.apply(plan, { commit: true });
  assert.equal(res.reconciled, 0);
  assert.equal(store.links[0].sourceStatus, "active", "a non-reconciled plan's actions are never applied");
});

// ═══ 15. CITY RESOLUTION — country-scope gap (characterization) ═══════
test("[parity-gap] cityIdFor matches on NAME ONLY — countryCode in the upsert scope is not consulted", async () => {
  // `SupabaseCanonicalStore.resolveCityId` filters by (name AND country_id) and
  // resolves only on a UNIQUE match. `InMemoryCanonicalStore.cityIdFor` takes
  // only the text and returns the FIRST name match. No CURRENT config has two
  // cities sharing a name across countries, so no valid SyncPlan diverges today
  // — this pins the behaviour so a future same-name city is a conscious choice.
  const store = new InMemoryCanonicalStore({
    cities: [
      { id: "city-VE", countryCode: "VE", name: "Valencia", timeZone: "America/Caracas" },
      { id: "city-ES", countryCode: "ES", name: "Valencia", timeZone: "Europe/Madrid" },
    ],
  });
  const up: CanonicalUpsert = {
    kind: "venue", operation: "insert", changeStatus: "NEW", canonicalId: null, fieldDeltas: [],
    record: {
      kind: "venue",
      provenance: { sourceKey: "osm", externalId: "v-x", sourceUrl: null, confidence: 1, fetchedAt: NOW, reported: {} },
      scope: { countryCode: "ES", cityText: "Valencia", coordinates: null }, // wants Spain
      fields: { name: "Sala X", normalizedName: "sala x", address: null, coordinates: null, coordinatesSource: null, website: null, wikidata: null, openingHours: null, description: null, openingTime: null, closingTime: null, isActive: true },
      links: {},
    },
    identity: { entity: "venue", decision: "new_candidate", tier: 4, canonicalId: null, reasonCode: "x", note: "" },
  };
  const res = await store.apply(planWith([up]), { commit: true });
  assert.equal(res.inserted, 1);
  assert.equal(store.venues[0].cityId, "city-VE", "resolves to the FIRST 'Valencia' row, ignoring countryCode='ES'");
});

test("cityIdFor with an exact single name match still resolves normally (the common path)", async () => {
  const store = new InMemoryCanonicalStore({
    cities: [{ id: "c1", countryCode: "RS", name: "Belgrade", timeZone: null }],
  });
  const up: CanonicalUpsert = {
    kind: "venue", operation: "insert", changeStatus: "NEW", canonicalId: null, fieldDeltas: [],
    record: venueRecordFrom(canonVenue({ cityName: "Belgrade", countryCode: "RS" })),
    identity: { entity: "venue", decision: "new_candidate", tier: 4, canonicalId: null, reasonCode: "x", note: "" },
  };
  const res = await store.apply(planWith([up]), { commit: true });
  assert.equal(res.inserted, 1);
  assert.equal(store.venues[0].cityId, "c1");
});

// ═══ 16. MODULE-LEVEL ID GENERATION ═════════════════════════════════
test("generated ids are unique across separate store instances and are opaque (tests never hardcode them)", async () => {
  const seed = { cities: [{ id: "c1", countryCode: "RS", name: "Belgrade", timeZone: null }] };
  const mkUpsert = (): CanonicalUpsert => ({
    kind: "venue", operation: "insert", changeStatus: "NEW", canonicalId: null, fieldDeltas: [],
    record: venueRecordFrom(canonVenue()),
    identity: { entity: "venue", decision: "new_candidate", tier: 4, canonicalId: null, reasonCode: "x", note: "" },
  });
  const s1 = new InMemoryCanonicalStore(seed);
  const s2 = new InMemoryCanonicalStore(seed);
  await s1.apply(planWith([mkUpsert()]), { commit: true });
  await s2.apply(planWith([mkUpsert()]), { commit: true });
  assert.notEqual(s1.venues[0].id, s2.venues[0].id, "no id collision across instances");
  assert.match(s1.venues[0].id, /^venue-\d+$/);
});
