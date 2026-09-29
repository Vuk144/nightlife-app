/**
 * Controlled bulk EVENT writer (`../../src/sync/bulk-event-write.ts`) and its
 * Supabase client guard (`../../src/sync/supabase-write-guard.ts`).
 *
 * In-memory store + the real `SupabaseCanonicalStore` over `FakeSupabase`.
 * No network, no real database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertControlledInsertPlan,
  commitBulkEventWrite,
  prepareBulkEventWrite,
  preparedInsertAllowances,
  type BulkEventWriteDeps,
  type PreparedBulkEventWrite,
} from "../../src/sync/bulk-event-write.ts";
import { DEFAULT_RECONCILIATION, InMemoryConfigProvider } from "../../src/sync/config.ts";
import type { NormalizedEvent } from "../../src/sync/event-contract.ts";
import { planEvent, type EventPlanItem } from "../../src/sync/event-plan.ts";
import { serbianProfile } from "../../src/sync/normalization.ts";
import { InMemoryCanonicalStore, type CanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { ForbiddenWriteError, guardClientForEventInserts, guardClientReadOnly } from "../../src/sync/supabase-write-guard.ts";
import type { SyncPlan } from "../../src/sync/types.ts";
import { FakeSupabase } from "./fake-supabase.ts";

const SRC = "test-src";
const NOW = "2026-09-30T10:00:00.000Z";
const TZ = "Europe/Belgrade";

const config = () =>
  new InMemoryConfigProvider({
    countries: [{ code: "RS", name: "Serbia", enabled: true, defaultTimeZone: TZ, bounds: null, normalizationProfile: "sr", extraPlaceholderPatterns: [] }],
    cities: [{ countryCode: "RS", canonicalName: "Belgrade", enabled: true, eventFirstEnabled: false, timeZone: TZ, nameAliases: ["beograd"], bounds: null, sourceScope: {} }],
    sources: [{ key: SRC, adapter: "test", kinds: ["event"], enabled: true, trusted: true, tos: "permitted", scope: { countries: ["RS"], cities: ["Belgrade"] }, schedule: null, rateLimit: null, fieldTrust: {}, settings: {} }],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  });

function venue(id: string, name: string): CanonicalVenue {
  return {
    id, cityId: "city-bg", cityName: "Belgrade", countryCode: "RS", name, normalizedName: serbianProfile.normalizeName(name),
    address: null, coordinates: null, coordinatesSource: null, website: null, wikidata: null, openingHours: null,
    description: null, openingTime: null, closingTime: null, isActive: true, sourceKey: "OpenStreetMap", externalId: `node/${id}`,
    sourceUrl: null, createdAt: NOW, updatedAt: NOW,
  };
}
const KARMAKOMA = venue("v-km", "Karmakoma");
const ZAPPA = venue("v-zb", "Zappa Barka");
const VENUES: Record<string, CanonicalVenue> = { "v-km": KARMAKOMA, "v-zb": ZAPPA };

function event(id: string, venueName: string, startLocal: string, over: Partial<NormalizedEvent["fields"]> = {}): NormalizedEvent {
  return {
    kind: "event",
    provenance: { sourceKey: SRC, externalId: id, sourceUrl: `https://example.test/event/${id}/`, confidence: 1, fetchedAt: NOW, reported: {} },
    scope: { countryCode: "RS", cityText: "Beograd", coordinates: null },
    fields: {
      title: `Event ${id}`, description: `about ${id}`, startLocal, endLocal: null, doorsLocal: null, timeZone: TZ,
      startPrecision: "datetime", status: "scheduled", promoter: null, ticketUrl: `https://tickets.test/${id}`,
      coverImageUrl: `https://img.test/${id}.jpg`, lineup: [], ...over,
    },
    links: { venue: { name: venueName, sourceVenueId: venueName.toLowerCase().replace(/\s+/g, "-"), address: null, coordinates: null, cityText: "Beograd" } },
  };
}

/** A READY item exactly as the source-agnostic planner produces it. */
function ready(ev: NormalizedEvent, venueId: string): EventPlanItem {
  const item = planEvent({
    parsed: { ok: true, record: ev },
    venueMatch: { status: "matched", venueId, venueName: VENUES[venueId]?.name ?? "?", tier: 2, note: "test" },
    fallbackTimeZone: TZ,
  });
  assert.equal(item.action, "READY");
  return item;
}

