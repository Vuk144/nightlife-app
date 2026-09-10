/**
 * SupabaseCanonicalStore — persistence-layer unit tests.
 *
 * Runs the REAL store against a deterministic in-memory fake of the PostgREST
 * query builder (`FakeSupabase`). No network, no real database. A real-DB
 * read-after-write proof lives in `integration/supabase-store.integration.test.ts`
 * (opt-in via SYNC_INTEGRATION=1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../../src/sync/engine.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { eventComparable, venueComparable } from "../../src/sync/store.ts";
import { hashComparable } from "../../src/sync/canonical-hash.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { FakeSupabase } from "./fake-supabase.ts";
import { CITY_IDS, provider, fakeItem, venueRecord, eventRecord } from "./world.ts";
import type { CanonicalUpsert, NormalizedRecord, SyncPlan } from "../../src/sync/types.ts";

const NOW = "2026-06-01T00:00:00.000Z";
const cfg = () => provider();
const src = (k: string) => provider().source(k)!;

/** Seed the fake with the same geography the test config declares. */
function seedGeography(fake: FakeSupabase): void {
  fake.seed("countries", [
    { id: "RS", name: "Serbia" },
    { id: "HR", name: "Croatia" },
    { id: "HU", name: "Hungary" },
    { id: "DE", name: "Germany" },
  ]);
  fake.seed("cities", [
    { id: CITY_IDS.Belgrade, country_id: "RS", name: "Belgrade" },
    { id: CITY_IDS.Zagreb, country_id: "HR", name: "Zagreb" },
    { id: CITY_IDS.Split, country_id: "HR", name: "Split" },
    { id: CITY_IDS.Budapest, country_id: "HU", name: "Budapest" },
    { id: CITY_IDS.Berlin, country_id: "DE", name: "Berlin" },
  ]);
}

function store(fake: FakeSupabase): SupabaseCanonicalStore {
  return new SupabaseCanonicalStore(fake.asClient(), { now: () => NOW });
}

type VenueInput = Parameters<typeof venueRecord>[0];
function venueItems(over: Omit<VenueInput, "countryCode" | "cityText"> & Partial<VenueInput>) {
  return [fakeItem(venueRecord({ countryCode: "HR", cityText: "Zagreb", ...over }))];
}

// ── 1. read country / city ──────────────────────────────────────────
test("[1] reads countries/cities for scope resolution", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const hr = await s.listCities("HR");
  assert.deepEqual(
    hr.map((c) => c.name).sort(),
    ["Split", "Zagreb"],
  );
  assert.equal((await s.listCities()).length, 5);
});

// ── 2 & 3. read venue / find by source+external ─────────────────────
test("[2][3] reads an existing venue and finds it by source + external id", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  fake.seed("data_sources", [{ id: "ds-osm", name: "osm", type: "api" }]);
  fake.seed("venues", [
    {
      id: "v-1",
      city_id: CITY_IDS.Zagreb,
      name: "Tvornica",
      name_normalized: "tvornica",
      is_active: true,
      source_id: "ds-osm",
      external_id: "osm/42",
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
  const s = store(fake);
  const inCity = await s.listVenuesInCity(CITY_IDS.Zagreb);
  assert.equal(inCity.length, 1);
  assert.equal(inCity[0].cityName, "Zagreb");
  assert.equal(inCity[0].countryCode, "HR");

  const bySource = await s.getVenueBySource("osm", "osm/42");
  assert.equal(bySource?.id, "v-1");
  assert.equal(await s.getVenueBySource("osm", "nope"), null);
});

// ── 4 & 5. insert a controlled venue, read it back ──────────────────
test("[4][5] inserts a NEW venue and reads it back with the intended fields", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: venueItems({
      sourceKey: "sync-test",
      externalId: "venue-001",
      name: "Example Club",
      closingTime: "03:00",
    }),
  });

  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  assert.equal(plan.upserts[0].operation, "insert");

  const res = await s.apply(plan, { commit: true });
  assert.equal(res.error, null);
  assert.equal(res.committed, true);
  assert.equal(res.inserted, 1);

  const back = await s.getVenueBySource("sync-test", "venue-001");
  assert.equal(back?.name, "Example Club");
  assert.equal(back?.closingTime, "03:00");
  assert.equal(back?.cityId, CITY_IDS.Zagreb);
  assert.equal(back?.isActive, true);
  // a data_sources row was auto-created for the new source key
  assert.ok(fake.tables.data_sources.some((d) => d.name === "sync-test"));
});

// ── 6 & 7 & 8. the persistence loop: NEW -> UPDATED -> UNCHANGED ─────
test("[6][7][8] NEW -> UPDATED (closing time delta) -> UNCHANGED, verified by read-after-write", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);

  const run = async (closingTime: string, runId: string) => {
    const adapter = createInMemoryAdapter({
      key: "sync-test",
      items: venueItems({ sourceKey: "sync-test", externalId: "venue-001", name: "Example Club", closingTime }),
    });
    const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId });
    const res = await s.apply(plan, { commit: true });
    assert.equal(res.error, null);
    return { plan, res };
  };

  // NEW
  const a = await run("03:00", "r1");
  assert.equal(a.plan.upserts[0].changeStatus, "NEW");
  assert.equal((await s.getVenueBySource("sync-test", "venue-001"))!.closingTime, "03:00");

  // UPDATED — closing time 03:00 -> 04:00, with a field-level delta
  const b = await run("04:00", "r2");
  assert.equal(b.plan.upserts[0].changeStatus, "UPDATED");
  assert.deepEqual(
    b.plan.upserts[0].fieldDeltas,
    [{ field: "closingTime", from: "03:00", to: "04:00" }],
  );
  assert.equal(b.res.updated, 1);
  const afterUpdate = await s.getVenueBySource("sync-test", "venue-001");
  assert.equal(afterUpdate!.closingTime, "04:00");
  assert.equal(afterUpdate!.name, "Example Club"); // unrelated field preserved

  // UNCHANGED — same data again: no canonical content mutation
  fake.writes.length = 0;
  const c = await run("04:00", "r3");
  assert.equal(c.plan.upserts[0].changeStatus, "UNCHANGED");
  assert.equal(c.res.updated, 0);
  const contentWrites = fake.writes.filter(
    (w) => w.op === "update" && Object.keys(w.values).some((k) => k !== "last_synced_at"),
  );
  assert.deepEqual(contentWrites, [], "UNCHANGED must not mutate any canonical content field");
  assert.equal((await s.getVenueBySource("sync-test", "venue-001"))!.closingTime, "04:00");
});

