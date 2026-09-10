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
import type {
  CanonicalUpsert,
  NormalizedRecord,
  ReconcileAction,
  ReviewItem,
  SyncPlan,
} from "../../src/sync/types.ts";

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
  // EXCEPT `stats.durationMs` — a real `Date.now()` wall-clock measurement (the
  // one legitimately non-deterministic field, same as the events pipeline).
  // Normalize it out; this test is about counter/section *ordering*.
  const stripDuration = (s: string) => s.replace(/\(\d+ms\)/, "(<ms>)");
  assert.equal(stripDuration(formatSyncPlan(a)), stripDuration(formatSyncPlan(b)));
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

// ═════════════════════════════════════════════════════════════════════
//  AUDIT PASS — hand-built fixtures for precise field-mapping control
//  (every test below is characterization: it passes against current code)
// ═════════════════════════════════════════════════════════════════════

function prov(over: Partial<NormalizedRecord["provenance"]> = {}): NormalizedRecord["provenance"] {
  return { sourceKey: "s", externalId: "x1", sourceUrl: null, confidence: 1, fetchedAt: NOW, reported: {}, ...over };
}
const RAW_SCOPE = { countryCode: "RS", cityText: "Belgrade", coordinates: null } as const;

function venueRec(name: string): Extract<NormalizedRecord, { kind: "venue" }> {
  return {
    kind: "venue",
    provenance: prov(),
    scope: { ...RAW_SCOPE },
    fields: {
      name,
      normalizedName: name.toLowerCase(),
      address: null, coordinates: null, coordinatesSource: null,
      website: null, wikidata: null, openingHours: null,
    },
    links: {},
  };
}
function eventRec(title: string): Extract<NormalizedRecord, { kind: "event" }> {
  return {
    kind: "event",
    provenance: prov(),
    scope: { ...RAW_SCOPE },
    fields: {
      title,
      description: null, startLocal: "2027-01-01T22:00", endLocal: null, doorsLocal: null,
      timeZone: null, startPrecision: "datetime", status: "scheduled",
      promoter: null, ticketUrl: null, coverImageUrl: null, lineup: [],
    },
    links: {},
  };
}
function upsert(kind: "venue" | "event", operation: CanonicalUpsert["operation"]): CanonicalUpsert {
  return {
    kind, operation, changeStatus: "NEW", canonicalId: null, fieldDeltas: [],
    record: kind === "venue" ? venueRec("V") : eventRec("E"),
    identity: { entity: kind, decision: "new_candidate", tier: 3, canonicalId: null, reasonCode: "x", note: "n" },
  };
}
function reconAction(over: Partial<ReconcileAction> = {}): ReconcileAction {
  return {
    key: "s:E1", canonicalId: "c1", kind: "event", from: "active",
    transition: "mark-stale", misses: 1, note: "missed 1×", ...over,
  };
}
function reviewItem(over: Partial<ReviewItem> & { record: NormalizedRecord }): ReviewItem {
  return { kind: over.record.kind, reasonCode: "rc", reasons: [], suggestedCanonicalId: null, ...over };
}

function fullPlan(over: {
  run?: Partial<SyncPlan["run"]>;
  stats?: Partial<SyncPlan["stats"]>;
  upserts?: CanonicalUpsert[];
  reviewItems?: ReviewItem[];
  reconciliation?: Partial<SyncPlan["reconciliation"]>;
} = {}): SyncPlan {
  return {
    run: { runId: "r1", sourceKey: "gigstix", startedAt: NOW, mode: "plan", scope: { countries: ["RS"], cities: ["Belgrade"] }, ...over.run },
    upserts: over.upserts ?? [],
    reconciliation: { reconciled: true, runStatus: "ok", actions: [], skippedReason: null, ...over.reconciliation },
    reviewItems: over.reviewItems ?? [],
    stats: {
      discovered: 0, fetched: 0, fetchFailed: 0, parsed: 0, parseFailed: 0,
      byChangeStatus: { NEW: 0, UPDATED: 0, UNCHANGED: 0, STALE: 0, MISSING: 0, GONE: 0, REJECTED: 0, NEEDS_REVIEW: 0 },
      venuesMatched: 0, venuesNew: 0, eventsMatched: 0, eventsNew: 0, reviewItems: 0,
      reconciled: true, reconciliationActions: 0, durationMs: 0, status: "ok", healthy: true, notes: [],
      ...over.stats,
    },
  };
}

