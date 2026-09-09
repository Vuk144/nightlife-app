import { test } from "node:test";
import assert from "node:assert/strict";
import { planReconciliation } from "../../src/sync/reconcile.ts";
import {
  assertValidReconciliationThresholds,
  DEFAULT_RECONCILIATION,
  InMemoryConfigProvider,
  type SyncConfig,
} from "../../src/sync/config.ts";
import type { ReconciliationThresholds, SourceStateSnapshot } from "../../src/sync/types.ts";

function snap(over: Partial<SourceStateSnapshot> = {}): SourceStateSnapshot {
  return {
    key: "gigstix:E1",
    sourceKey: "gigstix",
    externalId: "E1",
    canonicalId: "ev-1",
    kind: "event",
    sourceStatus: "active",
    consecutiveMisses: 0,
    frozen: false,
    cancelled: false,
    ...over,
  };
}

const T = DEFAULT_RECONCILIATION;
const SEEN = new Set(["gigstix:E1"]);

/** Run one snapshot through reconciliation on a healthy run; return its action. */
function reconcileOne(over: Partial<SourceStateSnapshot>, seen: boolean) {
  const plan = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: seen ? SEEN : new Set<string>(),
    stored: [snap(over)],
    thresholds: T,
  });
  assert.equal(plan.reconciled, true);
  assert.equal(plan.actions.length, 1);
  return plan.actions[0];
}

test("a FAILED run reconciles nothing", () => {
  const plan = planReconciliation({
    runStatus: "failed",
    healthy: false,
    seenKeys: new Set(),
    stored: [snap()],
    thresholds: T,
  });
  assert.equal(plan.reconciled, false);
  assert.deepEqual(plan.actions, []);
  assert.match(plan.skippedReason ?? "", /failed/);
});

test("an UNHEALTHY (degraded) run reconciles nothing", () => {
  const plan = planReconciliation({
    runStatus: "degraded",
    healthy: false,
    seenKeys: new Set(),
    stored: [snap()],
    thresholds: T,
  });
  assert.equal(plan.reconciled, false);
  assert.deepEqual(plan.actions, []);
});

test("missing record moves active -> stale -> missing -> gone across runs", () => {
  let misses = 0;
  let status: SourceStateSnapshot["sourceStatus"] = "active";
  const expected = ["mark-stale", "mark-missing", "mark-gone"] as const;
  for (const want of expected) {
    const plan = planReconciliation({
      runStatus: "ok",
      healthy: true,
      seenKeys: new Set(),
      stored: [snap({ consecutiveMisses: misses, sourceStatus: status })],
      thresholds: T,
    });
    assert.equal(plan.reconciled, true);
    assert.equal(plan.actions[0].transition, want);
    misses = plan.actions[0].misses;
    status =
      want === "mark-stale" ? "stale" : want === "mark-missing" ? "missing" : "gone";
  }
});

test("disappearance NEVER emits a cancel — only lifecycle transitions", () => {
  const plan = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: new Set(),
    stored: [snap({ consecutiveMisses: 5 })],
    thresholds: T,
  });
  for (const a of plan.actions) {
    assert.ok(["keep-active", "mark-stale", "mark-missing", "mark-gone", "no-op"].includes(a.transition));
    assert.doesNotMatch(a.note.toLowerCase(), /cancel/);
  }
});

test("past events are frozen — no-op, always retained", () => {
  const plan = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: new Set(),
    stored: [snap({ frozen: true, consecutiveMisses: 9 })],
    thresholds: T,
  });
  assert.equal(plan.actions[0].transition, "no-op");
  assert.match(plan.actions[0].note, /past/);
});

test("explicitly cancelled records are retained (no-op)", () => {
  const plan = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: new Set(),
    stored: [snap({ cancelled: true })],
    thresholds: T,
  });
  assert.equal(plan.actions[0].transition, "no-op");
});

test("a record seen again is reset to active", () => {
  const plan = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: new Set(["gigstix:E1"]),
    stored: [snap({ sourceStatus: "stale", consecutiveMisses: 2 })],
    thresholds: T,
  });
  assert.equal(plan.actions[0].transition, "keep-active");
  assert.equal(plan.actions[0].misses, 0);
});

// ─────────────────────────────────────────────────────────────────────
//  ORDERING REGRESSION: protected states are checked BEFORE `seenKeys`.
//  Previously a gone/cancelled record that re-appeared was flipped back to
//  `keep-active`, and a frozen event that re-appeared could get keep-active.
// ─────────────────────────────────────────────────────────────────────

test("(a) gone + seen -> no-op, stays gone; reconciliation never reactivates it", () => {
  const a = reconcileOne({ sourceStatus: "gone", consecutiveMisses: 7 }, true);
  assert.equal(a.transition, "no-op");
  assert.equal(a.from, "gone", "still gone");
  assert.equal(a.misses, 7, "miss count preserved, not reset");
  assert.notEqual(a.transition, "keep-active");
});