const E1 = () => ready(event("101", "Karmakoma", "2026-10-17T23:00"), "v-km");
const E2 = () => ready(event("102", "Karmakoma", "2026-11-14T23:00"), "v-km");
const E3 = () => ready(event("103", "Zappa Barka", "2026-11-20T20:00"), "v-zb");
const REVIEW_ITEM = (): EventPlanItem => planEvent({
  parsed: { ok: true, record: event("201", "Beton", "2026-11-14T23:00") },
  venueMatch: { status: "unresolved", reasonCode: "no-existing-venue", note: "no existing venue matched" },
  fallbackTimeZone: TZ,
});
const REJECTED_ITEM = (): EventPlanItem => planEvent({ parsed: { ok: false, reason: "missing-location" }, venueMatch: null, fallbackTimeZone: TZ });

const memStore = () => new InMemoryCanonicalStore({
  cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: TZ }],
  venues: [KARMAKOMA, ZAPPA],
});
const deps = (store: CanonicalStore, runId = "run-1"): BulkEventWriteDeps => ({ store, config: config(), sourceKey: SRC, now: NOW, runId });

/** Count every call to `apply` on a store (and optionally fail on the n-th). */
function spy<T extends CanonicalStore>(store: T, opts: { throwOnCall?: number; throwAfterApplyOnCall?: number } = {}) {
  const calls: SyncPlan[] = [];
  const original = store.apply.bind(store);
  store.apply = async (plan, o) => {
    calls.push(structuredClone(plan));
    if (opts.throwOnCall === calls.length) throw new Error("simulated network failure");
    const r = await original(plan, o);
    if (opts.throwAfterApplyOnCall === calls.length) throw new Error("simulated lost response");
    return r;
  };
  return calls;
}

// ── A. 3 valid NEW events ───────────────────────────────────────────────
test("A. three READY new events: exactly 3 prepared inserts, no venue writes, all inserted", async () => {
  const store = memStore();
  const calls = spy(store);
  const pre = await prepareBulkEventWrite([E1(), E2(), E3()], deps(store));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  assert.deepEqual(pre.prepared.inserts.map((i) => [i.externalId, i.venueId]), [["101", "v-km"], ["102", "v-km"], ["103", "v-zb"]]);
  assert.equal(pre.summary.planned, 3);
  assert.equal(pre.summary.venueUpserts, 0);
  assert.equal(calls.length, 0, "preflight never applies");

  const res = await commitBulkEventWrite(pre.prepared, store);
  assert.equal(res.committed, true);
  assert.equal(res.inserted, 3);
  assert.deepEqual(res.insertedExternalIds, ["101", "102", "103"]);
  assert.equal(res.failed, 0);
  assert.equal(res.partialFailure, false);
  assert.equal(res.venueUpserts, 0);
  assert.equal(res.reconciliation, 0);
  assert.equal(calls.length, 3, "one apply per insert");
  for (const plan of calls) assertControlledInsertPlan(plan, new Set(["101", "102", "103"]));
  assert.equal(store.events.length, 3);
  assert.deepEqual(store.venues.map((v) => v.id), ["v-km", "v-zb"], "venues untouched");
  assert.deepEqual(store.events.map((e) => e.venueId).sort(), ["v-km", "v-km", "v-zb"]);
});