// ── 9. idempotency: repeated apply, no duplicate ───────────────────
test("[9] applying the same plan repeatedly never creates a duplicate venue", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: venueItems({ sourceKey: "sync-test", externalId: "venue-001", name: "Example Club" }),
  });

  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  await s.apply(plan, { commit: true });
  await s.apply(plan, { commit: true }); // exact same plan again
  await s.apply(plan, { commit: true });

  assert.equal(fake.tables.venues.length, 1);
  const back = await s.getVenueBySource("sync-test", "venue-001");
  assert.equal(back?.name, "Example Club");
});

// ── 10 & 11. event insert + idempotency ──────────────────────────
test("[10][11] inserts an event against a resolved venue, and is idempotent", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  fake.seed("data_sources", [{ id: "ds-t", name: "sync-test", type: "api" }]);
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
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "sync-test",
          externalId: "evt-001",
          countryCode: "HR",
          cityText: "Zagreb",
          title: "DJ Night",
          startLocal: "2026-07-01T22:00",
          venueName: "Tvornica",
          sourceVenueId: null,
        }),
      ),
    ],
  });

  const p1 = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: s, now: NOW, runId: "r1" });
  const r1 = await s.apply(p1, { commit: true });
  assert.equal(r1.error, null);
  assert.equal(fake.tables.events.length, 1);
  const back = await s.getEventBySource("sync-test", "evt-001");
  assert.equal(back?.title, "DJ Night");
  assert.match(String(fake.tables.events[0].start_at), /^2026-07-01T20:00/); // Zagreb 22:00 -> 20:00Z

  const p2 = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: s, now: NOW, runId: "r2" });
  await s.apply(p2, { commit: true });
  assert.equal(fake.tables.events.length, 1, "no duplicate event");
});

// ── 12. no hard delete ─────────────────────────────────────────
test("[12] the store issues no delete under any operation", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: venueItems({ sourceKey: "sync-test", externalId: "venue-001", name: "Example Club" }),
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  await s.apply(plan, { commit: true });
  assert.ok(!fake.writes.some((w) => (w.op as string) === "delete"));
  // FakeBuilder has no delete() method at all — a delete is structurally impossible
  assert.equal(typeof (fake.from("venues") as unknown as { delete?: unknown }).delete, "undefined");
});

// ── 13. unresolved event-first venue is NOT faked ─────────────────
test("[13] an event whose venue is unresolved is NOT inserted as a fake canonical venue", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "sync-test",
          externalId: "evt-x",
          countryCode: "HR",
          cityText: "Split", // Split: NOT event-first enabled in world config
          title: "Rave",
          startLocal: "2026-07-01T23:00",
          venueName: "Totally New Warehouse",
          sourceVenueId: "warehouse-x",
        }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store: s, now: NOW, runId: "r1" });
  const res = await s.apply(plan, { commit: true });

  assert.equal(fake.tables.venues.length, 0, "no fake venue created");
  assert.equal(fake.tables.events.length, 0, "no orphan event");
  assert.ok(res.deferred.some((d) => /event_ingest_staging|event-first unresolved/.test(d)));
});

// ── 14. source failure -> no destructive reconciliation ──────────
test("[14] a failed source run persists nothing and reconciles nothing", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  fake.seed("data_sources", [{ id: "ds-t", name: "sync-test", type: "api" }]);
  fake.seed("venues", [
    {
      id: "v-old",
      city_id: CITY_IDS.Zagreb,
      name: "Old Venue",
      name_normalized: "old venue",
      is_active: true,
      source_id: "ds-t",
      external_id: "gone-1",
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
  const s = store(fake);
  const adapter = createInMemoryAdapter({ key: "sync-test", items: [], failDiscovery: true });

  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  assert.equal(plan.stats.status, "failed");
  assert.equal(plan.reconciliation.reconciled, false);

  fake.writes.length = 0;
  const res = await s.apply(plan, { commit: true });
  assert.deepEqual(fake.writes, [], "no writes at all on a failed run");
  assert.ok(res.notes.some((n) => /reconciliation skipped/.test(n)));
  // the disappeared venue is untouched — not deleted, not deactivated
  assert.equal(fake.tables.venues[0].is_active, true);
  assert.equal(fake.tables.venues.length, 1);
});

// ── 15. errors are surfaced with context, apply halts loudly ─────
test("[15] a Supabase error halts apply and is returned with full context", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: venueItems({ sourceKey: "sync-test", externalId: "venue-001", name: "Example Club" }),
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });

  fake.failNext("venues", "insert", { message: "duplicate key value violates unique constraint", code: "23505" });
  const res = await s.apply(plan, { commit: true });

  assert.equal(res.committed, false);
  assert.ok(res.error);
  assert.equal(res.error!.operation, "insert");
  assert.equal(res.error!.kind, "venue");
  assert.equal(res.error!.sourceKey, "sync-test");
  assert.equal(res.error!.externalId, "venue-001");
  assert.equal(res.error!.supabaseOp, "venues.insert");
  assert.equal(res.error!.code, "23505");
  assert.ok(res.notes.some((n) => /halted on first failure/.test(n)));
  assert.equal(fake.tables.venues.length, 0);
});

