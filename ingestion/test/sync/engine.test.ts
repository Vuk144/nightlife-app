/**
 * Characterization + regression tests for `../../src/sync/engine.ts#planSync`.
 *
 * The audit (10 hypotheses) found ONE real correctness bug — `stats.durationMs`
 * was always 0 (`H1 regression` below). Everything else is intentional / a
 * documented precondition / a deferred perf concern; each is pinned here as
 * `[Hn characterization]` with the contract stated in the test.
 *
 * `planSync` is otherwise exercised end-to-end by `./zagreb.test.ts`,
 * `./contract.test.ts`, `./canonical-round-trip.test.ts` and the store-parity
 * suites; this file targets the specific behaviors the audit questioned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../../src/sync/engine.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import {
  provider,
  seededStore,
  venueRecord,
  eventRecord,
  fakeItem,
  venuePage,
} from "./world.ts";

const NOW = "2026-06-01T00:00:00.000Z";
const cfg = () => provider();
const src = (key: string) => provider().source(key)!;

const venueItems = (recs: Parameters<typeof venueRecord>[0][]) =>
  recs.map((r) => fakeItem(venueRecord(r)));

function canonVenue(over: Partial<CanonicalVenue> & { id: string }): CanonicalVenue {
  return {
    cityId: "city-zg",
    cityName: "Zagreb",
    countryCode: "HR",
    name: over.id,
    normalizedName: over.id,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════
//  H1 — durationMs   (REAL BUG → fixed)
// ════════════════════════════════════════════════════════════════════

test("[H1 regression] stats.durationMs measures elapsed wall-clock time (was always 0)", async (t) => {
  // Both timestamps come from Date.now(): first call at the start, last call in
  // finish(). Mock it so the delta is deterministic.
  const ticks = [1_000_000, 1_000_037];
  let call = 0;
  t.mock.method(Date, "now", () => ticks[Math.min(call++, ticks.length - 1)]);

  const adapter = createInMemoryAdapter({
    key: "osm",
    items: venueItems([{ sourceKey: "osm", externalId: "v1", countryCode: "RS", cityText: "Belgrade", name: "Klub One" }]),
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: seededStore(), now: NOW, runId: "r1" });

  assert.equal(plan.stats.durationMs, 37, "durationMs must reflect Date.now() end − start, not a constant");
  assert.equal(plan.run.startedAt, NOW, "run.startedAt is still the injected `now`, unchanged");
});

test("[H1 regression] durationMs is never negative", async (t) => {
  const ticks = [5_000, 4_990]; // clock went backwards (NTP adjustment)
  let call = 0;
  t.mock.method(Date, "now", () => ticks[Math.min(call++, ticks.length - 1)]);
  const adapter = createInMemoryAdapter({ key: "osm", items: venueItems([{ sourceKey: "osm", externalId: "v1", countryCode: "RS", cityText: "Belgrade", name: "Klub One" }]) });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: seededStore(), now: NOW, runId: "r1" });
  assert.equal(plan.stats.durationMs, 0);
});

// ════════════════════════════════════════════════════════════════════
//  H2 — seenKeys timing  (INTENTIONAL: "seen" = "appeared in the source")
// ════════════════════════════════════════════════════════════════════

test("[H2 characterization] a REJECTED incoming record still PROTECTS its stored link from reconciliation", async (t) => {
  // Contract: seenKeys is populated for every PARSED record, BEFORE validation.
  // A record that fails validation still appeared in the source this run, so
  // reconciliation must not progress it toward stale/missing/gone.
  const store = seededStore();
  store.links.push({
    id: "link-rej", kind: "venue", sourceKey: "osm", externalId: "v-rej",
    sourceUrl: null, canonicalId: "v-zg-tvornica", contentHash: "h", comparableFields: {},
    reported: {}, firstSeenAt: "2026-05-01T00:00:00.000Z", lastSeenAt: "2026-05-20T00:00:00.000Z",
    lastSyncedAt: "2026-05-20T00:00:00.000Z", sourceStatus: "active", consecutiveMisses: 2,
  });

  // an incoming venue record for the SAME (source, externalId) that validation rejects (name too short)
  const adapter = createInMemoryAdapter({
    key: "osm",
    items: venueItems([{ sourceKey: "osm", externalId: "v-rej", countryCode: "HR", cityText: "Zagreb", name: "X" }]),
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" });

  assert.equal(plan.stats.byChangeStatus.REJECTED, 1);
  const act = plan.reconciliation.actions.find((a) => a.key === "osm:v-rej");
  assert.ok(act, "the stored link is reconciled");
  assert.equal(act.transition, "keep-active", "REJECTED-but-present ⇒ keep-active, misses cleared");
  assert.equal(act.misses, 0);
});

test("[H2 characterization] a link NOT seen this run still progresses through the lifecycle", async (t) => {
  const store = seededStore();
  store.links.push({
    id: "link-gone", kind: "venue", sourceKey: "osm", externalId: "v-old",
    sourceUrl: null, canonicalId: "v-zg-mocvara", contentHash: "h", comparableFields: {},
    reported: {}, firstSeenAt: "2026-05-01T00:00:00.000Z", lastSeenAt: "2026-05-20T00:00:00.000Z",
    lastSyncedAt: "2026-05-20T00:00:00.000Z", sourceStatus: "active", consecutiveMisses: 0,
  });
  // this run sees a DIFFERENT venue, not v-old
  const adapter = createInMemoryAdapter({
    key: "osm",
    items: venueItems([{ sourceKey: "osm", externalId: "v-new", countryCode: "HR", cityText: "Zagreb", name: "Klub New" }]),
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" });
  const act = plan.reconciliation.actions.find((a) => a.key === "osm:v-old");
  assert.equal(act?.transition, "mark-stale", "unseen (1st miss) ⇒ stale, per DEFAULT_RECONCILIATION");
});

// ════════════════════════════════════════════════════════════════════
//  H3 — ambiguous event venue  (INTENTIONAL: store contract anticipates
//       resolvedVenueId === null; see store.ts#applyEvent)
// ════════════════════════════════════════════════════════════════════

test("[H3 characterization] an event with an AMBIGUOUS venue: venue → review, event upsert continues with resolvedVenueId: null", async (t) => {
  const store = seededStore();
  // two Zagreb venues sharing the incoming venue name → ambiguous
  store.venues.push(
    canonVenue({ id: "v-dup-a", name: "Klub Depo", normalizedName: "klub depo" }),
    canonVenue({ id: "v-dup-b", name: "Klub Depo", normalizedName: "klub depo" }),
  );

  const adapter = createInMemoryAdapter({
    key: "entrio-hr",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "entrio-hr", externalId: "E-AMB", countryCode: "HR", cityText: "Zagreb",
          title: "Ambiguous Night", startLocal: "2026-08-01T22:00", venueName: "Klub Depo", sourceVenueId: null,
        }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r1" });

  // the venue is held for review
  const venueReview = plan.reviewItems.find((r) => r.kind === "venue");
  assert.ok(venueReview, "the ambiguous venue is a review item");
  assert.match(venueReview.reasonCode, /ambiguous/);

  // …the event STILL produces an upsert, carrying resolvedVenueId: null
  const eventUpsert = plan.upserts.find((u) => u.kind === "event");
  assert.ok(eventUpsert, "the event is not dropped");
  assert.equal(eventUpsert.resolvedVenueId, null);

  // and the store's apply() SKIPS an insert with no venue (its documented behavior)
  const res = await store.apply(plan, { commit: true });
  assert.equal(res.error, null);
  assert.equal(store.events.length, 0, "no event row is created without a resolved venue");
});

// ════════════════════════════════════════════════════════════════════
//  H4 — invalid `now`  (PRECONDITION: `now` must be a valid ISO instant)
// ════════════════════════════════════════════════════════════════════

function pastEventWorld() {
  const store = seededStore();
  // a PAST event link that MUST stay frozen (retained, never reconciled)
  store.venues.push(canonVenue({ id: "v-freeze" }));
  store.events.push({
    id: "ev-past", venueId: "v-freeze", title: "Last Year", description: null,
    startLocal: "2025-01-01T20:00", timeZone: "Europe/Zagreb", endLocal: null,
    status: "scheduled", ticketUrl: null, coverImageUrl: null, canonicalSourceKey: "entrio-hr",
    sourceUrl: null,
    createdAt: "2024-12-01T00:00:00.000Z", updatedAt: "2024-12-01T00:00:00.000Z",
  });
  store.links.push({
    id: "link-past", kind: "event", sourceKey: "entrio-hr", externalId: "E-PAST",
    sourceUrl: null, canonicalId: "ev-past", contentHash: "h", comparableFields: {},
    reported: {}, firstSeenAt: "2024-12-01T00:00:00.000Z", lastSeenAt: "2024-12-15T00:00:00.000Z",
    lastSyncedAt: "2024-12-15T00:00:00.000Z", sourceStatus: "active", consecutiveMisses: 0,
  });
  // one CURRENT event so the run is healthy and reconciliation actually runs
  const adapter = createInMemoryAdapter({
    key: "entrio-hr",
    items: [
      fakeItem(eventRecord({
        sourceKey: "entrio-hr", externalId: "E-NOW", countryCode: "HR", cityText: "Zagreb",
        title: "This Year", startLocal: "2026-08-01T22:00", venueName: "Tvornica", sourceVenueId: null,
      })),
    ],
  });
  return { store, adapter };
}

test("[H4 characterization] a valid ISO `now` freezes the past event; reconciliation leaves it alone", async () => {
  const { store, adapter } = pastEventWorld();
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r-good" });
  assert.equal(plan.stats.status, "ok");
  assert.equal(plan.reconciliation.reconciled, true);
  assert.equal(
    plan.reconciliation.actions.find((a) => a.key === "entrio-hr:E-PAST")?.transition,
    "no-op",
    "past event is frozen → retained",
  );
});

test("[H4 characterization] planSync does NOT validate `now`; an unparseable value runs 'ok', is stored verbatim, and DEFEATS past-event freeze protection", async () => {
  const { store, adapter } = pastEventWorld();
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: "not-a-timestamp", runId: "r-bad" });

  assert.equal(plan.stats.status, "ok", "no `now` validation — the run still 'succeeds'");
  assert.equal(plan.run.startedAt, "not-a-timestamp", "the garbage string is written straight into the plan");

  // toInstantMs("not-a-timestamp") === null ⇒ `frozen` can never be true ⇒ the
  // PAST event is treated as a live unseen record and progresses. Callers MUST
  // pass a valid ISO instant; this is a documented precondition, not a fix here.
  assert.equal(
    plan.reconciliation.actions.find((a) => a.key === "entrio-hr:E-PAST")?.transition,
    "mark-stale",
    "documented gap: an invalid `now` defeats past-event freeze protection",
  );
});

// ════════════════════════════════════════════════════════════════════
//  H5 — primaryCountry  (INTENTIONAL: first configured source country →
//       adapter default; per-record scope is resolved independently)
// ════════════════════════════════════════════════════════════════════

test("[H5 characterization] a multi-country source's adapter default is its FIRST scoped country; per-record resolution is independent", async (t) => {
  // `cooltix` has scope.countries = ["RS", "HR"]. An HR event from it, with NO
  // source-provided timeZone, must still get Europe/Zagreb (city→country), not
  // the adapter default Europe/Belgrade.
  const store = seededStore();
  const adapter = createInMemoryAdapter({
    key: "cooltix",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "cooltix", externalId: "E-HR", countryCode: "HR", cityText: "Zagreb",
          title: "Zagreb Show", startLocal: "2026-09-01T21:00", venueName: "Tvornica", sourceVenueId: null,
          timeZone: null,
        }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("cooltix"), config: cfg(), store, now: NOW, runId: "r1" });
  const up = plan.upserts.find((u) => u.kind === "event");
  assert.ok(up && up.record.kind === "event");
  assert.equal(up.record.fields.timeZone, "Europe/Zagreb", "resolved from the record's HR city, not the RS adapter default");
});

// ════════════════════════════════════════════════════════════════════
//  H7 — linkedVenueCache  (per-run, per-source; key = sourceVenueId)
// ════════════════════════════════════════════════════════════════════

test("[H7 characterization] fetchLinked is called ONCE per sourceVenueId within a run; a fresh planSync starts cold", async (t) => {
  let fetchLinkedCalls = 0;
  const base = createInMemoryAdapter({
    key: "entrio-hr",
    capabilities: { givesVenuePages: true },
    items: [
      fakeItem(eventRecord({ sourceKey: "entrio-hr", externalId: "E1", countryCode: "HR", cityText: "Zagreb", title: "Night 1", startLocal: "2026-08-01T22:00", venueName: "Tvornica", sourceVenueId: "tvornica-zg" })),
      fakeItem(eventRecord({ sourceKey: "entrio-hr", externalId: "E2", countryCode: "HR", cityText: "Zagreb", title: "Night 2", startLocal: "2026-08-02T22:00", venueName: "Tvornica", sourceVenueId: "tvornica-zg" })),
    ],
    venuePages: [
      venuePage("tvornica-zg", venueRecord({ sourceKey: "entrio-hr", externalId: "tvornica-zg", countryCode: "HR", cityText: "Zagreb", name: "Tvornica", coordinates: { latitude: 45.8071, longitude: 15.9663 } })),
    ],
  });
  const adapter = {
    ...base,
    async fetchLinked(...args: Parameters<NonNullable<typeof base.fetchLinked>>) {
      fetchLinkedCalls++;
      return base.fetchLinked!(...args);
    },
  };

  await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: seededStore(), now: NOW, runId: "r1" });
  assert.equal(fetchLinkedCalls, 1, "two events, one sourceVenueId → one fetchLinked (cached)");

  await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: seededStore(), now: NOW, runId: "r2" });
  assert.equal(fetchLinkedCalls, 2, "a new run's linkedVenueCache is empty → fetchLinked runs again");
});

// ════════════════════════════════════════════════════════════════════
//  H8 / H9 — reconciliation safety & error propagation
// ════════════════════════════════════════════════════════════════════

test("[H8 characterization] an UNHEALTHY run (parse-failure ratio) skips reconciliation entirely", async (t) => {
  const store = seededStore();
  store.links.push({
    id: "link-x", kind: "venue", sourceKey: "osm", externalId: "v-x",
    sourceUrl: null, canonicalId: "v-zg-tvornica", contentHash: "h", comparableFields: {},
    reported: {}, firstSeenAt: "2026-05-01T00:00:00.000Z", lastSeenAt: "2026-05-20T00:00:00.000Z",
    lastSyncedAt: "2026-05-20T00:00:00.000Z", sourceStatus: "active", consecutiveMisses: 0,
  });
  // an adapter whose parse() always fails
  const adapter = {
    ...createInMemoryAdapter({ key: "osm", items: [] }),
    async *discover() {
      for (const id of ["a", "b", "c"]) yield { url: `m://${id}`, externalId: id, kindHint: "venue" as const, lastModified: null };
    },
    async fetch(ref: { url: string | null; externalId: string | null }) {
      return { ref: ref as never, url: ref.url ?? "", status: 200, body: "{}", contentType: "application/json", fetchedAt: NOW };
    },
    parse() {
      return { ok: false as const, reason: "always-broken" };
    },
  };
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" });
  assert.notEqual(plan.stats.status, "ok");
  assert.equal(plan.stats.healthy, false);
  assert.equal(plan.reconciliation.reconciled, false);
  assert.deepEqual(plan.reconciliation.actions, []);
});

test("[H9 characterization] a store read that REJECTS during per-record processing propagates out of planSync — BEFORE reconciliation, so no reconcile action is produced", async (t) => {
  const store = seededStore();
  const boom = new Error("db connection lost");
  store.getSourceLink = async () => {
    throw boom;
  };
  const adapter = createInMemoryAdapter({
    key: "osm",
    items: venueItems([{ sourceKey: "osm", externalId: "v1", countryCode: "HR", cityText: "Zagreb", name: "Klub One" }]),
  });
  await assert.rejects(
    planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" }),
    /db connection lost/,
  );
});

// ════════════════════════════════════════════════════════════════════
//  H10 — limit
// ════════════════════════════════════════════════════════════════════

test("[H10 characterization] limit: 0 / undefined / negative → no cap; limit: N → the first N discovered refs", async (t) => {
  const many = [1, 2, 3, 4, 5].map((i) =>
    fakeItem(venueRecord({ sourceKey: "osm", externalId: `v${i}`, countryCode: "HR", cityText: "Zagreb", name: `Klub ${i}` })),
  );
  const run = async (limit: number | undefined) => {
    const adapter = createInMemoryAdapter({ key: "osm", items: many });
    const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: seededStore(), now: NOW, runId: "r", limit });
    return plan.stats.discovered;
  };
  assert.equal(await run(undefined), 5);
  assert.equal(await run(0), 5);
  assert.equal(await run(-1), 5, "a negative limit behaves like 0 (no cap) — undefined input, not a bug");
  assert.equal(await run(2), 2);
  assert.equal(await run(99), 5);
});