test("A. (Supabase store behind the client guard) only the 3 events.insert writes reach the database", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }, { id: "ds-src", name: SRC, type: "api" }]);
  fake.seed("venues", [KARMAKOMA, ZAPPA].map((v) => ({ id: v.id, city_id: "city-bg", name: v.name, name_normalized: v.normalizedName, source_id: "ds-osm", external_id: v.externalId, is_active: true, created_at: NOW, updated_at: NOW })));
  const readStore = new SupabaseCanonicalStore(guardClientReadOnly(fake.asClient()), { now: () => NOW });
  const pre = await prepareBulkEventWrite([E1(), E2(), E3()], deps(readStore));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  assert.equal(fake.writes.length, 0, "preflight: zero writes");

  const guard = guardClientForEventInserts(fake.asClient(), preparedInsertAllowances(pre.prepared));
  const res = await commitBulkEventWrite(pre.prepared, new SupabaseCanonicalStore(guard.client, { now: () => NOW }));
  assert.equal(res.committed, true);
  assert.deepEqual(guard.writes, ["events.insert 101", "events.insert 102", "events.insert 103"]);
  assert.deepEqual(fake.writes.map((w) => `${w.table}.${w.op} ${w.values.external_id}`), ["events.insert 101", "events.insert 102", "events.insert 103"]);
  assert.deepEqual(fake.tables.events.map((e) => [e.external_id, e.venue_id, e.source_id]), [["101", "v-km", "ds-src"], ["102", "v-km", "ds-src"], ["103", "v-zb", "ds-src"]]);
  assert.equal(fake.tables.venues.length, 2);
});

// ── B / C. mixed batches are rejected whole ─────────────────────────────
test("B. READY + REVIEW: the whole batch is rejected before any write", async () => {
  const store = memStore();
  const calls = spy(store);
  const pre = await prepareBulkEventWrite([E1(), REVIEW_ITEM(), E2()], deps(store));
  assert.equal(pre.ok, false);
  assert.equal(pre.summary.review, 1);
  assert.match(pre.summary.rejections.map((r) => r.reason).join(" | "), /candidate is REVIEW \(no-existing-venue\)/);
  assert.equal(calls.length, 0);
  assert.equal(store.events.length, 0);
});

test("C. READY + REJECTED: the whole batch is rejected before any write", async () => {
  const store = memStore();
  const calls = spy(store);
  const pre = await prepareBulkEventWrite([E1(), REJECTED_ITEM()], deps(store));
  assert.equal(pre.ok, false);
  assert.match(pre.summary.rejections.map((r) => r.reason).join(" | "), /candidate is REJECTED \(missing-location\)/);
  assert.equal(calls.length, 0);
  assert.equal(store.events.length, 0);
});

// ── D. canonical venue ──────────────────────────────────────────────────
test("D. a candidate whose canonical venue is missing (or absent from the store) is rejected before any write", async () => {
  const store = memStore();
  const calls = spy(store);
  const ghost = ready(event("104", "Karmakoma", "2026-10-18T23:00"), "v-ghost");
  const pre = await prepareBulkEventWrite([E1(), ghost], deps(store));
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.summary.rejections, [{ externalId: "104", reason: "canonical venue v-ghost does not exist" }]);

  const noVenue = { ...E2(), venueId: "" } as EventPlanItem;
  const pre2 = await prepareBulkEventWrite([noVenue], deps(store));
  assert.equal(pre2.ok, false);
  assert.deepEqual(pre2.summary.rejections, [{ externalId: "102", reason: "no canonical venue" }]);
  assert.equal(calls.length, 0);
});

// ── E. duplicates ───────────────────────────────────────────────────────
test("E. a duplicate — or conflicting duplicate — external id inside the batch is rejected before any write", async () => {
  const store = memStore();
  const calls = spy(store);
  const same = await prepareBulkEventWrite([E1(), E1()], deps(store));
  assert.equal(same.ok, false);
  assert.deepEqual(same.summary.rejections, [{ externalId: "101", reason: "duplicate external id in the batch" }]);
  const conflicting = ready(event("101", "Zappa Barka", "2026-12-01T20:00"), "v-zb");
  const diff = await prepareBulkEventWrite([E1(), conflicting], deps(store));
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.summary.rejections, [{ externalId: "101", reason: "conflicting duplicate external id in the batch" }]);
  assert.equal(calls.length, 0);
});