// ── stability across repeated apply ─────────────────────────────
test("apply(plan); apply(plan) leaves the canonical row count and identity stable", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: venueItems({ sourceKey: "sync-test", externalId: "venue-001", name: "Example Club", closingTime: "02:00" }),
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  await s.apply(plan, { commit: true });
  const id1 = (await s.getVenueBySource("sync-test", "venue-001"))!.id;
  await s.apply(plan, { commit: true });
  const id2 = (await s.getVenueBySource("sync-test", "venue-001"))!.id;
  assert.equal(id1, id2);
  assert.equal(fake.tables.venues.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
//  HARDENING REGRESSIONS (see the STEP-3 store hardening report)
//  Every assertion below reads the PERSISTED fake row (`fake.tables.*`) or
//  a fresh store read — never a write-time cache.
// ═══════════════════════════════════════════════════════════════════════

const evSrc = (k: string) => provider().source(k)!;

function withProvenance(rec: NormalizedRecord, over: { sourceUrl?: string | null }): NormalizedRecord {
  return { ...rec, provenance: { ...rec.provenance, ...over } };
}

function eventItem(over: Partial<Parameters<typeof eventRecord>[0]> & { sourceUrl?: string | null } = {}) {
  const { sourceUrl, ...evOver } = over;
  let rec = eventRecord({
    sourceKey: "entrio-hr",
    externalId: "E1",
    countryCode: "HR",
    cityText: "Zagreb",
    title: "DJ Night",
    startLocal: "2026-07-01T22:00",
    venueName: "Tvornica",
    sourceVenueId: null,
    ...evOver,
  });
  if (sourceUrl !== undefined) rec = withProvenance(rec, { sourceUrl });
  return fakeItem(rec);
}

function seedTvornica(fake: FakeSupabase, extra: Record<string, unknown> = {}): void {
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
      ...extra,
    },
  ]);
}

async function runEvent(s: SupabaseCanonicalStore, item: ReturnType<typeof eventItem>, runId: string) {
  const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [item] });
  const plan = await planSync({ adapter, source: evSrc("entrio-hr"), config: cfg(), store: s, now: NOW, runId });
  const res = await s.apply(plan, { commit: true });
  assert.equal(res.error, null, JSON.stringify(res.error));
  return { plan, res, up: plan.upserts.find((u) => u.kind === "event")! };
}

async function runVenue(
  s: SupabaseCanonicalStore,
  over: Omit<VenueInput, "countryCode" | "cityText"> & Partial<VenueInput> & { sourceUrl?: string | null },
  runId: string,
) {
  const { sourceUrl, ...vOver } = over;
  let rec = venueRecord({ countryCode: "HR", cityText: "Zagreb", ...vOver });
  if (sourceUrl !== undefined) rec = withProvenance(rec, { sourceUrl });
  const adapter = createInMemoryAdapter({ key: "sync-test", items: [fakeItem(rec)] });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId });
  const res = await s.apply(plan, { commit: true });
  assert.equal(res.error, null, JSON.stringify(res.error));
  return { plan, res, up: plan.upserts.find((u) => u.kind === "venue")! };
}

// ── 1. EVENT OWNERSHIP ───────────────────────────────────────────────

test("[ownership] source B cannot silently overwrite a canonical event owned by source A on UPDATE", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  fake.seed("data_sources", [
    { id: "ds-a", name: "src-a", type: "api" },
    { id: "ds-b", name: "src-b", type: "api" },
  ]);
  fake.seed("events", [
    {
      id: "ev-a",
      venue_id: "v-zg",
      title: "Original — owned by A",
      description: "A's copy",
      start_at: "2026-07-01T20:00:00.000Z",
      end_at: null,
      cover_image_url: "https://a.example/cover.jpg",
      ticket_url: "https://a.example/t",
      is_cancelled: false,
      source_id: "ds-a",
      external_id: "a-1",
      source_url: "https://a.example/a-1",
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
  const s = store(fake);

  // A hand-built plan: source B claims a tier-2 identity match onto A's event
  // and asks for an UPDATE. (The engine cannot currently emit this, but the
  // store must still refuse it — parity with the venue ownership guard.)
  const up: CanonicalUpsert = {
    kind: "event",
    operation: "update",
    changeStatus: "UPDATED",
    canonicalId: "ev-a",
    fieldDeltas: [],
    record: {
      kind: "event",
      provenance: {
        sourceKey: "src-b",
        externalId: "b-1",
        sourceUrl: "https://b.example/b-1",
        confidence: 0.9,
        fetchedAt: NOW,
        reported: {},
      },
      scope: { countryCode: "HR", cityText: "Zagreb", coordinates: null },
      fields: {
        title: "HIJACKED BY B",
        description: "B's copy",
        startLocal: "2026-07-01T22:00",
        endLocal: null,
        doorsLocal: null,
        timeZone: "Europe/Zagreb",
        startPrecision: "datetime",
        status: "cancelled",
        promoter: null,
        ticketUrl: "https://b.example/t",
        coverImageUrl: "https://b.example/cover.jpg",
        lineup: [],
      },
      links: { venue: { name: "Tvornica", sourceVenueId: null, address: null, coordinates: null, cityText: "Zagreb" } },
    },
    identity: { entity: "event", decision: "matched", tier: 2, canonicalId: "ev-a", reasonCode: "event-tier-2", note: "" },
    resolvedVenueId: "v-zg",
  };
  const plan = {
    run: { runId: "r1", sourceKey: "src-b", startedAt: NOW, mode: "apply", scope: { countries: [], cities: [] } },
    upserts: [up],
    reconciliation: { reconciled: false, runStatus: "ok", actions: [], skippedReason: "n/a" },
    reviewItems: [],
    stats: {},
  } as unknown as SyncPlan;

  const res = await s.apply(plan, { commit: true });

  assert.equal(res.error, null);
  assert.equal(res.updated, 0, "no update applied");
  assert.ok(
    res.deferred.some((d) => /owned by "src-a"/.test(d) && /event_sources/.test(d)),
    `expected an ownership-deferral note, got: ${JSON.stringify(res.deferred)}`,
  );

  const row = fake.tables.events[0];
  assert.equal(row.title, "Original — owned by A", "A's title untouched");
  assert.equal(row.description, "A's copy");
  assert.equal(row.is_cancelled, false, "B must not cancel A's event");
  assert.equal(row.source_id, "ds-a", "ownership unchanged");
  assert.equal(row.source_url, "https://a.example/a-1");
});

test("[ownership] a same-source event UPDATE is still allowed (single-source behavior preserved)", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  await runEvent(s, eventItem({ ticketUrl: "https://t.example/1" }), "r1");
  const { up } = await runEvent(s, eventItem({ title: "DJ Night — Extended", ticketUrl: "https://t.example/2" }), "r2");
  assert.equal(up.changeStatus, "UPDATED");
  assert.equal(up.operation, "update");
  const row = fake.tables.events[0];
  assert.equal(row.title, "DJ Night — Extended");
  assert.equal(row.ticket_url, "https://t.example/2");
});

test("[ownership] a tier-2 cross-source match near the local-midnight boundary creates NO duplicate event", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  const ticket = "https://tickets.example/event/778899";

  // Source A: event at 01:00 local (Zagreb) on Jul 2 -> start_at is 23:00Z on Jul 1
  const a = createInMemoryAdapter({
    key: "entrio-hr",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "entrio-hr",
          externalId: "A-1",
          countryCode: "HR",
          cityText: "Zagreb",
          title: "After Hours",
          startLocal: "2026-07-02T01:00",
          venueName: "Tvornica",
          sourceVenueId: null,
          ticketUrl: ticket,
        }),
      ),
    ],
  });
  const pa = await planSync({ adapter: a, source: evSrc("entrio-hr"), config: cfg(), store: s, now: NOW, runId: "r1" });
  await s.apply(pa, { commit: true });
  assert.equal(fake.tables.events.length, 1);
  assert.match(String(fake.tables.events[0].start_at), /^2026-07-01T23:00/, "instant lands in the previous UTC day");

  // Source B: the SAME real event (shared ticket id), same local date
  const b = createInMemoryAdapter({
    key: "cooltix",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "cooltix",
          externalId: "B-9",
          countryCode: "HR",
          cityText: "Zagreb",
          title: "After Hours @ Tvornica",
          startLocal: "2026-07-02T01:00",
          venueName: "Tvornica",
          sourceVenueId: null,
          ticketUrl: ticket,
        }),
      ),
    ],
  });
  const pb = await planSync({ adapter: b, source: evSrc("cooltix"), config: cfg(), store: s, now: NOW, runId: "r2" });
  const eb = pb.upserts.find((u) => u.kind === "event")!;
  assert.equal(eb.identity.decision, "matched", "tier-2 match must survive the UTC-day boundary");
  assert.equal(eb.identity.tier, 2);
  assert.equal(eb.operation, "link-only");

  const rb = await s.apply(pb, { commit: true });
  assert.equal(fake.tables.events.length, 1, "no duplicate canonical event across the local-midnight boundary");
  assert.ok(rb.deferred.some((d) => /second source "cooltix"/.test(d)));
});