// ── 1. immutability / frozen input ─────────────────────────────────
test("formatSyncPlan does not mutate a deep-frozen, fully-populated plan", () => {
  const p = fullPlan({
    upserts: [upsert("venue", "insert"), upsert("event", "link-only")],
    reviewItems: [reviewItem({ record: venueRec("Klub Močvara") })],
    reconciliation: { actions: [reconAction(), reconAction({ transition: "keep-active" })] },
    stats: { discovered: 5, notes: ["one", "two"], byChangeStatus: { NEW: 2, UPDATED: 0, UNCHANGED: 1, STALE: 0, MISSING: 0, GONE: 0, REJECTED: 0, NEEDS_REVIEW: 0 } },
  });
  const deepFreeze = (o: unknown): void => {
    if (o && typeof o === "object") {
      Object.values(o).forEach(deepFreeze);
      Object.freeze(o);
    }
  };
  deepFreeze(p);
  const a = formatSyncPlan(p);
  const b = formatSyncPlan(p);
  assert.equal(a, b);
  assert.equal(typeof a, "string");
});

// ── 2. valid plans never throw across the matrix ───────────────────
test("formatSyncPlan completes for every combination of empty/populated sections and health", () => {
  const combos: SyncPlan[] = [
    fullPlan(),
    fullPlan({ stats: { status: "failed", healthy: false }, reconciliation: { reconciled: false, skippedReason: "run failed — reconciliation skipped, no records touched" } }),
    fullPlan({ stats: { status: "degraded", healthy: false }, reconciliation: { reconciled: false, skippedReason: "run degraded / unhealthy — reconciliation skipped" } }),
    fullPlan({ upserts: [upsert("venue", "insert"), upsert("venue", "update"), upsert("event", "skip")] }),
    fullPlan({ reviewItems: [reviewItem({ record: venueRec("V") }), reviewItem({ record: eventRec("E") })] }),
    fullPlan({ stats: { notes: ["a", "b", "c"] } }),
    fullPlan({ stats: { byChangeStatus: { NEW: 1, UPDATED: 2, UNCHANGED: 3, STALE: 4, MISSING: 5, GONE: 6, REJECTED: 7, NEEDS_REVIEW: 8 } } }),
  ];
  for (const p of combos) assert.equal(typeof formatSyncPlan(p), "string");
});

// ── 3. header rendering ────────────────────────────────────────────
test("header renders sourceKey / runId / mode / scope / status(uppercased) / healthy / durationMs", () => {
  const t = formatSyncPlan(fullPlan({
    run: { sourceKey: "osm", runId: "run-42", mode: "apply", scope: { countries: ["RS", "HR"], cities: ["Belgrade", "Zagreb"] } },
    stats: { status: "degraded", healthy: false, durationMs: 1234 },
  }));
  assert.match(t, /SYNC PLAN — osm {2}\(run run-42\) {2}\[apply\]/);
  assert.match(t, /scope: countries=RS,HR cities=Belgrade,Zagreb/);
  assert.match(t, /status: DEGRADED {2}healthy=false {2}\(1234ms\)/);
});

test("header tolerates spaces / punctuation / Unicode in identifier-ish fields without throwing", () => {
  const t = formatSyncPlan(fullPlan({
    run: { sourceKey: "src — tẃo", runId: "id/with space", scope: { countries: [], cities: [] } },
    stats: { notes: ["café ☕ note", "line-with-dash"] },
  }));
  assert.match(t, /SYNC PLAN — src — tẃo {2}\(run id\/with space\)/);
  assert.match(t, /countries=\(all\) cities=\(all\)/);
  assert.match(t, /- café ☕ note/);
});

// ── 4. discovery/fetch/parse field mapping (distinct values, no swap) ─
test("each discovery/fetch/parse counter renders from its own field", () => {
  const t = formatSyncPlan(fullPlan({
    stats: { discovered: 11, fetched: 22, fetchFailed: 33, parsed: 44, parseFailed: 55 },
  }));
  assert.match(t, /discovered {4}11 {3}fetched {4}22 {3}fetchFailed {4}33/);
  assert.match(t, /parsed {8}44 {3}parseFailed {4}55/);
});