test("E. missing source identity, a foreign source and invalid canonical event data are rejected", async () => {
  const store = memStore();
  const noSource = E1() as Extract<EventPlanItem, { action: "READY" }>;
  noSource.event = { ...noSource.event, provenance: { ...noSource.event.provenance, sourceKey: "" } };
  const foreign = E2() as Extract<EventPlanItem, { action: "READY" }>;
  foreign.event = { ...foreign.event, provenance: { ...foreign.event.provenance, sourceKey: "other" } };
  const bad = E3() as Extract<EventPlanItem, { action: "READY" }>;
  bad.event = { ...bad.event, fields: { ...bad.event.fields, startLocal: "next friday" } };
  const pre = await prepareBulkEventWrite([noSource, foreign, bad], deps(store));
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.summary.rejections.map((r) => r.externalId), ["101", "102", "103"]);
  assert.match(pre.summary.rejections[0].reason, /missing source identity/);
  assert.match(pre.summary.rejections[1].reason, /does not match the batch source/);
  assert.match(pre.summary.rejections[2].reason, /invalid canonical event data/);
});

// ── F / G. existing events and idempotency ──────────────────────────────
test("F. an event already in the store is rejected by default — never inserted twice", async () => {
  const store = memStore();
  const first = await prepareBulkEventWrite([E1()], deps(store));
  assert.ok(first.ok);
  if (!first.ok) return;
  await commitBulkEventWrite(first.prepared, store);
  const calls = spy(store);
  const again = await prepareBulkEventWrite([E1(), E2()], deps(store, "run-2"));
  assert.equal(again.ok, false);
  assert.match(again.summary.rejections[0].reason, /already exists/);
  assert.equal(calls.length, 0);
  assert.equal(store.events.length, 1);
});

test("G. second identical run (skip-unchanged): NEW 0, UPDATED 0, UNCHANGED 3 — nothing written", async () => {
  const store = memStore();
  const first = await prepareBulkEventWrite([E1(), E2(), E3()], deps(store));
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal((await commitBulkEventWrite(first.prepared, store)).inserted, 3);

  const calls = spy(store);
  const second = await prepareBulkEventWrite([E1(), E2(), E3()], deps(store, "run-2"), { onExisting: "skip-unchanged" });
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.summary.planned, 0);
  assert.equal(second.summary.skippedExisting, 3);
  assert.deepEqual(second.summary.skippedExternalIds, ["101", "102", "103"]);
  const res = await commitBulkEventWrite(second.prepared, store);
  assert.deepEqual([res.committed, res.inserted, res.attempted, res.skippedExisting], [true, 0, 0, 3]);
  assert.equal(calls.length, 0);
  assert.equal(store.events.length, 3);
});

test("G. skip-unchanged never turns a CHANGED existing event into an update — it rejects", async () => {
  const store = memStore();
  const first = await prepareBulkEventWrite([E1()], deps(store));
  assert.ok(first.ok);
  if (!first.ok) return;
  await commitBulkEventWrite(first.prepared, store);
  const changed = ready(event("101", "Karmakoma", "2026-10-17T23:00", { title: "Renamed" }), "v-km");
  const pre = await prepareBulkEventWrite([changed], deps(store, "run-2"), { onExisting: "skip-unchanged" });
  assert.equal(pre.ok, false);
  assert.match(pre.summary.rejections[0].reason, /UPDATED update — this writer only inserts NEW events/);
});