// ── 2. PROVENANCE URL ────────────────────────────────────────────────

test("[provenance] a same-source venue re-sync refreshes source_url when it changed", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  await runVenue(s, { sourceKey: "sync-test", externalId: "v-1", name: "Depo", closingTime: "03:00", sourceUrl: "https://old.example/v" }, "r1");
  assert.equal((await s.getVenueBySource("sync-test", "v-1"))!.sourceUrl, "https://old.example/v");

  await runVenue(s, { sourceKey: "sync-test", externalId: "v-1", name: "Depo", closingTime: "04:00", sourceUrl: "https://new.example/v" }, "r2");
  const row = await s.getVenueBySource("sync-test", "v-1");
  assert.equal(row!.sourceUrl, "https://new.example/v", "provenance URL followed the source");
  assert.equal(row!.closingTime, "04:00");
});

test("[provenance] an omitted (null) venue source_url never clears the existing one", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  await runVenue(s, { sourceKey: "sync-test", externalId: "v-1", name: "Depo", website: "https://a.example", sourceUrl: "https://keep.example/v" }, "r1");
  await runVenue(s, { sourceKey: "sync-test", externalId: "v-1", name: "Depo", website: "https://b.example", sourceUrl: null }, "r2");
  const row = await s.getVenueBySource("sync-test", "v-1");
  assert.equal(row!.website, "https://b.example", "content change applied");
  assert.equal(row!.sourceUrl, "https://keep.example/v", "null source_url did not erase the URL");
});

test("[provenance] a same-source event re-sync refreshes source_url; a null one never clears it", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  await runEvent(s, eventItem({ title: "DJ Night", sourceUrl: "https://old.example/e" }), "r1");
  assert.equal(fake.tables.events[0].source_url, "https://old.example/e");

  await runEvent(s, eventItem({ title: "DJ Night 2", sourceUrl: "https://new.example/e" }), "r2");
  assert.equal(fake.tables.events[0].source_url, "https://new.example/e", "event provenance URL followed the source");

  await runEvent(s, eventItem({ title: "DJ Night 3", sourceUrl: null }), "r3");
  assert.equal(fake.tables.events[0].source_url, "https://new.example/e", "null source_url did not erase the URL");
  assert.equal(fake.tables.events[0].title, "DJ Night 3");
});

test("[provenance] an UNCHANGED re-sync with an unchanged source_url writes no source_url", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  await runVenue(s, { sourceKey: "sync-test", externalId: "v-1", name: "Depo", sourceUrl: "https://x.example/v" }, "r1");

  fake.writes.length = 0;
  const { up } = await runVenue(s, { sourceKey: "sync-test", externalId: "v-1", name: "Depo", sourceUrl: "https://x.example/v" }, "r2");
  assert.equal(up.changeStatus, "UNCHANGED");
  const contentish = fake.writes.filter(
    (w) => w.op === "update" && Object.keys(w.values).some((k) => k !== "last_synced_at"),
  );
  assert.deepEqual(contentish, [], "an unchanged re-sync must only touch last_synced_at");
});

