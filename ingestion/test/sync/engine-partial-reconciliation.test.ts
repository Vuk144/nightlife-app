/**
 * Run completeness (`PlanSyncInput.completeness`, `SyncRunContext.completeness`):
 * a PARTIAL run (one event, a hand-picked batch, a `limit`-truncated discovery)
 * reconciles only the stored records it saw; a COMPLETE run reconciles exactly
 * as before. Regression for GIGS: planning event 26407 alone marked the stored,
 * unrelated event 25772 (Intercell) stale.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGigstixConfigProvider } from "../../src/sync/adapters/gigstix-config.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { planSync } from "../../src/sync/engine.ts";
import type { NormalizedEvent } from "../../src/sync/event-contract.ts";
import { formatSyncPlan } from "../../src/sync/report.ts";
import { InMemoryCanonicalStore, type CanonicalEvent, type CanonicalVenue, type SourceLink } from "../../src/sync/store.ts";
import type { RunCompleteness } from "../../src/sync/types.ts";
import { CROSS_SOURCE_VENUE_IDENTITIES } from "../../src/sync/venue-cross-source-identity.ts";
import { activeEventLink, fakeItem, provider, seededStore, venueRecord } from "./world.ts";

const NOW = "2026-09-27T20:00:00.000Z";

// ── GIGS world: Belgrade, the distillery venue, stored event 25772 ─────────
const DISTILLERY: CanonicalVenue = {
  id: "v-bud", cityId: "city-bg", cityName: "Belgrade", countryCode: "RS",
  name: "Belgrade Urban Distillery", normalizedName: "belgrade urban distillery",
  address: null, coordinates: null, coordinatesSource: null, website: null, wikidata: null,
  openingHours: null, description: null, openingTime: null, closingTime: null, isActive: true,
  sourceKey: "OpenStreetMap", externalId: "node/12068261369", sourceUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};

function storedEvent(id: string, startLocal: string, status: CanonicalEvent["status"] = "scheduled"): CanonicalEvent {
  return {
    id, venueId: "v-bud", title: id, description: null, startLocal, timeZone: "Europe/Belgrade", endLocal: null,
    status, ticketUrl: null, coverImageUrl: null, canonicalSourceKey: "gigstix", sourceUrl: null,
    createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
  };
}
const gigsLink = (externalId: string, canonicalId: string, over: Partial<SourceLink> = {}) =>
  activeEventLink({ id: `link-${externalId}`, sourceKey: "gigstix", externalId, canonicalId, ...over });

/** The stored state after the real 25772 proof: one future gigstix event, active. */
function gigsStore(extraEvents: CanonicalEvent[] = [], extraLinks: SourceLink[] = []) {
  return new InMemoryCanonicalStore({
    cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade" }],
    venues: [DISTILLERY],
    events: [storedEvent("ev-25772", "2026-10-30T23:00"), ...extraEvents],
    sourceLinks: [gigsLink("25772", "ev-25772"), ...extraLinks],
  });
}

function gigsEvent(externalId: string, startLocal = "2026-10-23T19:00", status: NormalizedEvent["fields"]["status"] = "scheduled"): NormalizedEvent {
  return {
    kind: "event",
    provenance: { sourceKey: "gigstix", externalId, sourceUrl: null, confidence: 1, fetchedAt: NOW, reported: {} },
    scope: { countryCode: "RS", cityText: "Beograd", coordinates: null },
    fields: {
      title: `Event ${externalId}`, description: null, startLocal, endLocal: null, doorsLocal: null,
      timeZone: "Europe/Belgrade", startPrecision: "datetime", status, promoter: null, ticketUrl: null,
      coverImageUrl: null, lineup: [],
    },
    links: { venue: { name: "Barrel house", sourceVenueId: "barrel-house", address: null, coordinates: null, cityText: "Beograd" } },
  };
}

function gigsPlan(store: InMemoryCanonicalStore, events: NormalizedEvent[], completeness?: RunCompleteness) {
  const config = createGigstixConfigProvider();
  return planSync({
    adapter: createInMemoryAdapter({
      key: "gigstix",
      items: events.map((e) => ({ externalId: e.provenance.externalId, kind: "event" as const, payload: e })),
    }),
    source: config.source("gigstix")!,
    config,
    store,
    now: NOW,
    runId: "t",
    crossSourceIdentities: CROSS_SOURCE_VENUE_IDENTITIES,
    completeness,
  });
}
const actionFor = (plan: Awaited<ReturnType<typeof gigsPlan>>, key: string) =>
  plan.reconciliation.actions.find((a) => a.key === key);

