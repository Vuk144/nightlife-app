/**
 * `../../src/sync/report.ts#formatSyncPlan` — pure string rendering of a
 * `SyncPlan`. It was exported but untested.
 *
 * Invariants under test: the render is deterministic, counters reflect the plan
 * exactly (no double-counting), a dry-run plan never claims writes happened,
 * failure is distinguishable from a valid-but-empty run, ambiguous identities
 * show up as review items (never as merges), and missing optional fields never
 * crash the formatter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../../src/sync/engine.ts";
import { formatSyncPlan } from "../../src/sync/report.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import {
  eventRecord,
  fakeItem,
  provider,
  seededStore,
  venueRecord,
} from "./world.ts";
import type { SyncPlan } from "../../src/sync/types.ts";

const NOW = "2026-06-01T00:00:00.000Z";
const cfg = () => provider();
const src = (k: string) => provider().source(k)!;

async function plan(over: {
  key: string;
  sourceKey: string;
  items?: ReturnType<typeof fakeItem>[];
  failDiscovery?: boolean;
}): Promise<SyncPlan> {
  const adapter = createInMemoryAdapter({
    key: over.key,
    items: over.items ?? [],
    failDiscovery: over.failDiscovery,
  });
  return planSync({
    adapter,
    source: src(over.sourceKey),
    config: cfg(),
    store: seededStore(),
    now: NOW,
    runId: "r1",
  });
}

const venueItem = () =>
  fakeItem(
    venueRecord({ sourceKey: "osm", externalId: "v-1", countryCode: "RS", cityText: "Belgrade", name: "Depo" }),
  );

// ── determinism ───────────────────────────────────────────────────
test("formatSyncPlan is deterministic — same plan renders byte-identical, twice", async () => {
  const p = await plan({ key: "osm", sourceKey: "osm", items: [venueItem()] });
  assert.equal(formatSyncPlan(p), formatSyncPlan(p));
});

test("counter/section ordering is stable across independent runs of the same input", async () => {
  const a = await plan({ key: "osm", sourceKey: "osm", items: [venueItem()] });
  const b = await plan({ key: "osm", sourceKey: "osm", items: [venueItem()] });
  // ids/timestamps are fixed in these fixtures, so the whole render should match
  assert.equal(formatSyncPlan(a), formatSyncPlan(b));
});

// ── dry-run must never imply writes ───────────────────────────────
test("the render states nothing was written and tags the plan mode", async () => {
  const p = await plan({ key: "osm", sourceKey: "osm", items: [venueItem()] });
  const text = formatSyncPlan(p);
  assert.match(text, /\[plan\]/);
  assert.match(text, /canonical upserts \(nothing written — plan only\)/);
  assert.doesNotMatch(text, /\binserted\b|\bwrote\b|\bcommitted\b/i);
});

// ── counters reflect the plan, no double-count ────────────────────
test("byChangeStatus and per-operation counts match the plan exactly", async () => {
  const p = await plan({ key: "osm", sourceKey: "osm", items: [venueItem()] });
  const text = formatSyncPlan(p);

  // exactly one venue upsert this run
  assert.equal(p.upserts.length, 1);
  const op = `${p.upserts[0].kind}:${p.upserts[0].operation}`;
  const opLine = text.split("\n").filter((l) => l.includes(op));
  assert.equal(opLine.length, 1, "each kind:operation is listed once");
  assert.match(opLine[0], new RegExp(`${op}\\s+1$`));

  // only non-zero change statuses are shown, and their sum equals #upserts + review
  const shown = [...text.matchAll(/^ {4}(NEW|UPDATED|UNCHANGED|STALE|MISSING|GONE|REJECTED|NEEDS_REVIEW)\s+(\d+)$/gm)];
  const sum = shown.reduce((n, m) => n + Number(m[2]), 0);
  const nonZero = Object.values(p.stats.byChangeStatus).filter((v) => v > 0).length;
  assert.equal(shown.length, nonZero, "every non-zero status shown once, zeros hidden");
  assert.equal(sum, p.upserts.length + p.reviewItems.length);
});

// ── failure vs valid-empty ───────────────────────────────────────
test("a FAILED run reads as FAILED + reconciliation SKIPPED with a reason", async () => {
  const p = await plan({ key: "osm", sourceKey: "osm", failDiscovery: true });
  const text = formatSyncPlan(p);
  assert.match(text, /status: FAILED\s+healthy=false/);
  assert.match(text, /reconciliation: SKIPPED — .+/);
  assert.doesNotMatch(text, /reconciliation: RECONCILED/);
});

test("a healthy run that changed nothing reads as OK + RECONCILED, distinct from a failure", async () => {
  // seededStore has no source links for "osm", so a healthy empty discover still
  // reconciles (nothing to do) rather than failing.
  const store = seededStore();
  const adapter = createInMemoryAdapter({ key: "osm", items: [venueItem()] });
  const p1 = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" });
  // apply so a second run is genuinely "unchanged"
  await store.apply(p1, { commit: true });
  const adapter2 = createInMemoryAdapter({ key: "osm", items: [venueItem()] });
  const p2 = await planSync({ adapter: adapter2, source: src("osm"), config: cfg(), store, now: NOW, runId: "r2" });

  const text = formatSyncPlan(p2);
  assert.match(text, /status: OK\s+healthy=true/);
  assert.match(text, /reconciliation: RECONCILED/);
});

// ── ambiguous identity shows as review, never as a merge ─────────
test("an ambiguous venue identity is rendered in the review queue, not counted as matched", async () => {
  // two seeded Zagreb venues both normalize to "tvornica"? seededStore has one.
  // Force ambiguity: a source venue whose normalized name collides with TWO
  // existing rows in the same city.
  const store = seededStore();
  store.venues.push({
    ...store.venues.find((v) => v.id === "v-zg-tvornica")!,
    id: "v-zg-tvornica-2",
    name: "Tvornica (2)",
  });
  const adapter = createInMemoryAdapter({
    key: "osm",
    items: [
      fakeItem(
        venueRecord({ sourceKey: "osm", externalId: "dup", countryCode: "HR", cityText: "Zagreb", name: "Tvornica" }),
      ),
    ],
  });
  const p = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" });

  assert.equal(p.stats.venuesMatched, 0, "ambiguity is never a match");
  assert.ok(p.reviewItems.length >= 1);
  const text = formatSyncPlan(p);
  assert.match(text, /review queue \(\d+\)/);
  assert.match(text, /\[venue\] Tvornica — venue-ambiguous/);
  assert.doesNotMatch(text, /venue:link-only|venue:update/);
});

// ── missing optional fields never crash ─────────────────────────
test("formatSyncPlan tolerates a minimal hand-built plan (empty everything)", () => {
  const bare: SyncPlan = {
    run: { runId: "r0", sourceKey: "src", startedAt: NOW, mode: "plan", scope: { countries: [], cities: [] } },
    upserts: [],
    reconciliation: { reconciled: false, runStatus: "failed", actions: [], skippedReason: null },
    reviewItems: [],
    stats: {
      discovered: 0,
      fetched: 0,
      fetchFailed: 0,
      parsed: 0,
      parseFailed: 0,
      byChangeStatus: {
        NEW: 0, UPDATED: 0, UNCHANGED: 0, STALE: 0, MISSING: 0, GONE: 0, REJECTED: 0, NEEDS_REVIEW: 0,
      },
      venuesMatched: 0,
      venuesNew: 0,
      eventsMatched: 0,
      eventsNew: 0,
      reviewItems: 0,
      reconciled: false,
      reconciliationActions: 0,
      durationMs: 0,
      status: "failed",
      healthy: false,
      notes: [],
    },
  };
  const text = formatSyncPlan(bare);
  assert.match(text, /SYNC PLAN — src/);
  assert.match(text, /reconciliation: SKIPPED$/m); // null skippedReason -> no " — " suffix
  assert.doesNotMatch(text, /review queue/); // empty -> section omitted
  assert.doesNotMatch(text, /^ {2}notes$/m); // empty -> section omitted
});

test("scope with no countries/cities renders '(all)', not an empty string", () => {
  const p: SyncPlan = {
    run: { runId: "r", sourceKey: "s", startedAt: NOW, mode: "plan", scope: { countries: [], cities: [] } },
    upserts: [],
    reconciliation: { reconciled: true, runStatus: "ok", actions: [], skippedReason: null },
    reviewItems: [],
    stats: {
      discovered: 0, fetched: 0, fetchFailed: 0, parsed: 0, parseFailed: 0,
      byChangeStatus: { NEW: 0, UPDATED: 0, UNCHANGED: 0, STALE: 0, MISSING: 0, GONE: 0, REJECTED: 0, NEEDS_REVIEW: 0 },
      venuesMatched: 0, venuesNew: 0, eventsMatched: 0, eventsNew: 0, reviewItems: 0,
      reconciled: true, reconciliationActions: 0, durationMs: 0, status: "ok", healthy: true, notes: [],
    },
  };
  assert.match(formatSyncPlan(p), /countries=\(all\) cities=\(all\)/);
});

// ── reconciliation actions: only real transitions shown ─────────
test("keep-active / no-op reconciliation actions are NOT rendered as lifecycle changes", async () => {
  const store = seededStore();
  const item = fakeItem(
    eventRecord({
      sourceKey: "entrio-hr", externalId: "E1", countryCode: "HR", cityText: "Zagreb",
      title: "DJ Night", startLocal: "2027-07-01T22:00", venueName: "Tvornica", sourceVenueId: "tvornica",
    }),
  );
  const a1 = createInMemoryAdapter({ key: "entrio-hr", items: [item] });
  const p1 = await planSync({ adapter: a1, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r1" });
  await store.apply(p1, { commit: true });

  // second run: same event still present -> keep-active only
  const a2 = createInMemoryAdapter({ key: "entrio-hr", items: [item] });
  const p2 = await planSync({ adapter: a2, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r2" });
  const text = formatSyncPlan(p2);
  assert.match(text, /reconciliation: RECONCILED/);
  assert.doesNotMatch(text, /^ {4}(keep-active|no-op)\b/m);
  assert.doesNotMatch(text, /mark-stale|mark-missing|mark-gone/);
});