// ── 3. EVENT TIMEZONE LIMITATION ─────────────────────────────────────

function underEachProcessTz(fn: (tz: string) => Promise<void>): Promise<void> {
  const saved = process.env.TZ;
  return (async () => {
    try {
      for (const tz of ["UTC", "Asia/Tokyo", "America/New_York", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        await fn(tz);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  })();
}

test("[timezone] a persisted event reads back timeZone=null and a process-TZ-independent instant", async () => {
  await underEachProcessTz(async (tz) => {
    const fake = new FakeSupabase();
    seedTvornica(fake);
    const s = store(fake);
    await runEvent(s, eventItem({ startLocal: "2026-07-01T22:00" }), "r1"); // Zagreb summer = UTC+2

    const back = (await s.getEventBySource("entrio-hr", "E1"))!;
    assert.equal(back.timeZone, null, `TZ=${tz}: the current schema cannot reconstruct the zone`);
    assert.match(back.startLocal, /^2026-07-01T20:00:00/, `TZ=${tz}: 22:00 Zagreb -> 20:00Z, deterministic`);
    assert.match(String(fake.tables.events[0].start_at), /^2026-07-01T20:00:00/, `TZ=${tz}`);
  });
});

test("[timezone] change detection after persistence uses the instant; identical re-sync is UNCHANGED under any TZ", async () => {
  await underEachProcessTz(async (tz) => {
    const fake = new FakeSupabase();
    seedTvornica(fake);
    const s = store(fake);
    await runEvent(s, eventItem({ startLocal: "2026-07-01T22:00" }), "r1");
    const { up } = await runEvent(s, eventItem({ startLocal: "2026-07-01T22:00" }), "r2");
    assert.equal(up.changeStatus, "UNCHANGED", `TZ=${tz}`);
    assert.equal(up.operation, "link-only", `TZ=${tz}`);
  });
});

// ── 4. LOCAL-DATE METHOD BEHAVIOR ────────────────────────────────────

test("[local-date] findEventsAtVenueOnDate spans the ±1 UTC-day window (adjacent-day instant is a candidate)", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  fake.seed("data_sources", [{ id: "ds-x", name: "x", type: "api" }]);
  fake.seed("events", [
    // local 2026-07-02 01:00 Zagreb == 2026-07-01T23:00Z  -> previous UTC day
    { id: "e-prev", venue_id: "v-zg", title: "prev-utc-day", start_at: "2026-07-01T23:00:00.000Z", is_cancelled: false, source_id: "ds-x", external_id: "e-prev", created_at: NOW, updated_at: NOW },
    // squarely inside the target UTC day
    { id: "e-mid", venue_id: "v-zg", title: "mid", start_at: "2026-07-02T18:00:00.000Z", is_cancelled: false, source_id: "ds-x", external_id: "e-mid", created_at: NOW, updated_at: NOW },
    // local 2026-07-02 23:30 in America/New_York == 2026-07-03T03:30Z -> next UTC day
    { id: "e-next", venue_id: "v-zg", title: "next-utc-day", start_at: "2026-07-03T03:30:00.000Z", is_cancelled: false, source_id: "ds-x", external_id: "e-next", created_at: NOW, updated_at: NOW },
    // genuinely a week away -> must NOT be a candidate
    { id: "e-far", venue_id: "v-zg", title: "far", start_at: "2026-07-09T18:00:00.000Z", is_cancelled: false, source_id: "ds-x", external_id: "e-far", created_at: NOW, updated_at: NOW },
  ]);
  const s = store(fake);

  const got = (await s.findEventsAtVenueOnDate("v-zg", "2026-07-02")).map((e) => e.id).sort();
  assert.deepEqual(got, ["e-mid", "e-next", "e-prev"], "±1 UTC-day window, nothing a week out");
});

// ── 5. ALL COMPARABLE FIELDS PERSIST (Supabase) ──────────────────────

const VENUE_FIELD_CASES: { field: string; a: Record<string, unknown>; b: Record<string, unknown>; read: (v: any) => unknown; want: unknown }[] = [
  { field: "name", a: { name: "Depo" }, b: { name: "Depo Magacin" }, read: (v) => v.name, want: "Depo Magacin" },
  { field: "address", a: { address: "Old 1" }, b: { address: "New 9" }, read: (v) => v.address, want: "New 9" },
  { field: "website", a: { website: "https://a.example" }, b: { website: "https://b.example" }, read: (v) => v.website, want: "https://b.example" },
  { field: "wikidata", a: { wikidata: "Q1" }, b: { wikidata: "Q2" }, read: (v) => v.wikidata, want: "Q2" },
  { field: "openingHours", a: { openingHours: "Mo-Fr 09:00-17:00" }, b: { openingHours: "Mo-Su 10:00-23:00" }, read: (v) => v.openingHours, want: "Mo-Su 10:00-23:00" },
  { field: "description", a: { description: "old" }, b: { description: "new" }, read: (v) => v.description, want: "new" },
  { field: "openingTime", a: { openingTime: "20:00" }, b: { openingTime: "22:00" }, read: (v) => v.openingTime, want: "22:00" },
  { field: "closingTime", a: { closingTime: "04:00" }, b: { closingTime: "06:00" }, read: (v) => v.closingTime, want: "06:00" },
  { field: "isActive", a: { isActive: true }, b: { isActive: false }, read: (v) => v.isActive, want: false },
  {
    // Zagreb-area coordinates — must stay inside CROATIA_BOUNDS or validation
    // rejects the record before any upsert is produced.
    field: "coordinates",
    a: { coordinates: { latitude: 45.807, longitude: 15.966 } },
    b: { coordinates: { latitude: 45.81, longitude: 15.97 } },
    read: (v) => v.coordinates,
    want: { latitude: 45.81, longitude: 15.97 },
  },
];

function venueFieldRecord(over: Record<string, unknown>): NormalizedRecord {
  const base = venueRecord({ sourceKey: "sync-test", externalId: "v-1", countryCode: "HR", cityText: "Zagreb", name: "Depo" });
  return { ...base, fields: { ...base.fields, ...over } } as NormalizedRecord;
}

for (const c of VENUE_FIELD_CASES) {
  test(`[fields:venue] "${c.field}" persists on UPDATE and re-plans UNCHANGED (Supabase)`, async () => {
    const fake = new FakeSupabase();
    seedGeography(fake);
    const s = store(fake);
    const run = async (over: Record<string, unknown>, runId: string) => {
      const adapter = createInMemoryAdapter({ key: "sync-test", items: [fakeItem(venueFieldRecord({ name: "Depo", ...over }))] });
      const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId });
      const res = await s.apply(plan, { commit: true });
      assert.equal(res.error, null, JSON.stringify(res.error));
      return plan.upserts.find((u) => u.kind === "venue")!;
    };
    await run(c.a, "r1");
    const u = await run(c.b, "r2");
    assert.equal(u.changeStatus, "UPDATED", `${c.field}`);
    const row = (await s.getVenueBySource("sync-test", "v-1"))!;
    assert.deepEqual(c.read(row), c.want);
    const again = await run(c.b, "r3");
    assert.equal(again.changeStatus, "UNCHANGED", `${c.field}: identical data must not loop`);
  });
}

