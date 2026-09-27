/**
 * Persistence parity for `InMemoryCanonicalStore` (`../../src/sync/store.ts`).
 *
 * Invariant under test: if change detection reports UPDATED because a comparable
 * canonical field changed, applying the resulting `CanonicalUpsert` must persist
 * that changed value — a subsequent read returns it, and re-planning the same
 * incoming data yields UNCHANGED (not a permanent UPDATED loop).
 *
 * Every assertion here reads the CANONICAL ROW back (`getVenueBySource` /
 * `getEventById`), which is what "the app" sees — not the source link.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../../src/sync/engine.ts";
import { comparable, eventComparable, venueComparable } from "../../src/sync/store.ts";
import { hashComparable } from "../../src/sync/canonical-hash.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { eventRecord, fakeItem, provider, seededStore, venueRecord } from "./world.ts";
import type { NormalizedRecord } from "../../src/sync/types.ts";

const NOW = "2026-06-01T00:00:00.000Z";
const cfg = () => provider();
const src = (key: string) => provider().source(key)!;

// ── VENUE UPDATE ─────────────────────────────────────────────────────
type VenueOver = Partial<Parameters<typeof venueRecord>[0]>;

async function runVenue(store: ReturnType<typeof seededStore>, over: VenueOver, runId: string) {
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
          ...over,
        }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId });
  await store.apply(plan, { commit: true });
  return plan.upserts.find((u) => u.kind === "venue")!;
}

test("[venue] name + normalizedName changes are persisted on UPDATE", async () => {
  const store = seededStore();
  const created = await runVenue(store, { name: "Depo" }, "r1");
  assert.equal(created.operation, "insert");

  const updated = await runVenue(store, { name: "Depo Magacin" }, "r2");
  assert.equal(updated.changeStatus, "UPDATED");
  assert.equal(updated.operation, "update");

  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.equal(row.name, "Depo Magacin");
  assert.equal(row.normalizedName, "depo magacin"); // engine-derived, must follow

  // idempotency: same data again -> UNCHANGED, row stable
  const again = await runVenue(store, { name: "Depo Magacin" }, "r3");
  assert.equal(again.changeStatus, "UNCHANGED");
  assert.equal((await store.getVenueBySource("osm", "v-1"))!.name, "Depo Magacin");
});

test("[venue] address + website changes are persisted on UPDATE (already-covered fields stay covered)", async () => {
  const store = seededStore();
  await runVenue(store, { name: "Depo", address: "Old St 1", website: "https://old.example" }, "r1");
  const u = await runVenue(
    store,
    { name: "Depo", address: "New Blvd 9", website: "https://new.example" },
    "r2",
  );
  assert.equal(u.changeStatus, "UPDATED");
  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.equal(row.address, "New Blvd 9");
  assert.equal(row.website, "https://new.example");
});

test("[venue] MANUAL coordinates are never overwritten by a source on UPDATE", async () => {
  const store = seededStore();
  await runVenue(store, { name: "Depo", coordinates: { latitude: 44.8, longitude: 20.45 } }, "r1");

  // simulate an admin pinning the coordinates
  const v = store.venues.find((x) => x.externalId === "v-1")!;
  v.coordinates = { latitude: 44.81111, longitude: 20.46222 };
  v.coordinatesSource = "manual";

  // a later source run brings different coordinates + a real content change
  const u = await runVenue(
    store,
    { name: "Depo", website: "https://depo.example", coordinates: { latitude: 45.0, longitude: 21.0 } },
    "r2",
  );
  assert.equal(u.changeStatus, "UPDATED");

  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.equal(row.website, "https://depo.example", "the non-coordinate change still applied");
  assert.deepEqual(row.coordinates, { latitude: 44.81111, longitude: 20.46222 }, "manual coords kept");
  assert.equal(row.coordinatesSource, "manual");
});

// ── EVENT UPDATE ─────────────────────────────────────────────────────
type EventOver = Partial<Parameters<typeof eventRecord>[0]>;

async function runEvent(store: ReturnType<typeof seededStore>, over: EventOver, runId: string) {
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
          ...over,
        }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId });
  await store.apply(plan, { commit: true });
  return { plan, up: plan.upserts.find((u) => u.kind === "event")! };
}

test("[event] coverImageUrl change is persisted on UPDATE and then reads back UNCHANGED", async () => {
  const store = seededStore();
  await runEvent(store, { coverImageUrl: "https://img.example/a.jpg" }, "r1");
  const id = store.events[0].id;
  assert.equal((await store.getEventById(id))!.coverImageUrl, "https://img.example/a.jpg");

  const { up } = await runEvent(store, { coverImageUrl: "https://img.example/b.jpg" }, "r2");
  assert.equal(up.changeStatus, "UPDATED");
  assert.ok(up.fieldDeltas.some((d) => d.field === "coverImageUrl"));
  assert.equal((await store.getEventById(id))!.coverImageUrl, "https://img.example/b.jpg");

  const { up: up3 } = await runEvent(store, { coverImageUrl: "https://img.example/b.jpg" }, "r3");
  assert.equal(up3.changeStatus, "UNCHANGED");
});

test("[event] a corrected timeZone is persisted on UPDATE (start instant follows, no UPDATED loop)", async () => {
  const store = seededStore();
  // source is explicit that 22:00 is UTC
  await runEvent(store, { timeZone: "UTC" }, "r1");
  const id = store.events[0].id;
  assert.equal((await store.getEventById(id))!.timeZone, "UTC");

  // source corrects the zone; local wall-clock unchanged -> the instant moved
  const { up } = await runEvent(store, { timeZone: "Europe/Zagreb" }, "r2");
  assert.equal(up.changeStatus, "UPDATED");
  assert.ok(up.fieldDeltas.some((d) => d.field === "startInstant"));

  const row = (await store.getEventById(id))!;
  assert.equal(row.timeZone, "Europe/Zagreb");
  assert.equal(row.startLocal, "2026-07-01T22:00");

  // would loop UPDATED forever if the stale zone were left behind
  const { up: up3 } = await runEvent(store, { timeZone: "Europe/Zagreb" }, "r3");
  assert.equal(up3.changeStatus, "UNCHANGED");
});

test("[event] title + description + ticketUrl changes persist on UPDATE", async () => {
  const store = seededStore();
  await runEvent(store, { title: "DJ Night", ticketUrl: "https://t.example/1" }, "r1");
  const id = store.events[0].id;
  const { up } = await runEvent(
    store,
    { title: "DJ Night — Extended", ticketUrl: "https://t.example/2" },
    "r2",
  );
  assert.equal(up.changeStatus, "UPDATED");
  const row = (await store.getEventById(id))!;
  assert.equal(row.title, "DJ Night — Extended");
  assert.equal(row.ticketUrl, "https://t.example/2");
});

test("[event] re-resolution to a different canonical venue is persisted on UPDATE", async () => {
  const store = seededStore(); // has v-zg-tvornica AND v-zg-mocvara in Zagreb
  await runEvent(store, { venueName: "Tvornica", sourceVenueId: "tvornica" }, "r1");
  const id = store.events[0].id;
  assert.equal((await store.getEventById(id))!.venueId, "v-zg-tvornica");

  // the source now points the same event at a different venue AND bumps a
  // comparable field, so the operation is a real UPDATE
  const { up } = await runEvent(
    store,
    { title: "DJ Night (moved)", venueName: "Klub Močvara", sourceVenueId: "klub-mocvara" },
    "r2",
  );
  assert.equal(up.changeStatus, "UPDATED");
  assert.equal(up.resolvedVenueId, "v-zg-mocvara");
  assert.equal((await store.getEventById(id))!.venueId, "v-zg-mocvara");
});

test("[event] source disappearance is NOT turned into cancellation", async () => {
  const store = seededStore();
  await runEvent(store, {}, "r1");
  const id = store.events[0].id;

  // next run: the source no longer lists this event
  const adapter = createInMemoryAdapter({
    key: "entrio-hr",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "entrio-hr",
          externalId: "E-OTHER",
          countryCode: "HR",
          cityText: "Zagreb",
          title: "Another Night",
          startLocal: "2026-08-01T22:00",
          venueName: "Tvornica",
          sourceVenueId: "tvornica",
        }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r2" });
  await store.apply(plan, { commit: true });

  const row = (await store.getEventById(id))!;
  assert.equal(row.status, "scheduled", "disappearance must never set status=cancelled");
  const link = store.links.find((l) => l.kind === "event" && l.externalId === "E1")!;
  assert.notEqual(link.sourceStatus, "active"); // reconciliation moved it (stale), not a cancel
});

// ── link / source metadata ───────────────────────────────────────────
test("[link] after an UPDATE the source link stays correct and hash matches the new content", async () => {
  const store = seededStore();
  await runEvent(store, { title: "DJ Night" }, "r1");
  const { plan } = await runEvent(store, { title: "DJ Night v2" }, "r2");

  const link = store.links.find((l) => l.kind === "event" && l.externalId === "E1")!;
  assert.equal(link.sourceKey, "entrio-hr");
  assert.equal(link.canonicalId, store.events[0].id);
  assert.equal(link.sourceStatus, "active");
  assert.equal(link.consecutiveMisses, 0);
  const rec = plan.upserts.find((u) => u.kind === "event")!.record;
  assert.equal(link.contentHash, hashComparable(comparable(rec)));
});

// ── idempotency of a raw re-apply ────────────────────────────────────
test("[idempotency] applying the very same plan twice does not double-write or drift", async () => {
  const store = seededStore();
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
          website: "https://depo.example",
        }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" });
  await store.apply(plan, { commit: true });
  await store.apply(plan, { commit: true });
  await store.apply(plan, { commit: true });

  assert.equal(store.venues.filter((v) => v.externalId === "v-1").length, 1);
  assert.equal(store.links.filter((l) => l.kind === "venue" && l.externalId === "v-1").length, 1);
  assert.equal((await store.getVenueBySource("osm", "v-1"))!.website, "https://depo.example");
});

// ─────────────────────────────────────────────────────────────────────
//  Full comparable-field coverage — every field in `venueComparable()` /
//  `eventComparable()` must survive an UPDATE (read-after-write) and then
//  re-plan as UNCHANGED (no permanent UPDATED loop).
//
//  The `world.ts` builders do not expose every field, so these spread the
//  extra fields straight onto the normalized record — exactly what an
//  adapter's `parse()` would emit.
// ─────────────────────────────────────────────────────────────────────

function venueRec(over: Record<string, unknown>): NormalizedRecord {
  const base = venueRecord({
    sourceKey: "osm",
    externalId: "v-1",
    countryCode: "RS",
    cityText: "Belgrade",
    name: "Depo",
  });
  return { ...base, fields: { ...base.fields, ...over } } as NormalizedRecord;
}

async function applyVenueRec(
  store: ReturnType<typeof seededStore>,
  rec: NormalizedRecord,
  runId: string,
) {
  const adapter = createInMemoryAdapter({ key: "osm", items: [fakeItem(rec)] });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId });
  await store.apply(plan, { commit: true });
  return plan.upserts.find((u) => u.kind === "venue")!;
}

const VENUE_FIELD_CASES: { field: string; a: Record<string, unknown>; b: Record<string, unknown>; read: (v: any) => unknown; want: unknown }[] = [
  { field: "name", a: { name: "Depo" }, b: { name: "Depo Magacin" }, read: (v) => v.name, want: "Depo Magacin" },
  { field: "address", a: { address: "Old 1" }, b: { address: "New 9" }, read: (v) => v.address, want: "New 9" },
  { field: "website", a: { website: "https://a.example" }, b: { website: "https://b.example" }, read: (v) => v.website, want: "https://b.example" },
  { field: "wikidata", a: { wikidata: "Q1" }, b: { wikidata: "Q2" }, read: (v) => v.wikidata, want: "Q2" },
  { field: "openingHours", a: { openingHours: "Mo-Fr 09:00-17:00" }, b: { openingHours: "Mo-Su 10:00-23:00" }, read: (v) => v.openingHours, want: "Mo-Su 10:00-23:00" },
  { field: "description", a: { description: "old copy" }, b: { description: "new copy" }, read: (v) => v.description, want: "new copy" },
  { field: "openingTime", a: { openingTime: "20:00" }, b: { openingTime: "22:00" }, read: (v) => v.openingTime, want: "22:00" },
  { field: "closingTime", a: { closingTime: "04:00" }, b: { closingTime: "06:00" }, read: (v) => v.closingTime, want: "06:00" },
  { field: "isActive", a: { isActive: true }, b: { isActive: false }, read: (v) => v.isActive, want: false },
  {
    field: "coordinates",
    a: { coordinates: { latitude: 44.8, longitude: 20.45 }, coordinatesSource: "source" },
    b: { coordinates: { latitude: 45.1, longitude: 20.9 }, coordinatesSource: "source" },
    read: (v) => v.coordinates,
    want: { latitude: 45.1, longitude: 20.9 },
  },
];

for (const c of VENUE_FIELD_CASES) {
  test(`[venue] comparable field "${c.field}" — UPDATE persists, then re-plan is UNCHANGED`, async () => {
    const store = seededStore();
    await applyVenueRec(store, venueRec({ name: "Depo", ...c.a }), "r1");

    const u = await applyVenueRec(store, venueRec({ name: "Depo", ...c.b }), "r2");
    assert.equal(u.changeStatus, "UPDATED", `${c.field} change must be UPDATED`);

    const row = (await store.getVenueBySource("osm", "v-1"))!;
    assert.deepEqual(c.read(row), c.want, `${c.field} must be persisted on the canonical row`);

    // the store's reported projection must now equal the persisted row's
    const link = (await store.getSourceLink("venue", "osm", "v-1"))!;
    assert.equal(link.contentHash, hashComparable(venueComparable(row)));

    const again = await applyVenueRec(store, venueRec({ name: "Depo", ...c.b }), "r3");
    assert.equal(again.changeStatus, "UNCHANGED", `${c.field}: identical data must not loop UPDATED`);
    assert.deepEqual(c.read((await store.getVenueBySource("osm", "v-1"))!), c.want);
  });
}

function eventRec(over: Record<string, unknown>): NormalizedRecord {
  const base = eventRecord({
    sourceKey: "entrio-hr",
    externalId: "E1",
    countryCode: "HR",
    cityText: "Zagreb",
    title: "DJ Night",
    startLocal: "2026-07-01T22:00",
    venueName: "Tvornica",
    sourceVenueId: "tvornica",
  });
  return { ...base, fields: { ...base.fields, ...over } } as NormalizedRecord;
}

async function applyEventRec(
  store: ReturnType<typeof seededStore>,
  rec: NormalizedRecord,
  runId: string,
) {
  const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [fakeItem(rec)] });
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId });
  await store.apply(plan, { commit: true });
  return plan.upserts.find((u) => u.kind === "event")!;
}

const EVENT_FIELD_CASES: { field: string; a: Record<string, unknown>; b: Record<string, unknown>; read: (e: any) => unknown; want: unknown }[] = [
  { field: "title", a: { title: "DJ Night" }, b: { title: "DJ Night — Extended" }, read: (e) => e.title, want: "DJ Night — Extended" },
  { field: "description", a: { description: "old" }, b: { description: "new" }, read: (e) => e.description, want: "new" },
  { field: "startLocal", a: { startLocal: "2026-07-01T22:00" }, b: { startLocal: "2026-07-01T23:30" }, read: (e) => e.startLocal, want: "2026-07-01T23:30" },
  { field: "endLocal", a: { endLocal: "2026-07-02T02:00" }, b: { endLocal: "2026-07-02T05:00" }, read: (e) => e.endLocal, want: "2026-07-02T05:00" },
  { field: "timeZone", a: { timeZone: "UTC" }, b: { timeZone: "Europe/Zagreb" }, read: (e) => e.timeZone, want: "Europe/Zagreb" },
  { field: "ticketUrl", a: { ticketUrl: "https://t.example/1" }, b: { ticketUrl: "https://t.example/2" }, read: (e) => e.ticketUrl, want: "https://t.example/2" },
  { field: "coverImageUrl", a: { coverImageUrl: "https://i.example/a.jpg" }, b: { coverImageUrl: "https://i.example/b.jpg" }, read: (e) => e.coverImageUrl, want: "https://i.example/b.jpg" },
  { field: "status (scheduled→cancelled)", a: { status: "scheduled" }, b: { status: "cancelled" }, read: (e) => e.status, want: "cancelled" },
];

for (const c of EVENT_FIELD_CASES) {
  test(`[event] comparable field "${c.field}" — UPDATE persists, then re-plan is UNCHANGED`, async () => {
    const store = seededStore();
    await applyEventRec(store, eventRec(c.a), "r1");
    const id = store.events[0].id;

    const u = await applyEventRec(store, eventRec(c.b), "r2");
    assert.equal(u.changeStatus, "UPDATED", `${c.field} change must be UPDATED`);

    const row = (await store.getEventById(id))!;
    assert.deepEqual(c.read(row), c.want, `${c.field} must be persisted on the canonical row`);

    const link = (await store.getSourceLink("event", "entrio-hr", "E1"))!;
    assert.equal(link.contentHash, hashComparable(eventComparable(row)));

    const again = await applyEventRec(store, eventRec(c.b), "r3");
    assert.equal(again.changeStatus, "UNCHANGED", `${c.field}: identical data must not loop UPDATED`);
    assert.deepEqual(c.read((await store.getEventById(id))!), c.want);
  });
}

// ─────────────────────────────────────────────────────────────────────
//  Store-parity: `getSourceLink` must report the PERSISTED canonical
//  projection (like `SupabaseCanonicalStore` reconstructs from the row),
//  NOT whatever projection the link cached at write time. A source that
//  stops asserting a field it previously supplied must not make the store
//  claim the value was cleared — the row (and the current model) keep it.
// ─────────────────────────────────────────────────────────────────────

test("[parity] venue getSourceLink mirrors the persisted row, not the last incoming payload", async () => {
  const store = seededStore();
  await applyVenueRec(store, venueRec({ name: "Depo", website: "https://a.example", wikidata: "Q1" }), "r1");
  // a later run changes the name but no longer carries website / wikidata
  await applyVenueRec(store, venueRec({ name: "Depo Two", website: null, wikidata: null }), "r2");

  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.equal(row.website, "https://a.example", "positive assertion retained (omitted ≠ cleared)");
  assert.equal(row.wikidata, "Q1");

  const link = (await store.getSourceLink("venue", "osm", "v-1"))!;
  assert.equal(link.comparableFields.website, "https://a.example");
  assert.equal(link.comparableFields.wikidata, "Q1");
  assert.equal(link.contentHash, hashComparable(venueComparable(row)));
});

test("[parity] event getSourceLink mirrors the persisted row, not the last incoming payload", async () => {
  const store = seededStore();
  await applyEventRec(store, eventRec({ ticketUrl: "https://t.example/1", coverImageUrl: "https://i.example/1.jpg" }), "r1");
  await applyEventRec(store, eventRec({ title: "DJ Night 2", ticketUrl: null, coverImageUrl: null }), "r2");

  const row = (await store.getEventById(store.events[0].id))!;
  assert.equal(row.ticketUrl, "https://t.example/1");
  assert.equal(row.coverImageUrl, "https://i.example/1.jpg");

  const link = (await store.getSourceLink("event", "entrio-hr", "E1"))!;
  assert.equal(link.comparableFields.ticketUrl, "https://t.example/1");
  assert.equal(link.comparableFields.coverImageUrl, "https://i.example/1.jpg");
  assert.equal(link.contentHash, hashComparable(eventComparable(row)));
});

test("[parity] manual venue coordinates survive AND the link still reflects the manual coords", async () => {
  const store = seededStore();
  await applyVenueRec(store, venueRec({ name: "Depo", coordinates: { latitude: 44.8, longitude: 20.45 } }), "r1");

  const pinned = store.venues.find((v) => v.externalId === "v-1")!;
  pinned.coordinates = { latitude: 44.81111, longitude: 20.46222 };
  pinned.coordinatesSource = "manual";

  await applyVenueRec(
    store,
    venueRec({ name: "Depo", website: "https://depo.example", coordinates: { latitude: 45.0, longitude: 21.0 } }),
    "r2",
  );

  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.deepEqual(row.coordinates, { latitude: 44.81111, longitude: 20.46222 }, "manual coords untouched");
  assert.equal(row.coordinatesSource, "manual");
  assert.equal(row.website, "https://depo.example", "the non-coordinate change still applied");

  const link = (await store.getSourceLink("venue", "osm", "v-1"))!;
  assert.equal(link.contentHash, hashComparable(venueComparable(row)));
  assert.equal(link.comparableFields.lat, 44.81111, "the link reports the manual coords, not the source's");

  // re-applying the very same plan is a no-op — the manual pin stays put,
  // no duplicate row (parity with SupabaseCanonicalStore.updateVenueRow).
  const adapter = createInMemoryAdapter({
    key: "osm",
    items: [
      fakeItem(
        venueRec({ name: "Depo", website: "https://depo.example", coordinates: { latitude: 45.0, longitude: 21.0 } }),
      ),
    ],
  });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r3" });
  await store.apply(plan, { commit: true });
  await store.apply(plan, { commit: true });
  const after = (await store.getVenueBySource("osm", "v-1"))!;
  assert.deepEqual(after.coordinates, { latitude: 44.81111, longitude: 20.46222 });
  assert.equal(store.venues.filter((v) => v.externalId === "v-1").length, 1);
});

// ── manual coordinates vs change detection ───────────────────────────
async function pinnedDepo() {
  const store = seededStore();
  await runVenue(store, { name: "Depo", coordinates: { latitude: 44.8, longitude: 20.45 } }, "r1");
  const v = store.venues.find((x) => x.externalId === "v-1")!;
  v.coordinates = { latitude: 44.81111, longitude: 20.46222 };
  v.coordinatesSource = "manual";
  return store;
}

test("[manual-coords regression] a source coordinate that differs ONLY from a manual pin is UNCHANGED, and the pin stays authoritative", async () => {
  const store = await pinnedDepo();
  // Before the fix: UPDATED on every run (manual coords compared against the source's).
  const u = await runVenue(store, { name: "Depo", coordinates: { latitude: 45.0, longitude: 21.0 } }, "r2");
  assert.equal(u.changeStatus, "UNCHANGED");
  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.deepEqual(row.coordinates, { latitude: 44.81111, longitude: 20.46222 });
  assert.equal(row.coordinatesSource, "manual");
});

test("[manual-coords] every NON-coordinate comparable field still produces UPDATED on a manual-pinned venue", async () => {
  // Set on the record's fields directly — `venueRecord` has no input for
  // every field (e.g. wikidata / openingHours), and must not silently drop one.
  const cases: Partial<Extract<NormalizedRecord, { kind: "venue" }>["fields"]>[] = [
    { name: "Depo Club" },
    { normalizedName: "depo club" },
    { address: "Nova 1" },
    { website: "https://depo.example" },
    { wikidata: "Q42" },
    { openingHours: "Fr 22:00-04:00" },
    { description: "techno" },
    { openingTime: "22:00" },
    { closingTime: "04:00" },
    { isActive: false },
  ];
  for (const over of cases) {
    const store = await pinnedDepo();
    const base = venueRecord({
      sourceKey: "osm",
      externalId: "v-1",
      countryCode: "RS",
      cityText: "Belgrade",
      name: "Depo",
      coordinates: { latitude: 45.0, longitude: 21.0 },
    }) as Extract<NormalizedRecord, { kind: "venue" }>;
    const rec: NormalizedRecord = { ...base, fields: { ...base.fields, ...over } };
    const adapter = createInMemoryAdapter({ key: "osm", items: [fakeItem(rec)] });
    const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r2" });
    assert.equal(plan.upserts.find((u) => u.kind === "venue")?.changeStatus, "UPDATED", JSON.stringify(over));
  }
});

test("[manual-coords] a SOURCE-owned coordinate change is still UPDATED and written", async () => {
  const store = seededStore();
  await runVenue(store, { name: "Depo", coordinates: { latitude: 44.8, longitude: 20.45 } }, "r1");
  const u = await runVenue(store, { name: "Depo", coordinates: { latitude: 44.9, longitude: 20.5 } }, "r2");
  assert.equal(u.changeStatus, "UPDATED");
  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.deepEqual(row.coordinates, { latitude: 44.9, longitude: 20.5 });
  assert.equal(row.coordinatesSource, "source");
  const again = await runVenue(store, { name: "Depo", coordinates: { latitude: 44.9, longitude: 20.5 } }, "r3");
  assert.equal(again.changeStatus, "UNCHANGED");
});

// ── source-omitted optional fields vs change detection ───────────────
const OMITTABLE = ["description", "openingTime", "closingTime", "isActive"] as const;
type VenueRec = Extract<NormalizedRecord, { kind: "venue" }>;

/** The Depo record with the OPTIONAL fields left out entirely — as the OSM adapter emits it. */
function depoOmitting(over: Partial<VenueRec["fields"]> = {}): NormalizedRecord {
  const base = venueRecord({ sourceKey: "osm", externalId: "v-1", countryCode: "RS", cityText: "Belgrade", name: "Depo" }) as VenueRec;
  const fields: Partial<VenueRec["fields"]> = { ...base.fields };
  for (const k of OMITTABLE) delete fields[k];
  return { ...base, fields: { ...(fields as VenueRec["fields"]), ...over } };
}