// ── H. forbidden venue writes ───────────────────────────────────────────
test("H. the client guard throws on any venue write (and any other non-event write) before a request is made", () => {
  const fake = new FakeSupabase();
  const guard = guardClientForEventInserts(fake.asClient(), [{ externalId: "101", venueId: "v-km" }]);
  const c = guard.client;
  assert.throws(() => c.from("venues").insert({ name: "x" }), ForbiddenWriteError);
  assert.throws(() => c.from("venues").update({ name: "x" }), ForbiddenWriteError);
  assert.throws(() => c.from("venues").upsert({ name: "x" }), ForbiddenWriteError);
  assert.throws(() => c.from("data_sources").insert({ name: "x" }), ForbiddenWriteError);
  assert.throws(() => c.from("cities").insert({ name: "x" }), ForbiddenWriteError);
  assert.throws(() => c.from("countries").insert({ name: "x" }), ForbiddenWriteError);
  assert.throws(() => c.from("music_genres").insert({ name: "x" }), ForbiddenWriteError);
  assert.throws(() => c.rpc("anything"), ForbiddenWriteError);
  assert.throws(() => c.from("events").insert({ external_id: "999", venue_id: "v-km" }), ForbiddenWriteError);
  assert.throws(() => c.from("events").insert({ external_id: "101", venue_id: "v-zb" }), ForbiddenWriteError);
  assert.throws(() => c.from("events").insert([{ external_id: "101", venue_id: "v-km" }]), ForbiddenWriteError);
  assert.deepEqual(fake.writes, []);
  assert.throws(() => guardClientReadOnly(fake.asClient()).from("events").insert({}), ForbiddenWriteError);
});

test("H. a store that attempts a forbidden non-event write (data_sources auto-create) fails hard — zero rows written", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }]); // no row for SRC
  fake.seed("venues", [{ id: "v-km", city_id: "city-bg", name: "Karmakoma", name_normalized: "karmakoma", source_id: "ds-osm", external_id: "node/v-km", is_active: true, created_at: NOW, updated_at: NOW }]);
  const pre = await prepareBulkEventWrite([E1()], deps(new SupabaseCanonicalStore(guardClientReadOnly(fake.asClient()), { now: () => NOW })));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  const guard = guardClientForEventInserts(fake.asClient(), preparedInsertAllowances(pre.prepared));
  const res = await commitBulkEventWrite(pre.prepared, new SupabaseCanonicalStore(guard.client, { now: () => NOW }));
  assert.equal(res.committed, false);
  assert.deepEqual(res.failedExternalIds, ["101"]);
  assert.match(res.failures[0].error, /WRITE BLOCKED: data_sources\.insert/);
  assert.equal(res.failures[0].rowPresentAfterFailure, false);
  assert.deepEqual(fake.writes, []);
});

test("H. a prepared batch is frozen, cannot be forged, and cannot be committed twice", async () => {
  const store = memStore();
  const pre = await prepareBulkEventWrite([E1()], deps(store));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  assert.ok(Object.isFrozen(pre.prepared) && Object.isFrozen(pre.prepared.inserts) && Object.isFrozen(pre.prepared.inserts[0].upsert));
  assert.throws(() => { (pre.prepared.inserts as unknown as unknown[]).push({}); }, TypeError);
  const forged = { ...pre.prepared } as PreparedBulkEventWrite;
  await assert.rejects(commitBulkEventWrite(forged, store), /not a prepared batch/);
  await commitBulkEventWrite(pre.prepared, store);
  await assert.rejects(commitBulkEventWrite(pre.prepared, store), /already committed/);
  assert.equal(store.events.length, 1);
});

test("H. only a single NEW event insert may reach apply — venue writes are refused", () => {
  const venuePlan = { reconciliation: { reconciled: false, actions: [] }, upserts: [{ kind: "venue", operation: "insert", changeStatus: "NEW", canonicalId: null, record: { provenance: { externalId: "101" } } }] } as unknown as SyncPlan;
  assert.throws(() => assertControlledInsertPlan(venuePlan, new Set(["101"])), /forbidden venue write/);
});