const EVENT_FIELD_CASES: { field: string; a: Record<string, unknown>; b: Record<string, unknown>; read: (e: any) => unknown; want: unknown }[] = [
  { field: "title", a: { title: "DJ Night" }, b: { title: "DJ Night 2" }, read: (e) => e.title, want: "DJ Night 2" },
  { field: "description", a: { description: "old" }, b: { description: "new" }, read: (e) => e.description, want: "new" },
  { field: "startInstant", a: { startLocal: "2026-07-01T22:00" }, b: { startLocal: "2026-07-01T23:30" }, read: (e) => e.startLocal, want: "2026-07-01T21:30:00.000Z" },
  { field: "endInstant", a: { endLocal: "2026-07-02T02:00" }, b: { endLocal: "2026-07-02T05:00" }, read: (e) => e.endLocal, want: "2026-07-02T03:00:00.000Z" },
  { field: "ticketUrl", a: { ticketUrl: "https://t.example/1" }, b: { ticketUrl: "https://t.example/2" }, read: (e) => e.ticketUrl, want: "https://t.example/2" },
  { field: "coverImageUrl", a: { coverImageUrl: "https://i.example/a.jpg" }, b: { coverImageUrl: "https://i.example/b.jpg" }, read: (e) => e.coverImageUrl, want: "https://i.example/b.jpg" },
  { field: "cancellation", a: { status: "scheduled" }, b: { status: "cancelled" }, read: (e) => e.status, want: "cancelled" },
];

function eventFieldRecord(over: Record<string, unknown>): NormalizedRecord {
  const base = eventRecord({
    sourceKey: "entrio-hr", externalId: "E1", countryCode: "HR", cityText: "Zagreb",
    title: "DJ Night", startLocal: "2026-07-01T22:00", venueName: "Tvornica", sourceVenueId: null,
  });
  return { ...base, fields: { ...base.fields, ...over } } as NormalizedRecord;
}

for (const c of EVENT_FIELD_CASES) {
  test(`[fields:event] "${c.field}" persists on UPDATE and re-plans UNCHANGED (Supabase)`, async () => {
    const fake = new FakeSupabase();
    seedTvornica(fake);
    const s = store(fake);
    const run = async (over: Record<string, unknown>, runId: string) => {
      const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [fakeItem(eventFieldRecord(over))] });
      const plan = await planSync({ adapter, source: evSrc("entrio-hr"), config: cfg(), store: s, now: NOW, runId });
      const res = await s.apply(plan, { commit: true });
      assert.equal(res.error, null, JSON.stringify(res.error));
      return plan.upserts.find((u) => u.kind === "event")!;
    };
    await run(c.a, "r1");
    const u = await run(c.b, "r2");
    assert.equal(u.changeStatus, "UPDATED", `${c.field}`);
    const row = (await s.getEventBySource("entrio-hr", "E1"))!;
    assert.deepEqual(c.read(row), c.want);
    const again = await run(c.b, "r3");
    assert.equal(again.changeStatus, "UNCHANGED", `${c.field}: identical data must not loop`);
  });
}

test("[fields:venue] MANUAL coordinates are never overwritten by a source (Supabase)", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  fake.seed("data_sources", [{ id: "ds-t", name: "sync-test", type: "api" }]);
  fake.seed("venues", [
    {
      id: "v-pin",
      city_id: CITY_IDS.Zagreb,
      name: "Depo",
      name_normalized: "depo",
      is_active: true,
      latitude: 45.79001,
      longitude: 15.95002,
      coordinates_source: "manual",
      source_id: "ds-t",
      external_id: "v-1",
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    // source's own (in-bounds) coordinates differ from the manual pin
    items: [fakeItem(venueFieldRecord({ name: "Depo", website: "https://depo.example", coordinates: { latitude: 45.5, longitude: 16.5 } }))],
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  await s.apply(plan, { commit: true });

  const row = fake.tables.venues[0];
  assert.equal(row.latitude, 45.79001, "manual latitude untouched");
  assert.equal(row.longitude, 15.95002);
  assert.equal(row.coordinates_source, "manual");
  assert.equal(row.website, "https://depo.example", "the non-coordinate change still applied");
});

test("[fields:event] a re-resolution to a different venue persists events.venue_id (Supabase)", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  fake.seed("venues", [
    { id: "v-tv", city_id: CITY_IDS.Zagreb, name: "Tvornica", name_normalized: "tvornica", is_active: true, source_id: null, external_id: null, created_at: NOW, updated_at: NOW },
    { id: "v-mo", city_id: CITY_IDS.Zagreb, name: "Klub Močvara", name_normalized: "klub mocvara", is_active: true, source_id: null, external_id: null, created_at: NOW, updated_at: NOW },
  ]);
  const s = store(fake);
  await runEvent(s, eventItem({ venueName: "Tvornica", sourceVenueId: "tvornica" }), "r1");
  assert.equal(fake.tables.events[0].venue_id, "v-tv");

  const { up } = await runEvent(
    s,
    eventItem({ title: "DJ Night (moved)", venueName: "Klub Močvara", sourceVenueId: "klub-mocvara" }),
    "r2",
  );
  assert.equal(up.changeStatus, "UPDATED");
  assert.equal(up.resolvedVenueId, "v-mo");
  assert.equal(fake.tables.events[0].venue_id, "v-mo", "events.venue_id followed the re-resolution");
});

// ── 6. CANCELLATION SEMANTICS ────────────────────────────────────────

test("[cancellation] an explicit cancel persists; a later non-cancel snapshot does NOT un-cancel", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);

  await runEvent(s, eventItem({ status: "scheduled" }), "r1");
  assert.equal(fake.tables.events[0].is_cancelled, false);

  const c = await runEvent(s, eventItem({ status: "cancelled" }), "r2");
  assert.equal(c.up.changeStatus, "UPDATED");
  assert.equal(fake.tables.events[0].is_cancelled, true, "explicit cancel persisted");

  // a later snapshot that no longer marks it cancelled must NOT resurrect it
  await runEvent(s, eventItem({ status: "scheduled" }), "r3");
  assert.equal(fake.tables.events[0].is_cancelled, true, "a bare 'scheduled' snapshot must never un-cancel");
});