async function planRec(store: ReturnType<typeof seededStore>, rec: NormalizedRecord, runId: string) {
  const adapter = createInMemoryAdapter({ key: "osm", items: [fakeItem(rec)] });
  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId });
  await store.apply(plan, { commit: true });
  return plan.upserts.find((u) => u.kind === "venue")!;
}

/** A linked Depo whose curator then filled fields the source never provides. */
async function curatedDepo() {
  const store = seededStore();
  await planRec(store, depoOmitting(), "r1");
  const v = store.venues.find((x) => x.externalId === "v-1")!;
  Object.assign(v, { description: "Legendary techno club", openingTime: "23:00", closingTime: "06:00", isActive: false });
  return store;
}

test("[omitted-fields regression] fields the source does not provide never read as a change — UNCHANGED, curated values kept", async () => {
  const store = await curatedDepo();
  // Before the fix: UPDATED on this run and on every identical run after it.
  assert.equal((await planRec(store, depoOmitting(), "r2")).changeStatus, "UNCHANGED");
  assert.equal((await planRec(store, depoOmitting(), "r3")).changeStatus, "UNCHANGED");
  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.equal(row.description, "Legendary techno club");
  assert.equal(row.openingTime, "23:00");
  assert.equal(row.closingTime, "06:00");
  assert.equal(row.isActive, false);
});

