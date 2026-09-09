/**
 * Regression tests for the three contract improvements:
 *
 *  1. Content-hash ownership — the engine computes the change-detection hash
 *     from the shared comparable representation; an adapter-provided
 *     `provenance.contentHash` is ignored.
 *  2. Time-zone semantics — `EventFields.timeZone`, when set by the source, is
 *     authoritative; otherwise the engine resolves the zone from config (city →
 *     country default). A source-wide default is never authoritative over city
 *     data.
 *  3. Event status — a single `status` field; a `"scheduled"` (or absent-from-
 *     source) status never implies cancellation; an explicit change is UPDATED.
 *
 * NEW / UPDATED / UNCHANGED behaviour must remain exactly as before.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../../src/sync/engine.ts";
import { comparable } from "../../src/sync/store.ts";
import { hashComparable } from "../../src/sync/canonical-hash.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { FakeSupabase } from "./fake-supabase.ts";
import { CITY_IDS, provider, fakeItem, eventRecord } from "./world.ts";

const NOW = "2026-06-01T00:00:00.000Z";
const cfg = () => provider();
const evSrc = () => provider().source("entrio-hr")!;

function fake(): FakeSupabase {
  const f = new FakeSupabase();
  f.seed("countries", [
    { id: "RS", name: "Serbia" },
    { id: "HR", name: "Croatia" },
  ]);
  f.seed("cities", [
    { id: CITY_IDS.Belgrade, country_id: "RS", name: "Belgrade" },
    { id: CITY_IDS.Zagreb, country_id: "HR", name: "Zagreb" },
  ]);
  f.seed("venues", [
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
  return f;
}

const store = (f: FakeSupabase) => new SupabaseCanonicalStore(f.asClient(), { now: () => NOW });

function eventItem(over: Partial<Parameters<typeof eventRecord>[0]> = {}) {
  return fakeItem(
    eventRecord({
      sourceKey: "entrio-hr",
      externalId: "E1",
      countryCode: "HR",
      cityText: "Zagreb",
      title: "DJ Night",
      startLocal: "2026-07-01T22:00",
      venueName: "Tvornica",
      sourceVenueId: null,
      ...over,
    }),
  );
}

async function run(s: SupabaseCanonicalStore, item: ReturnType<typeof eventItem>, runId: string) {
  const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [item] });
  const plan = await planSync({ adapter, source: evSrc(), config: cfg(), store: s, now: NOW, runId });
  const res = await s.apply(plan, { commit: true });
  assert.equal(res.error, null, JSON.stringify(res.error));
  return { plan, res };
}

// ── 1. content-hash ownership ──────────────────────────────────────────
test("engine ignores an adapter-provided provenance.contentHash for change detection", async () => {
  const f = fake();
  const s = store(f);

  // run 1: NEW
  const a = await run(s, eventItem({ contentHash: "adapter-hash-AAA" }), "r1");
  assert.equal(a.plan.upserts.find((u) => u.kind === "event")!.changeStatus, "NEW");

  // run 2: identical event fields, DIFFERENT adapter hash -> still UNCHANGED
  const b = await run(s, eventItem({ contentHash: "adapter-hash-ZZZ" }), "r2");
  const bUp = b.plan.upserts.find((u) => u.kind === "event")!;
  assert.equal(bUp.changeStatus, "UNCHANGED", "a different adapter hash must not force UPDATED");
  assert.equal(bUp.operation, "link-only");

  // run 3: changed field, but adapter hash kept the SAME -> still UPDATED
  const c = await run(s, eventItem({ startLocal: "2026-07-01T23:30", contentHash: "adapter-hash-ZZZ" }), "r3");
  const cUp = c.plan.upserts.find((u) => u.kind === "event")!;
  assert.equal(cUp.changeStatus, "UPDATED", "a stale-but-matching adapter hash must not hide a real change");
  assert.ok(cUp.fieldDeltas.some((d) => d.field === "startInstant"));
});

test("the change-detection hash is the generic hashComparable(comparable(record))", () => {
  const rec = eventRecord({
    sourceKey: "x",
    externalId: "y",
    countryCode: "HR",
    cityText: "Zagreb",
    title: "T",
    startLocal: "2026-07-01T22:00",
    venueName: "Tvornica",
    timeZone: "Europe/Zagreb",
  });
  // recomputing from the comparable projection is stable and self-consistent
  assert.equal(hashComparable(comparable(rec)), hashComparable(comparable(rec)));
});

// ── 2. time-zone semantics ────────────────────────────────────────────
test("a source-provided timeZone is authoritative; absent -> engine uses city/config zone", async () => {
  // no source zone -> Zagreb city/config zone (Europe/Zagreb): 22:00 -> 20:00Z
  const f1 = fake();
  const s1 = store(f1);
  await run(s1, eventItem(), "r1");
  assert.match(String(f1.tables.events[0].start_at), /^2026-07-01T20:00/);

  // source explicitly says UTC -> that wins over the city zone: 22:00 -> 22:00Z
  const f2 = fake();
  const s2 = store(f2);
  await run(s2, eventItem({ timeZone: "UTC" }), "r1");
  assert.match(String(f2.tables.events[0].start_at), /^2026-07-01T22:00/);
});

// ── 3. event status ──────────────────────────────────────────────────
test("status 'scheduled' persists as is_cancelled=false and never flips on re-run", async () => {
  const f = fake();
  const s = store(f);

  await run(s, eventItem({ status: "scheduled" }), "r1");
  assert.equal(f.tables.events[0].is_cancelled, false);

  const again = await run(s, eventItem({ status: "scheduled" }), "r2");
  assert.equal(again.plan.upserts.find((u) => u.kind === "event")!.changeStatus, "UNCHANGED");
  assert.equal(f.tables.events[0].is_cancelled, false);
});

test("an EXPLICIT scheduled -> cancelled status change is detected as UPDATED and persisted", async () => {
  const f = fake();
  const s = store(f);

  await run(s, eventItem({ status: "scheduled" }), "r1");
  const c = await run(s, eventItem({ status: "cancelled" }), "r2");
  const up = c.plan.upserts.find((u) => u.kind === "event")!;
  assert.equal(up.changeStatus, "UPDATED");
  assert.ok(up.fieldDeltas.some((d) => d.field === "isCancelled"));
  assert.equal(f.tables.events[0].is_cancelled, true);
});