test("[cancellation] source DISAPPEARANCE never cancels a still-listed-elsewhere event", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  await runEvent(s, eventItem({ externalId: "E1", title: "Kept" }), "r1");

  // next run: the source no longer lists E1, only a different event
  const adapter = createInMemoryAdapter({
    key: "entrio-hr",
    items: [fakeItem(eventRecord({ sourceKey: "entrio-hr", externalId: "E2", countryCode: "HR", cityText: "Zagreb", title: "Other", startLocal: "2026-08-01T22:00", venueName: "Tvornica", sourceVenueId: null }))],
  });
  const plan = await planSync({ adapter, source: evSrc("entrio-hr"), config: cfg(), store: s, now: NOW, runId: "r2" });
  const res = await s.apply(plan, { commit: true });
  assert.equal(res.error, null);

  const e1 = fake.tables.events.find((e) => e.external_id === "E1")!;
  assert.equal(e1.is_cancelled, false, "a disappeared event is never cancelled");
});

// ── 7. ERROR / PARTIAL-FAILURE ───────────────────────────────────────

test("[error] a failure on the 2nd upsert halts apply BEFORE reconciliation", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  fake.seed("data_sources", [{ id: "ds-t", name: "entrio-hr", type: "api" }]);
  // an existing owned event that a healthy run would reconcile
  fake.seed("events", [
    { id: "ev-stale", venue_id: "v-zg", title: "Stale", start_at: "2027-01-01T20:00:00.000Z", is_cancelled: false, source_id: "ds-t", external_id: "STALE-1", created_at: NOW, updated_at: NOW },
  ]);
  const s = store(fake);

  const adapter = createInMemoryAdapter({
    key: "entrio-hr",
    items: [
      fakeItem(eventRecord({ sourceKey: "entrio-hr", externalId: "N1", countryCode: "HR", cityText: "Zagreb", title: "Fresh", startLocal: "2027-06-01T22:00", venueName: "Tvornica", sourceVenueId: null })),
    ],
  });
  const plan = await planSync({ adapter, source: evSrc("entrio-hr"), config: cfg(), store: s, now: NOW, runId: "r1" });
  assert.equal(plan.reconciliation.reconciled, true, "the run is healthy -> reconciliation would run");
  assert.ok(plan.reconciliation.actions.length > 0);

  fake.failNext("events", "insert", { message: "boom", code: "XX000" });
  const res = await s.apply(plan, { commit: true });

  assert.equal(res.committed, false);
  assert.ok(res.error, "apply surfaced the error");
  assert.equal(res.error!.supabaseOp, "events.insert");
  assert.equal(res.reconciled, 0, "reconciliation was NOT attempted after the halt");
  assert.ok(res.notes.some((n) => /halted on first failure/.test(n)));
  assert.ok(!res.deferred.some((d) => /reconciliation mark-/.test(d)), "no reconciliation side effects");
});

// ── 8. SIDE-EFFECT / DRY-RUN DISCIPLINE ─────────────────────────────