test("[omitted-fields] a value the source DOES provide is still compared normally, one field at a time", async () => {
  for (const [over, read, want] of [
    [{ description: "Now with live music" }, (r: any) => r.description, "Now with live music"],
    [{ openingTime: "22:00" }, (r: any) => r.openingTime, "22:00"],
    [{ closingTime: "05:00" }, (r: any) => r.closingTime, "05:00"],
    [{ isActive: true }, (r: any) => r.isActive, true],
    [{ website: "https://depo.example" }, (r: any) => r.website, "https://depo.example"],
  ] as const) {
    const store = await curatedDepo();
    assert.equal((await planRec(store, depoOmitting(over), "r2")).changeStatus, "UPDATED", JSON.stringify(over));
    assert.equal(read((await store.getVenueBySource("osm", "v-1"))!), want, JSON.stringify(over));
    assert.equal((await planRec(store, depoOmitting(over), "r3")).changeStatus, "UNCHANGED", JSON.stringify(over));
  }
});

test("[omitted-fields] an EXPLICIT null is not 'omitted' — it is still compared (no blanket null policy)", async () => {
  const store = await curatedDepo();
  // The source asserts a value (null) that differs from the stored one: that is
  // a difference, reported as such. (The store cannot persist a clear today.)
  assert.equal((await planRec(store, depoOmitting({ description: null }), "r2")).changeStatus, "UPDATED");
});