// ── I. forbidden event updates ──────────────────────────────────────────
test("I. the client guard throws on events.update / events.delete / events.upsert", () => {
  const fake = new FakeSupabase();
  const c = guardClientForEventInserts(fake.asClient(), [{ externalId: "101", venueId: "v-km" }]).client;
  assert.throws(() => c.from("events").update({ title: "x" }), ForbiddenWriteError);
  assert.throws(() => (c.from("events") as unknown as { delete(): unknown }).delete(), ForbiddenWriteError);
  assert.throws(() => c.from("events").upsert({ external_id: "101" }), ForbiddenWriteError);
  const update = { reconciliation: { reconciled: false, actions: [] }, upserts: [{ kind: "event", operation: "update", changeStatus: "UPDATED", canonicalId: "e-1", record: { provenance: { externalId: "101" } } }] } as unknown as SyncPlan;
  assert.throws(() => assertControlledInsertPlan(update, new Set(["101"])), /forbidden event update/);
});

test("I. an event that appears after preflight is NOT turned into an update — stop, report, no update issued", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }, { id: "ds-src", name: SRC, type: "api" }]);
  fake.seed("venues", [{ id: "v-km", city_id: "city-bg", name: "Karmakoma", name_normalized: "karmakoma", source_id: "ds-osm", external_id: "node/v-km", is_active: true, created_at: NOW, updated_at: NOW }]);
  const pre = await prepareBulkEventWrite([E1(), E2()], deps(new SupabaseCanonicalStore(guardClientReadOnly(fake.asClient()), { now: () => NOW })));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  // someone else inserts 102 between preflight and commit
  fake.tables.events.push({ id: "e-race", venue_id: "v-km", title: "x", start_at: "2026-11-14T22:00:00Z", source_id: "ds-src", external_id: "102", is_cancelled: false, created_at: NOW, updated_at: NOW });
  const guard = guardClientForEventInserts(fake.asClient(), preparedInsertAllowances(pre.prepared));
  const res = await commitBulkEventWrite(pre.prepared, new SupabaseCanonicalStore(guard.client, { now: () => NOW }));
  assert.deepEqual(res.insertedExternalIds, ["101"]);
  assert.deepEqual(res.failedExternalIds, ["102"]);
  assert.match(res.failures[0].error, /appeared in the store after preflight/);
  assert.equal(res.partialFailure, true);
  assert.deepEqual(fake.writes.map((w) => `${w.table}.${w.op}`), ["events.insert"], "no update was issued");
});

test("I. even if the pre-write read is stale, the store's insert→update fallback is blocked by the client guard", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }, { id: "ds-src", name: SRC, type: "api" }]);
  fake.seed("venues", [{ id: "v-km", city_id: "city-bg", name: "Karmakoma", name_normalized: "karmakoma", source_id: "ds-osm", external_id: "node/v-km", is_active: true, created_at: NOW, updated_at: NOW }]);
  const pre = await prepareBulkEventWrite([E1()], deps(new SupabaseCanonicalStore(guardClientReadOnly(fake.asClient()), { now: () => NOW })));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  fake.tables.events.push({ id: "e-race", venue_id: "v-km", title: "x", start_at: "2026-10-17T21:00:00Z", source_id: "ds-src", external_id: "101", is_cancelled: false, created_at: NOW, updated_at: NOW });
  const guard = guardClientForEventInserts(fake.asClient(), preparedInsertAllowances(pre.prepared));
  const store = new SupabaseCanonicalStore(guard.client, { now: () => NOW });
  let reads = 0;
  const realGet = store.getEventBySource.bind(store);
  store.getEventBySource = async (s, e) => (++reads === 1 ? null : realGet(s, e)); // stale first read
  const res = await commitBulkEventWrite(pre.prepared, store);
  assert.equal(res.committed, false);
  assert.match(res.failures[0].error, /WRITE BLOCKED: events\.update/);
  assert.equal(res.failures[0].rowPresentAfterFailure, true);
  assert.deepEqual(fake.writes, [], "no update, no insert");
});