// ── 1–2. the GIGS regression ─────────────────────────────────────────────
test("partial run with only 26407: stored event 25772 gets NO reconciliation action; 26407 still plans on the distillery", async () => {
  const plan = await gigsPlan(gigsStore(), [gigsEvent("26407")], "partial");
  assert.equal(plan.run.completeness, "partial");
  assert.equal(plan.reconciliation.reconciled, true);
  assert.equal(actionFor(plan, "gigstix:25772"), undefined);
  assert.deepEqual(plan.reconciliation.actions, []);
  assert.equal(plan.stats.byChangeStatus.STALE, 0);
  assert.equal(plan.stats.reconciliationActions, 0);
  assert.ok(plan.stats.notes.some((n) => /partial run: 1 stored record\(s\) not seen/.test(n)));
  assert.deepEqual(
    plan.upserts.map((u) => [u.kind, u.operation, u.changeStatus, u.resolvedVenueId]),
    [["event", "insert", "NEW", "v-bud"]],
  );
});

test("the same data as a COMPLETE run (default): 25772 is still marked stale — unchanged behavior", async () => {
  for (const completeness of [undefined, "complete"] as const) {
    const plan = await gigsPlan(gigsStore(), [gigsEvent("26407")], completeness);
    assert.equal(plan.run.completeness, "complete");
    assert.equal(actionFor(plan, "gigstix:25772")?.transition, "mark-stale");
    assert.equal(plan.stats.byChangeStatus.STALE, 1);
  }
});

// ── 3. limit truncation ────────────────────────────────────────────────
const zgVenue = (externalId: string, name: string) =>
  fakeItem(venueRecord({ sourceKey: "osm", externalId, countryCode: "HR", cityText: "Zagreb", name }));
const osmLink = (externalId: string, over: Partial<SourceLink> = {}): SourceLink =>
  activeEventLink({ id: `l-${externalId}`, kind: "venue", sourceKey: "osm", externalId, canonicalId: `c-${externalId}`, ...over });

test("a `limit` that truncates discovery makes the run partial and protects every unseen stored record", async () => {
  const items = [1, 2, 3, 4, 5].map((i) => zgVenue(`v${i}`, `Klub ${i}`));
  const run = async (limit: number | undefined) => {
    const store = seededStore();
    store.links.push(osmLink("v-old"), osmLink("v5"));
    return planSync({ adapter: createInMemoryAdapter({ key: "osm", items }), source: provider().source("osm")!, config: provider(), store, now: NOW, runId: "r", limit });
  };

  const truncated = await run(2);
  assert.equal(truncated.stats.discovered, 2);
  assert.equal(truncated.run.completeness, "partial");
  assert.deepEqual(truncated.reconciliation.actions, [], "v-old and the untaken v5 are not reconciled");

  const whole = await run(undefined);
  assert.equal(whole.run.completeness, "complete");
  assert.equal(whole.reconciliation.actions.find((a) => a.key === "osm:v-old")?.transition, "mark-stale");
  assert.equal(whole.reconciliation.actions.find((a) => a.key === "osm:v5")?.transition, "keep-active");

  const roomy = await run(99);
  assert.equal(roomy.run.completeness, "complete", "a limit that did not cut discovery short keeps the run complete");
});

// ── 4. seen records still follow the existing rules ─────────────────────
test("a partial run keeps a SEEN stale record active (misses reset); an unseen one is untouched", async () => {
  const store = seededStore();
  store.links.push(osmLink("v1", { canonicalId: "v-zg-mocvara", sourceStatus: "stale", consecutiveMisses: 1 }), osmLink("v-old"));
  const plan = await planSync({
    adapter: createInMemoryAdapter({ key: "osm", items: [zgVenue("v1", "Klub Močvara")] }),
    source: provider().source("osm")!, config: provider(), store, now: NOW, runId: "r", completeness: "partial",
  });
  assert.deepEqual(
    plan.reconciliation.actions.map((a) => [a.key, a.transition, a.misses]),
    [["osm:v1", "keep-active", 0]],
  );
});

test("protected states are unchanged in a partial run: seen past / cancelled / gone records are no-op", async () => {
  const store = gigsStore(
    [storedEvent("ev-past", "2026-09-01T22:00"), storedEvent("ev-cancel", "2026-11-01T22:00", "cancelled"), storedEvent("ev-gone", "2026-11-02T22:00")],
    [gigsLink("P", "ev-past"), gigsLink("C", "ev-cancel"), gigsLink("G", "ev-gone", { sourceStatus: "gone", consecutiveMisses: 3 })],
  );
  const plan = await gigsPlan(
    store,
    [gigsEvent("P", "2026-09-01T22:00"), gigsEvent("C", "2026-11-01T22:00", "cancelled"), gigsEvent("G", "2026-11-02T22:00")],
    "partial",
  );
  assert.deepEqual(
    plan.reconciliation.actions.map((a) => [a.key, a.transition]).sort(),
    [["gigstix:C", "no-op"], ["gigstix:G", "no-op"], ["gigstix:P", "no-op"]],
  );
  assert.equal(actionFor(plan, "gigstix:25772"), undefined);
});