// ── field presence: address / website / wikidata / openingHours ──────
const PRESENCE = ["address", "website", "wikidata", "openingHours"] as const;

/** Depo with EVERY optional field left out — as the OSM adapter emits a bare element. */
function depoBare(over: Partial<VenueRec["fields"]> = {}): NormalizedRecord {
  const base = venueRecord({ sourceKey: "osm", externalId: "v-1", countryCode: "RS", cityText: "Belgrade", name: "Depo" }) as VenueRec;
  const fields: Partial<VenueRec["fields"]> = { ...base.fields };
  for (const k of [...OMITTABLE, ...PRESENCE]) delete fields[k];
  return { ...base, fields: { ...(fields as VenueRec["fields"]), ...over } };
}

const CURATED = { address: "Nova 1", website: "https://curated.example", wikidata: "Q1", openingHours: "Mo-Su 18:00-02:00" };

async function curatedPresenceDepo() {
  const store = seededStore();
  await planRec(store, depoBare(), "r1");
  Object.assign(store.venues.find((x) => x.externalId === "v-1")!, CURATED);
  return store;
}

test("[presence regression] omitted address / website / wikidata / openingHours never read as a change — UNCHANGED twice, curated values kept", async () => {
  const store = await curatedPresenceDepo();
  // Before the fix: UPDATED on every run (the omitted fields compared as null).
  assert.equal((await planRec(store, depoBare(), "r2")).changeStatus, "UNCHANGED");
  assert.equal((await planRec(store, depoBare(), "r3")).changeStatus, "UNCHANGED");
  const row = (await store.getVenueBySource("osm", "v-1"))!;
  assert.deepEqual(Object.fromEntries(PRESENCE.map((k) => [k, row[k]])), CURATED);
});