// ── J. reconciliation ───────────────────────────────────────────────────
test("J. reconciliation is disabled: every apply gets reconciled:false, and a reconciling plan is refused", async () => {
  const store = memStore();
  const calls = spy(store);
  const pre = await prepareBulkEventWrite([E1(), E2()], deps(store));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  const res = await commitBulkEventWrite(pre.prepared, store);
  assert.equal(res.reconciliation, 0);
  for (const plan of calls) assert.deepEqual([plan.reconciliation.reconciled, plan.reconciliation.actions], [false, []]);
  assert.ok(store.applied.every((r) => r.reconciled === 0));
  const reconciling = { ...calls[0], reconciliation: { ...calls[0].reconciliation, reconciled: true } };
  assert.throws(() => assertControlledInsertPlan(reconciling, new Set(["101"])), /reconciliation must be disabled/);
  const withActions = { ...calls[0], reconciliation: { ...calls[0].reconciliation, actions: [{ key: "k", canonicalId: "c", kind: "event", from: "active", transition: "mark-stale", misses: 1, note: "" }] } } as SyncPlan;
  assert.throws(() => assertControlledInsertPlan(withActions, new Set(["101"])), /reconciliation must be disabled/);
});

// ── K. partial failure ──────────────────────────────────────────────────
test("K. a failure after one insert: partial state reported exactly; retry via preflight never duplicates", async () => {
  const store = memStore();
  spy(store, { throwOnCall: 2 });
  const pre = await prepareBulkEventWrite([E1(), E2(), E3()], deps(store));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  const res = await commitBulkEventWrite(pre.prepared, store);
  assert.deepEqual(
    { committed: res.committed, attempted: res.attempted, inserted: res.insertedExternalIds, failed: res.failedExternalIds, notAttempted: res.notAttemptedExternalIds, partial: res.partialFailure, retrySafe: res.retrySafe },
    { committed: false, attempted: 2, inserted: ["101"], failed: ["102"], notAttempted: ["103"], partial: true, retrySafe: true },
  );
  assert.equal(res.failures[0].rowPresentAfterFailure, false);
  assert.match(res.retryGuidance ?? "", /Do not re-commit this prepared batch/);
  await assert.rejects(commitBulkEventWrite(pre.prepared, store), /already committed/);

  // deterministic retry: preflight again with skip-unchanged
  const retry = await prepareBulkEventWrite([E1(), E2(), E3()], deps(store, "run-2"), { onExisting: "skip-unchanged" });
  assert.ok(retry.ok);
  if (!retry.ok) return;
  assert.deepEqual(retry.prepared.inserts.map((i) => i.externalId), ["102", "103"]);
  assert.deepEqual(retry.summary.skippedExternalIds, ["101"]);
  const done = await commitBulkEventWrite(retry.prepared, store);
  assert.equal(done.committed, true);
  assert.deepEqual(store.events.map((e) => e.title).sort(), ["Event 101", "Event 102", "Event 103"], "no duplicates");
});

test("K. a write that landed but lost its response is reported as present — the retry skips it", async () => {
  const store = memStore();
  spy(store, { throwAfterApplyOnCall: 1 });
  const pre = await prepareBulkEventWrite([E1(), E2()], deps(store));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  const res = await commitBulkEventWrite(pre.prepared, store);
  assert.deepEqual([res.inserted, res.failedExternalIds, res.notAttemptedExternalIds], [0, ["101"], ["102"]]);
  assert.equal(res.failures[0].rowPresentAfterFailure, true);
  assert.equal(res.retrySafe, true);
  const retry = await prepareBulkEventWrite([E1(), E2()], deps(store, "run-2"), { onExisting: "skip-unchanged" });
  assert.ok(retry.ok);
  if (!retry.ok) return;
  assert.deepEqual([retry.summary.skippedExternalIds, retry.prepared.inserts.map((i) => i.externalId)], [["101"], ["102"]]);
  await commitBulkEventWrite(retry.prepared, store);
  assert.equal(store.events.length, 2);
});