test("(b) cancelled + seen -> no-op; reconciliation never un-cancels / reactivates", () => {
  const a = reconcileOne({ cancelled: true, sourceStatus: "stale", consecutiveMisses: 3 }, true);
  assert.equal(a.transition, "no-op");
  assert.notEqual(a.transition, "keep-active");
  assert.equal(a.misses, 3, "miss count preserved, not reset");
});

test("(c) frozen + seen -> no-op (frozen wins over 'seen', any prior status)", () => {
  for (const sourceStatus of ["active", "stale", "missing"] as const) {
    const a = reconcileOne({ frozen: true, sourceStatus, consecutiveMisses: 4 }, true);
    assert.equal(a.transition, "no-op", `frozen + seen + ${sourceStatus}`);
    assert.match(a.note, /frozen/);
  }
});

test("(d) active + seen -> keep-active with misses reset to 0", () => {
  const zero = reconcileOne({ sourceStatus: "active", consecutiveMisses: 0 }, true);
  assert.equal(zero.transition, "keep-active");
  assert.equal(zero.misses, 0);

  const withMiss = reconcileOne({ sourceStatus: "active", consecutiveMisses: 1 }, true);
  assert.equal(withMiss.transition, "keep-active");
  assert.equal(withMiss.misses, 0, "consecutive misses cleared");
});

test("(e) stale + seen -> keep-active with misses reset to 0", () => {
  const a = reconcileOne({ sourceStatus: "stale", consecutiveMisses: 2 }, true);
  assert.equal(a.transition, "keep-active");
  assert.equal(a.misses, 0);
});

test("(f) active + NOT seen -> miss progression still works (stale threshold)", () => {
  const a = reconcileOne({ sourceStatus: "active", consecutiveMisses: 0 }, false);
  assert.equal(a.transition, "mark-stale");
  assert.equal(a.misses, 1);
});

test("(g) failed OR unhealthy run -> zero reconciliation actions, even for seen records", () => {
  for (const [runStatus, healthy] of [
    ["failed", false],
    ["failed", true],
    ["degraded", false],
    ["ok", false],
  ] as const) {
    const plan = planReconciliation({
      runStatus,
      healthy,
      seenKeys: SEEN,
      stored: [snap(), snap({ key: "gigstix:E2", cancelled: true }), snap({ key: "gigstix:E3", sourceStatus: "gone" })],
      thresholds: T,
    });
    assert.equal(plan.reconciled, false, `${runStatus}/${healthy}`);
    assert.deepEqual(plan.actions, [], `${runStatus}/${healthy}`);
  }
});

test("a gone record that re-appears is NOT flipped back to active (the ordering bug)", () => {
  const plan = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: new Set(["gigstix:E1", "gigstix:E2"]),
    stored: [
      snap({ key: "gigstix:E1", sourceStatus: "gone", consecutiveMisses: 9 }),
      snap({ key: "gigstix:E2", cancelled: true }),
    ],
    thresholds: T,
  });
  assert.ok(
    plan.actions.every((a) => a.transition === "no-op"),
    `every protected+seen record must be no-op, got ${JSON.stringify(plan.actions.map((a) => a.transition))}`,
  );
});

// ─────────────────────────────────────────────────────────────────────
//  THRESHOLD CONTRACT: strictly-ascending positive integers, validated
//  in the generic config layer (never normalized, never guarded in
//  reconcile.ts).
// ─────────────────────────────────────────────────────────────────────

test("assertValidReconciliationThresholds accepts the default and rejects bad orderings", () => {
  assert.doesNotThrow(() => assertValidReconciliationThresholds(DEFAULT_RECONCILIATION));

  const bad: Partial<ReconciliationThresholds>[] = [
    { staleAfterMisses: 2, missingAfterMisses: 2, goneAfterMisses: 3 }, // not strictly ascending
    { staleAfterMisses: 3, missingAfterMisses: 2, goneAfterMisses: 1 }, // descending
    { staleAfterMisses: 1, missingAfterMisses: 5, goneAfterMisses: 5 }, // equal at the top
    { staleAfterMisses: 0, missingAfterMisses: 1, goneAfterMisses: 2 }, // < 1
    { staleAfterMisses: -1, missingAfterMisses: 2, goneAfterMisses: 3 }, // negative
    { staleAfterMisses: 1.5, missingAfterMisses: 2, goneAfterMisses: 3 }, // non-integer
  ];
  for (const over of bad) {
    assert.throws(
      () => assertValidReconciliationThresholds({ ...DEFAULT_RECONCILIATION, ...over }),
      /reconciliation/,
      JSON.stringify(over),
    );
  }
});

test("InMemoryConfigProvider rejects an invalid reconciliation-threshold ordering at construction", () => {
  const base: SyncConfig = {
    countries: [],
    cities: [],
    sources: [],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  };
  assert.doesNotThrow(() => new InMemoryConfigProvider(base));
  assert.throws(
    () =>
      new InMemoryConfigProvider({
        ...base,
        reconciliation: { ...DEFAULT_RECONCILIATION, missingAfterMisses: 9 }, // > goneAfterMisses
      }),
    /strictly ascending/,
  );
});