// ── 5. change-status rendering ─────────────────────────────────────
test("change status: positives shown in lifecycle order; zeros omitted; nothing lost", () => {
  const t = formatSyncPlan(fullPlan({
    stats: { byChangeStatus: { NEW: 3, UPDATED: 0, UNCHANGED: 7, STALE: 0, MISSING: 0, GONE: 1, REJECTED: 0, NEEDS_REVIEW: 2 } },
  }));
  const lines = t.split("\n").filter((l) => /^ {4}(NEW|UPDATED|UNCHANGED|STALE|MISSING|GONE|REJECTED|NEEDS_REVIEW)\b/.test(l));
  assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)), [
    ["NEW", "3"], ["UNCHANGED", "7"], ["GONE", "1"], ["NEEDS_REVIEW", "2"],
  ]);
});

test("all-zero change status -> the section header prints but no status rows", () => {
  const t = formatSyncPlan(fullPlan());
  assert.match(t, /^ {2}change status$/m);
  assert.doesNotMatch(t, /^ {4}(NEW|UPDATED|UNCHANGED|STALE|MISSING|GONE|REJECTED|NEEDS_REVIEW)\b/m);
});

// ── 6. identity counts ────────────────────────────────────────────
test("identity block renders venuesMatched / venuesNew / eventsMatched / eventsNew / reviewItems from their own fields", () => {
  const t = formatSyncPlan(fullPlan({
    stats: { venuesMatched: 1, venuesNew: 2, eventsMatched: 3, eventsNew: 4, reviewItems: 9 },
  }));
  assert.match(t, /venues: matched 1 {2}new 2/);
  assert.match(t, /events: matched 3 {2}new 4/);
  assert.match(t, /review items: 9/);
});

// ── 7. upsert aggregation ────────────────────────────────────────
test("upserts aggregate by `kind:operation`, stay separate across combos, and render sorted", () => {
  const t = formatSyncPlan(fullPlan({
    upserts: [
      upsert("venue", "insert"), upsert("venue", "insert"), upsert("venue", "insert"),
      upsert("event", "link-only"), upsert("event", "link-only"),
      upsert("venue", "update"),
    ],
  }));
  const rows = t.split("\n").filter((l) => /^ {4}(venue|event):/.test(l)).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rows, [
    ["event:link-only", "2"],
    ["venue:insert", "3"],
    ["venue:update", "1"],
  ]);
});

test("zero upserts -> the section header prints with no rows and no NaN", () => {
  const t = formatSyncPlan(fullPlan());
  assert.match(t, /canonical upserts \(nothing written — plan only\)/);
  assert.doesNotMatch(t, /^ {4}(venue|event):/m);
  assert.doesNotMatch(t, /NaN|undefined/);
});

// ── 8. reconciliation rendering ──────────────────────────────────
test("reconciliation: RECONCILED vs SKIPPED, skippedReason only when non-null", () => {
  assert.match(formatSyncPlan(fullPlan({ reconciliation: { reconciled: true, skippedReason: null } })), /reconciliation: RECONCILED$/m);
  assert.match(
    formatSyncPlan(fullPlan({ reconciliation: { reconciled: false, skippedReason: "run failed — reconciliation skipped" } })),
    /reconciliation: SKIPPED — run failed — reconciliation skipped/,
  );
  assert.match(formatSyncPlan(fullPlan({ reconciliation: { reconciled: false, skippedReason: null } })), /reconciliation: SKIPPED$/m);
});

test("only mark-stale/mark-missing/mark-gone actions render; keep-active & no-op are hidden; order preserved", () => {
  const t = formatSyncPlan(fullPlan({
    reconciliation: {
      actions: [
        reconAction({ key: "s:A", transition: "keep-active" }),
        reconAction({ key: "s:B", transition: "mark-gone", kind: "event", misses: 3, note: "source dropped it" }),
        reconAction({ key: "s:C", transition: "no-op" }),
        reconAction({ key: "s:D", transition: "mark-stale", kind: "venue", misses: 1, note: "missed 1×" }),
      ],
    },
  }));
  const rows = t.split("\n").filter((l) => /^ {4}mark-/.test(l));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /mark-gone {5}event s:B \(miss 3\) — source dropped it/);
  assert.match(rows[1], /mark-stale {4}venue s:D \(miss 1\) — missed 1×/);
  assert.doesNotMatch(t, /keep-active|no-op/);
});