test("K. (Supabase) an insert error mid-batch halts: 1 inserted, 1 failed, 1 not attempted", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }, { id: "ds-src", name: SRC, type: "api" }]);
  fake.seed("venues", [KARMAKOMA, ZAPPA].map((v) => ({ id: v.id, city_id: "city-bg", name: v.name, name_normalized: v.normalizedName, source_id: "ds-osm", external_id: v.externalId, is_active: true, created_at: NOW, updated_at: NOW })));
  const pre = await prepareBulkEventWrite([E1(), E2(), E3()], deps(new SupabaseCanonicalStore(guardClientReadOnly(fake.asClient()), { now: () => NOW })));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  const guard = guardClientForEventInserts(fake.asClient(), preparedInsertAllowances(pre.prepared));
  const store = new SupabaseCanonicalStore(guard.client, { now: () => NOW });
  let inserts = 0;
  const origFrom = fake.from.bind(fake);
  fake.from = ((t: string) => {
    if (t === "events") {
      const b = origFrom(t);
      const origInsert = b.insert.bind(b);
      b.insert = (v: Record<string, unknown>) => {
        if (++inserts === 2) fake.failNext("events", "insert", { message: "connection reset", code: "08006" });
        return origInsert(v);
      };
      return b;
    }
    return origFrom(t);
  }) as typeof fake.from;
  const res = await commitBulkEventWrite(pre.prepared, store);
  assert.deepEqual([res.insertedExternalIds, res.failedExternalIds, res.notAttemptedExternalIds], [["101"], ["102"], ["103"]]);
  assert.match(res.failures[0].error, /connection reset/);
  assert.equal(res.failures[0].rowPresentAfterFailure, false);
  assert.deepEqual(fake.tables.events.map((e) => e.external_id), ["101"]);
});

// ── L / M. empty batch and dry run ──────────────────────────────────────
test("L. an empty batch is a safe no-op", async () => {
  const store = memStore();
  const calls = spy(store);
  const pre = await prepareBulkEventWrite([], deps(store));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  assert.equal(pre.prepared.inserts.length, 0);
  const res = await commitBulkEventWrite(pre.prepared, store);
  assert.deepEqual([res.committed, res.attempted, res.inserted, res.failed], [true, 0, 0, 0]);
  assert.equal(calls.length, 0);
});

test("M. preflight is a dry run: the exact insert set, zero writes, and commit writes exactly that set", async () => {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }, { id: "ds-src", name: SRC, type: "api" }]);
  fake.seed("venues", [KARMAKOMA, ZAPPA].map((v) => ({ id: v.id, city_id: "city-bg", name: v.name, name_normalized: v.normalizedName, source_id: "ds-osm", external_id: v.externalId, is_active: true, created_at: NOW, updated_at: NOW })));
  const pre = await prepareBulkEventWrite([E1(), E3()], deps(new SupabaseCanonicalStore(guardClientReadOnly(fake.asClient()), { now: () => NOW })));
  assert.ok(pre.ok);
  if (!pre.ok) return;
  assert.equal(fake.writes.length, 0, "preflight: zero writes");
  assert.equal(fake.tables.events.length, 0);
  assert.deepEqual(pre.prepared.inserts.map((i) => [i.externalId, i.venueId, i.title, i.startAt]), [["101", "v-km", "Event 101", "2026-10-17T21:00:00.000Z"], ["103", "v-zb", "Event 103", "2026-11-20T19:00:00.000Z"]]);
  const guard = guardClientForEventInserts(fake.asClient(), preparedInsertAllowances(pre.prepared));
  await commitBulkEventWrite(pre.prepared, new SupabaseCanonicalStore(guard.client, { now: () => NOW }));
  assert.deepEqual(fake.tables.events.map((e) => [e.external_id, e.venue_id, e.start_at]), [["101", "v-km", "2026-10-17T21:00:00.000Z"], ["103", "v-zb", "2026-11-20T19:00:00.000Z"]]);
});