test("[presence] a NEW venue with omitted fields persists them as null (never undefined) in the canonical row", async () => {
  const store = seededStore();
  await planRec(store, depoBare(), "r1");
  const row = (await store.getVenueBySource("osm", "v-1"))!;
  for (const k of [...PRESENCE, "description", "openingTime", "closingTime"] as const) {
    assert.strictEqual(row[k], null, `${k} must be stored as null`);
  }
  assert.equal(row.isActive, true);
});

test("[presence] a PROVIDED value is compared normally: UPDATED, written, then UNCHANGED — one field at a time", async () => {
  for (const k of PRESENCE) {
    const store = await curatedPresenceDepo();
    const over = { [k]: `new-${k}` };
    assert.equal((await planRec(store, depoBare(over), "r2")).changeStatus, "UPDATED", k);
    assert.equal((await store.getVenueBySource("osm", "v-1"))![k], `new-${k}`, k);
    assert.equal((await planRec(store, depoBare(over), "r3")).changeStatus, "UNCHANGED", k);
  }
});

test("[presence] an EXPLICIT null is still compared (reserved clear semantic — not treated as omitted)", async () => {
  for (const k of PRESENCE) {
    const store = await curatedPresenceDepo();
    assert.equal((await planRec(store, depoBare({ [k]: null }), "r2")).changeStatus, "UPDATED", k);
    assert.equal((await store.getVenueBySource("osm", "v-1"))![k], CURATED[k], `${k}: no clear is written`);
  }
});

test("[presence][hash contract] comparable() never contains undefined, and converges with the persisted projection", () => {
  // normalizedName as the engine fills it before persisting, so only presence differs
  const rec = depoBare({ normalizedName: "depo" });
  const incoming = comparable(rec);
  for (const [k, v] of Object.entries(incoming)) assert.notStrictEqual(v, undefined, `comparable.${k} is undefined`);
  for (const k of PRESENCE) assert.strictEqual(incoming[k], null, k);
  // a row persisted from that record projects to the same hash
  const store = seededStore();
  return planRec(store, rec, "r1").then(async () => {
    const row = (await store.getVenueBySource("osm", "v-1"))!;
    assert.equal(hashComparable(venueComparable(row)), hashComparable(incoming));
  });
});