// ── 9. review queue ─────────────────────────────────────────────
test("review queue: header shows the TRUE count; at most 20 rows render; input order preserved", () => {
  const items = Array.from({ length: 25 }, (_, i) => reviewItem({ record: venueRec(`Venue ${i}`) }));
  const t = formatSyncPlan(fullPlan({ reviewItems: items, stats: { reviewItems: 25 } }));
  assert.match(t, /review queue \(25\)/);
  const rows = t.split("\n").filter((l) => /^ {4}\[/.test(l));
  assert.equal(rows.length, 20, "capped at 20 displayed rows");
  assert.match(rows[0], /\[venue\] Venue 0 — rc/);
  assert.match(rows[19], /\[venue\] Venue 19 — rc/);
});

test("review queue: venue uses fields.name, event uses fields.title", () => {
  const t = formatSyncPlan(fullPlan({
    reviewItems: [
      reviewItem({ record: venueRec("Дрогстор ☭") }),
      reviewItem({ record: eventRec("Boris Brejcha — Live") }),
    ],
  }));
  assert.match(t, /\[venue\] Дрогстор ☭ — rc/);
  assert.match(t, /\[event\] Boris Brejcha — Live — rc/);
});

test("[characterization] a review item whose `kind` differs from `record.kind` labels by `kind`, names by `record.kind`", () => {
  // The engine emits `kind:"venue"` review items carrying the EVENT record when
  // an event's venue identity is ambiguous (engine.ts). The renderer reads the
  // field by the RECORD's kind (type-safe) and the tag by the item's `kind`.
  const item: ReviewItem = {
    kind: "venue",
    reasonCode: "event-venue-ambiguous",
    reasons: [],
    suggestedCanonicalId: null,
    record: eventRec("Some Festival"),
  };
  const t = formatSyncPlan(fullPlan({ reviewItems: [item] }));
  assert.match(t, /\[venue\] Some Festival — event-venue-ambiguous/);
});

test("review queue: an empty-string name is rendered (not a crash)", () => {
  const t = formatSyncPlan(fullPlan({ reviewItems: [reviewItem({ record: venueRec("") })] }));
  assert.match(t, /\[venue\]\s+— rc/);
});

// ── 10. notes ───────────────────────────────────────────────────
test("notes: each rendered once, in order; multi-line note content does not throw", () => {
  const t = formatSyncPlan(fullPlan({ stats: { notes: ["first", "second\nwith newline", "third"] } }));
  assert.match(t, /^ {2}notes$/m);
  const idxFirst = t.indexOf("- first");
  const idxThird = t.indexOf("- third");
  assert.ok(idxFirst > 0 && idxThird > idxFirst);
  assert.equal(t.split("- first").length - 1, 1, "note rendered exactly once");
});

// ── 11. padding ─────────────────────────────────────────────────
test("pad(): right-aligned to width 5, never truncates a longer number, zero is not blank", () => {
  const t = formatSyncPlan(fullPlan({
    stats: { discovered: 0, fetched: 123456, fetchFailed: 7, parsed: 1000000, parseFailed: 0 },
  }));
  assert.match(t, /discovered {5}0 {3}fetched/); // pad(0,5) === "    0"
  assert.match(t, /fetched 123456 /); // longer than width -> full value, single space before
  assert.match(t, /parsed {5}1000000 {3}parseFailed/);
});

// ── 12. determinism ────────────────────────────────────────────
test("two independently-built identical plans render byte-identical", () => {
  assert.equal(formatSyncPlan(fullPlan()), formatSyncPlan(fullPlan()));
  const withData = () => fullPlan({
    upserts: [upsert("event", "insert"), upsert("venue", "insert")],
    reviewItems: [reviewItem({ record: eventRec("E") })],
    reconciliation: { actions: [reconAction({ transition: "mark-missing" })] },
    stats: { discovered: 9, notes: ["n"], byChangeStatus: { NEW: 1, UPDATED: 0, UNCHANGED: 0, STALE: 0, MISSING: 1, GONE: 0, REJECTED: 0, NEEDS_REVIEW: 0 } },
  });
  assert.equal(formatSyncPlan(withData()), formatSyncPlan(withData()));
});

test("rendering the same plan object repeatedly is stable (no accumulation / caching)", () => {
  const p = fullPlan({ upserts: [upsert("venue", "insert")], stats: { discovered: 3 } });
  const first = formatSyncPlan(p);
  for (let i = 0; i < 5; i++) assert.equal(formatSyncPlan(p), first);
});