test("[side-effect] a DEFERRED venue insert (city not in cities) creates NO data_sources row", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", []); // Belgrade is NOT in the cities table
  const s = store(fake);

  const adapter = createInMemoryAdapter({
    key: "brand-new-src",
    items: [
      fakeItem(
        venueRecord({ sourceKey: "brand-new-src", externalId: "v-1", countryCode: "RS", cityText: "Belgrade", name: "Depo" }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  assert.equal(plan.upserts[0]?.operation, "insert", "the engine still emits an insert upsert");

  const res = await s.apply(plan, { commit: true });

  assert.equal(res.inserted, 0);
  assert.ok(res.deferred.some((d) => /not in cities table/.test(d)));
  assert.equal(fake.tables.venues.length, 0);
  assert.equal(
    fake.tables.data_sources.length,
    0,
    "a venue insert that is going to be deferred must not register the source",
  );
  assert.ok(
    !fake.writes.some((w) => w.table === "data_sources"),
    "no data_sources write of any kind for a deferred insert",
  );
});

test("[dry-run] apply(plan, { commit: false }) issues ZERO database writes", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  const adapter = createInMemoryAdapter({
    key: "sync-test",
    items: venueItems({ sourceKey: "sync-test", externalId: "venue-001", name: "Example Club" }),
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store: s, now: NOW, runId: "r1" });
  assert.equal(plan.upserts[0].operation, "insert");

  const res = await s.apply(plan, { commit: false });

  assert.equal(res.committed, false);
  assert.equal(res.inserted, 1, "dry-run still counts what it WOULD do");
  assert.deepEqual(fake.writes, [], "no insert/update issued");
  assert.equal(fake.tables.venues.length, 0);
  assert.equal(fake.tables.data_sources.length, 0, "dry-run does not even resolve/create the source");
  assert.ok(res.notes.some((n) => /dry apply/.test(n)));
});

// ═══════════════════════════════════════════════════════════════════════
//  BUG-FIX REGRESSIONS (supabase-store audit step)
// ═══════════════════════════════════════════════════════════════════════

// ── BUG 1: postponed / rescheduled flatten-to-scheduled recorded on UPDATE too ──
for (const status of ["postponed", "rescheduled"] as const) {
  test(`[status] an UPDATE carrying status "${status}" records the SAME flatten-to-scheduled deferral as INSERT does`, async () => {
    const fake = new FakeSupabase();
    seedTvornica(fake);
    const s = store(fake);

    // r1: a plain scheduled INSERT — no flatten deferral
    const r1 = await runEvent(s, eventItem({ title: "Night", status: "scheduled" }), "r1");
    assert.equal(r1.res.inserted, 1);
    assert.ok(!r1.res.deferred.some((d) => /flattened to scheduled/.test(d)));

    // r2: a real comparable change (title) makes the op an UPDATE, and the
    // snapshot now carries status=<status>.
    const r2 = await runEvent(s, eventItem({ title: "Night — new time", status }), "r2");
    assert.equal(r2.up.operation, "update");
    assert.equal(r2.res.updated, 1);
    assert.ok(
      r2.res.deferred.some((d) => new RegExp(`status "${status}" flattened to scheduled — current schema only has is_cancelled`).test(d)),
      `expected the flatten deferral on UPDATE, got: ${JSON.stringify(r2.res.deferred)}`,
    );

    // cancellation monotonicity is untouched; what the schema CAN store is stored
    const row = fake.tables.events[0];
    assert.equal(row.is_cancelled, false, `"${status}" must never persist as cancelled`);
    assert.equal(row.title, "Night — new time");
  });
}

test("[status] a cancelled UPDATE still persists is_cancelled and emits NO flatten deferral", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  await runEvent(s, eventItem({ title: "Night", status: "scheduled" }), "r1");
  const r2 = await runEvent(s, eventItem({ title: "Night", status: "cancelled" }), "r2");
  assert.equal(fake.tables.events[0].is_cancelled, true);
  assert.ok(!r2.res.deferred.some((d) => /flattened to scheduled/.test(d)));
});

// ── BUG 2: synthesized SourceLink must carry the persisted source_url ──
test("[provenance] getSourceLink / listSourceLinks preserve a VENUE's persisted source_url (not hardcoded null)", async () => {
  const fake = new FakeSupabase();
  seedGeography(fake);
  const s = store(fake);
  await runVenue(
    s,
    { sourceKey: "sync-test", externalId: "v-1", name: "Depo", closingTime: "03:00", sourceUrl: "https://src.example/v-1" },
    "r1",
  );
  const row = (await s.getVenueBySource("sync-test", "v-1"))!;

  const gl = (await s.getSourceLink("venue", "sync-test", "v-1"))!;
  assert.equal(gl.sourceUrl, "https://src.example/v-1");
  // source_url is provenance metadata — it must NOT enter the content hash
  assert.equal(gl.contentHash, hashComparable(venueComparable(row)));
  assert.ok(!("sourceUrl" in gl.comparableFields), "sourceUrl is not a comparable field");
  assert.ok(!("source_url" in gl.comparableFields));

  const [ll] = await s.listSourceLinks("venue", "sync-test");
  assert.equal(ll.sourceUrl, "https://src.example/v-1");
  assert.equal(ll.contentHash, hashComparable(venueComparable(row)));
});

test("[provenance] getSourceLink / listSourceLinks preserve an EVENT's persisted source_url (not hardcoded null)", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  await runEvent(s, eventItem({ title: "DJ Night", sourceUrl: "https://src.example/E1" }), "r1");
  const row = (await s.getEventBySource("entrio-hr", "E1"))!;

  const gl = (await s.getSourceLink("event", "entrio-hr", "E1"))!;
  assert.equal(gl.sourceUrl, "https://src.example/E1");
  assert.equal(gl.contentHash, hashComparable(eventComparable(row)));
  assert.ok(!("sourceUrl" in gl.comparableFields));
  assert.ok(!("source_url" in gl.comparableFields));

  const [ll] = await s.listSourceLinks("event", "entrio-hr");
  assert.equal(ll.sourceUrl, "https://src.example/E1");
  assert.equal(ll.contentHash, hashComparable(eventComparable(row)));
});

test("[provenance] a null persisted source_url still round-trips as null through the synthesized link", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  await runEvent(s, eventItem({ title: "DJ Night", sourceUrl: null }), "r1");

  const gl = (await s.getSourceLink("event", "entrio-hr", "E1"))!;
  assert.equal(gl.sourceUrl, null);
  const [ll] = await s.listSourceLinks("event", "entrio-hr");
  assert.equal(ll.sourceUrl, null);
});

test("[provenance] source_url changing does NOT change the synthesized link's contentHash", async () => {
  const fake = new FakeSupabase();
  seedTvornica(fake);
  const s = store(fake);
  await runEvent(s, eventItem({ title: "DJ Night", sourceUrl: "https://a.example/e" }), "r1");
  const h1 = (await s.getSourceLink("event", "entrio-hr", "E1"))!.contentHash;
  // same content, new provenance URL only
  await runEvent(s, eventItem({ title: "DJ Night", sourceUrl: "https://b.example/e" }), "r2");
  const link2 = (await s.getSourceLink("event", "entrio-hr", "E1"))!;
  assert.equal(link2.sourceUrl, "https://b.example/e", "provenance URL followed the source");
  assert.equal(link2.contentHash, h1, "contentHash is unaffected by source_url");
});
