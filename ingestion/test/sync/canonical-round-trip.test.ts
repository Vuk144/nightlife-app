/**
 * Regression: the canonical comparable-field projection used for change
 * detection MUST equal what the stores persist and reconstruct — otherwise a
 * freshly-written record is detected as UPDATED on every subsequent run.
 *
 * Two gaps this locks down (both previously masked by `InMemoryCanonicalStore`
 * retaining the raw incoming value that Supabase normalises away):
 *
 *   1. a DATE-precision event (`startLocal` = "YYYY-MM-DD") — `comparable()`
 *      reduced it to UTC midnight, but `SupabaseCanonicalStore` writes
 *      `events.start_at` via `localToInstant`, which is LOCAL midnight.
 *   2. venue `openingTime` / `closingTime` — `comparable()` used the raw source
 *      string, but both stores persist (and reconstruct) `HH:MM` via
 *      `normalizeTimeOfDay`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../../src/sync/engine.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { comparable, venueComparable } from "../../src/sync/store.ts";
import { hashComparable } from "../../src/sync/canonical-hash.ts";
import { eventInstantForComparison, localToInstant } from "../../src/sync/time-zone.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { FakeSupabase } from "./fake-supabase.ts";
import { CITY_IDS, provider, fakeItem, venueRecord, eventRecord, seededStore } from "./world.ts";
import type { NormalizedRecord } from "../../src/sync/types.ts";

const NOW = "2026-06-01T00:00:00.000Z";
const cfg = () => provider();
const src = (k: string) => provider().source(k)!;

function seedGeography(fake: FakeSupabase): void {
  fake.seed("countries", [
    { id: "RS", name: "Serbia" },
    { id: "HR", name: "Croatia" },
  ]);
  fake.seed("cities", [
    { id: CITY_IDS.Belgrade, country_id: "RS", name: "Belgrade" },
    { id: CITY_IDS.Zagreb, country_id: "HR", name: "Zagreb" },
  ]);
}

function seedTvornica(fake: FakeSupabase): void {
  seedGeography(fake);
  fake.seed("venues", [
    {
      id: "v-zg",
      city_id: CITY_IDS.Zagreb,
      name: "Tvornica",
      name_normalized: "tvornica",
      is_active: true,
      source_id: null,
      external_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
}

const store = (fake: FakeSupabase) => new SupabaseCanonicalStore(fake.asClient(), { now: () => NOW });

// ════════════════════════════════════════════════════════════════════
//  1. DATE-precision event start instant
// ════════════════════════════════════════════════════════════════════

test("[unit] eventInstantForComparison mirrors the write path for a bare date + zone", () => {
  // the write path is localToInstant (local midnight); NOT toInstantMs (UTC midnight)
  assert.equal(
    eventInstantForComparison("2026-07-02", "Europe/Zagreb"),
    localToInstant("2026-07-02", "Europe/Zagreb"),
  );
  assert.equal(eventInstantForComparison("2026-07-02", "Europe/Zagreb"), "2026-07-01T22:00:00.000Z");
  // datetime + zone unchanged (parity with the pre-existing behaviour)
  assert.equal(
    eventInstantForComparison("2026-07-01T22:00", "Europe/Zagreb"),
    "2026-07-01T20:00:00.000Z",
  );
  // an already-absolute string is returned canonicalised, zone ignored
  assert.equal(
    eventInstantForComparison("2026-07-01T22:00:00.000Z", null),
    "2026-07-01T22:00:00.000Z",
  );
});

function dateEventRecord(over: Record<string, unknown> = {}): NormalizedRecord {
  const base = eventRecord({
    sourceKey: "entrio-hr",
    externalId: "E-DATE",
    countryCode: "HR",
    cityText: "Zagreb",
    title: "All-Dayer",
    startLocal: "2026-07-02", // <- DATE precision
    venueName: "Tvornica",
    sourceVenueId: null,
  });
  return { ...base, fields: { ...base.fields, ...over } } as NormalizedRecord;
}

test("[date-precision] incoming comparable startInstant equals the persisted events.start_at", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);

  const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [fakeItem(dateEventRecord())] });
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: s, now: NOW, runId: "r1" });
  const up = plan.upserts.find((u) => u.kind === "event")!;
  assert.equal(up.changeStatus, "NEW");

  await s.apply(plan, { commit: true });
  const persistedStartAt = String(fake.tables.events[0].start_at);

  // the value change detection hashed for THIS run must be what got persisted
  assert.equal(comparable(up.record).startInstant, persistedStartAt);
  assert.equal(persistedStartAt, "2026-07-01T22:00:00.000Z"); // Zagreb local midnight, not UTC
});

test("[date-precision] a date-only event re-syncs as UNCHANGED (no perpetual UPDATED loop)", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);

  const run = async (runId: string) => {
    const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [fakeItem(dateEventRecord())] });
    const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: s, now: NOW, runId });
    const res = await s.apply(plan, { commit: true });
    assert.equal(res.error, null, JSON.stringify(res.error));
    return plan.upserts.find((u) => u.kind === "event")!;
  };

  assert.equal((await run("r1")).changeStatus, "NEW");
  assert.equal((await run("r2")).changeStatus, "UNCHANGED", "identical date-only event must not loop UPDATED");
  assert.equal((await run("r3")).changeStatus, "UNCHANGED");
  assert.equal(fake.tables.events.length, 1);
});

test("[date-precision] a genuine date change is still UPDATED", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);

  const run = async (startLocal: string, runId: string) => {
    const adapter = createInMemoryAdapter({
      key: "entrio-hr",
      items: [fakeItem(dateEventRecord({ startLocal }))],
    });
    const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: s, now: NOW, runId });
    await s.apply(plan, { commit: true });
    return plan.upserts.find((u) => u.kind === "event")!;
  };

  await run("2026-07-02", "r1");
  const u = await run("2026-07-03", "r2");
  assert.equal(u.changeStatus, "UPDATED");
  assert.ok(u.fieldDeltas.some((d) => d.field === "startInstant"));
});

// ════════════════════════════════════════════════════════════════════
//  2. venue opening/closing time normalisation
// ════════════════════════════════════════════════════════════════════

function timeVenueRecord(over: Record<string, unknown>): NormalizedRecord {
  const base = venueRecord({
    sourceKey: "sync-test",
    externalId: "v-time",
    countryCode: "HR",
    cityText: "Zagreb",
    name: "Depo",
  });
  return { ...base, fields: { ...base.fields, ...over } } as NormalizedRecord;
}

for (const [raw, want] of [
  ["20:00:00", "20:00"],
  ["8:00", "08:00"],
] as const) {
  test(`[venue-time] openingTime "${raw}" round-trips as ${want} and re-syncs UNCHANGED (Supabase)`, async () => {
    const fake = new FakeSupabase();
    seedGeography(fake);
    const s = store(fake);

    const run = async (runId: string) => {
      const adapter = createInMemoryAdapter({
        key: "sync-test",
        items: [fakeItem(timeVenueRecord({ openingTime: raw, closingTime: raw }))],
      });
      const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId });
      const res = await s.apply(plan, { commit: true });
      assert.equal(res.error, null, JSON.stringify(res.error));
      return plan.upserts.find((u) => u.kind === "venue")!;
    };

    assert.equal((await run("r1")).changeStatus, "NEW");
    assert.equal((await run("r2")).changeStatus, "UNCHANGED", `"${raw}" must not loop UPDATED`);

    const back = (await s.getVenueBySource("sync-test", "v-time"))!;
    assert.equal(back.openingTime, want);
    assert.equal(back.closingTime, want);
  });
}

test("[venue-time] the incoming comparable uses the same HH:MM shape both stores persist", () => {
  const rec = timeVenueRecord({ openingTime: "20:00:00", closingTime: "3:30" });
  const c = comparable(rec);
  assert.equal(c.openingTime, "20:00");
  assert.equal(c.closingTime, "03:30");
});

test("[venue-time] InMemory store persists normalised times (parity with Supabase)", async () => {
  const store = seededStore();
  const run = async (runId: string) => {
    const adapter = createInMemoryAdapter({
      key: "osm",
      items: [
        fakeItem(
          venueRecord({
            sourceKey: "osm",
            externalId: "v-1",
            countryCode: "RS",
            cityText: "Belgrade",
            name: "Depo",
            openingTime: "20:00:00",
            closingTime: "6:00",
          }),
        ),
      ],
    });
    const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId });
    await store.apply(plan, { commit: true });
    return plan.upserts.find((u) => u.kind === "venue")!;
  };

  assert.equal((await run("r1")).changeStatus, "NEW");
  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.equal(row.openingTime, "20:00", "raw HH:MM:SS stored as HH:MM, like Supabase");
  assert.equal(row.closingTime, "06:00");

  assert.equal((await run("r2")).changeStatus, "UNCHANGED", "must not loop UPDATED via the in-memory store either");

  // the reconstructed link projection matches the persisted row
  const link = (await store.getSourceLink("venue", "osm", "v-1"))!;
  assert.equal(link.contentHash, hashComparable(venueComparable(row)));
});

// ════════════════════════════════════════════════════════════════════
//  3. InMemory store must not un-cancel (parity with SupabaseCanonicalStore)
// ════════════════════════════════════════════════════════════════════

test("[cancellation] InMemory store never un-cancels on a later non-cancel snapshot", async () => {
  const store = seededStore();
  const run = async (status: "scheduled" | "cancelled", runId: string) => {
    const adapter = createInMemoryAdapter({
      key: "entrio-hr",
      items: [
        fakeItem(
          eventRecord({
            sourceKey: "entrio-hr",
            externalId: "E1",
            countryCode: "HR",
            cityText: "Zagreb",
            title: "DJ Night",
            startLocal: "2026-07-01T22:00",
            venueName: "Tvornica",
            sourceVenueId: "tvornica",
            status,
          }),
        ),
      ],
    });
    const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId });
    await store.apply(plan, { commit: true });
    return plan.upserts.find((u) => u.kind === "event")!;
  };

  await run("scheduled", "r1");
  const id = store.events[0].id;

  const c = await run("cancelled", "r2");
  assert.equal(c.changeStatus, "UPDATED");
  assert.equal((await store.getEventById(id))!.status, "cancelled");

  // a later bare "scheduled" snapshot must NOT resurrect it
  await run("scheduled", "r3");
  assert.equal(
    (await store.getEventById(id))!.status,
    "cancelled",
    "a disappeared cancellation flag must never un-cancel a canonical event",
  );
});