test("a FAILED partial run still reconciles nothing", async () => {
  const config = createGigstixConfigProvider();
  const plan = await planSync({
    adapter: createInMemoryAdapter({ key: "gigstix", items: [], failDiscovery: true }),
    source: config.source("gigstix")!, config, store: gigsStore(), now: NOW, runId: "t", completeness: "partial",
  });
  assert.equal(plan.reconciliation.reconciled, false);
  assert.deepEqual(plan.reconciliation.actions, []);
  assert.equal(plan.run.completeness, "partial");
});

// ── 5. snapshot guards ─────────────────────────────────────────────────
test("snapshot-style adapter: a partial run is not a false collapse; the same data as a complete run still trips the guard", async () => {
  const run = async (completeness: RunCompleteness) => {
    const store = seededStore();
    for (let i = 0; i < 10; i++) store.links.push(osmLink(`s${i}`));
    return planSync({
      adapter: createInMemoryAdapter({ key: "osm", items: [zgVenue("s0", "Klub S0")], capabilities: { snapshotRefs: true } }),
      source: provider().source("osm")!, config: provider(), store, now: NOW, runId: "r", completeness,
    });
  };

  const partial = await run("partial");
  assert.equal(partial.stats.healthy, true);
  assert.equal(partial.stats.status, "ok");
  assert.ok(!partial.stats.notes.some((n) => /collapsed/.test(n)));
  assert.deepEqual(partial.reconciliation.actions.map((a) => [a.key, a.transition]), [["osm:s0", "keep-active"]]);

  const complete = await run("complete");
  assert.equal(complete.stats.healthy, false);
  assert.ok(complete.stats.notes.some((n) => /collapsed result: only 1 of 10/.test(n)));
  assert.equal(complete.reconciliation.reconciled, false);
});

test("snapshot-style adapter: one failed ref does not reject a partial run (nothing unseen is reconciled); a complete run is still rejected", async () => {
  const run = async (completeness: RunCompleteness) => {
    const store = seededStore();
    store.links.push(osmLink("s2"));
    const adapter = createInMemoryAdapter({
      key: "osm",
      items: [zgVenue("s0", "Klub S0"), zgVenue("s1", "Klub S1"), zgVenue("s2", "Klub S2")],
      capabilities: { snapshotRefs: true },
    });
    const fetchOk = adapter.fetch.bind(adapter);
    adapter.fetch = async (ref, ctx) => (ref.externalId === "s2" ? { ...(await fetchOk(ref, ctx)), status: 500 } : fetchOk(ref, ctx));
    return planSync({ adapter, source: provider().source("osm")!, config: provider(), store, now: NOW, runId: "r", completeness });
  };

  const partial = await run("partial");
  assert.equal(partial.stats.fetchFailed, 1);
  assert.equal(partial.stats.healthy, true, "1/3 failed is within the generic ratios, and a partial run reconciles nothing unseen");
  assert.equal(partial.upserts.length, 2, "the two good partitions are still planned");
  assert.deepEqual(partial.reconciliation.actions, []);

  const complete = await run("complete");
  assert.equal(complete.stats.healthy, false);
  assert.ok(complete.stats.notes.some((n) => /a whole partition is missing/.test(n)));
  assert.equal(complete.reconciliation.reconciled, false);
});

// ── 6. apply ───────────────────────────────────────────────────────────
test("in-memory apply of a partial plan leaves the unseen link untouched (a complete plan would mark it stale)", async () => {
  const partialStore = gigsStore();
  const partial = await gigsPlan(partialStore, [gigsEvent("26407")], "partial");
  await partialStore.apply(partial, { commit: true });
  const kept = partialStore.links.find((l) => l.externalId === "25772")!;
  assert.deepEqual([kept.sourceStatus, kept.consecutiveMisses], ["active", 0]);
  assert.equal(partialStore.events.length, 2, "26407 was inserted");

  const completeStore = gigsStore();
  const complete = await gigsPlan(completeStore, [gigsEvent("26407")], "complete");
  await completeStore.apply(complete, { commit: true });
  const staled = completeStore.links.find((l) => l.externalId === "25772")!;
  assert.deepEqual([staled.sourceStatus, staled.consecutiveMisses], ["stale", 1]);
});

// ── 7. report ──────────────────────────────────────────────────────────
test("the report states whether the run was complete or partial", async () => {
  assert.match(formatSyncPlan(await gigsPlan(gigsStore(), [gigsEvent("26407")], "partial")), /^ {2}run: PARTIAL — /m);
  assert.match(formatSyncPlan(await gigsPlan(gigsStore(), [gigsEvent("26407")])), /^ {2}run: COMPLETE$/m);
});
