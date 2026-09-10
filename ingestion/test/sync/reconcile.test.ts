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

// ═════════════════════════════════════════════════════════════════════
//  AUDIT PASS — safety-invariant & lifecycle characterization
//  (all tests below pass against the current implementation)
// ═════════════════════════════════════════════════════════════════════

const RATIOS = {
  minDiscoveryRatio: DEFAULT_RECONCILIATION.minDiscoveryRatio,
  maxParseFailureRatio: DEFAULT_RECONCILIATION.maxParseFailureRatio,
};
/** A validated strictly-ascending threshold set with clean gaps. */
function thr(stale: number, missing: number, gone: number): ReconciliationThresholds {
  const t = { staleAfterMisses: stale, missingAfterMisses: missing, goneAfterMisses: gone, ...RATIOS };
  assertValidReconciliationThresholds(t);
  return t;
}
function plan(over: {
  runStatus?: "ok" | "degraded" | "failed";
  healthy?: boolean;
  seen?: string[];
  stored: SourceStateSnapshot[];
  thresholds?: ReconciliationThresholds;
}) {
  return planReconciliation({
    runStatus: over.runStatus ?? "ok",
    healthy: over.healthy ?? true,
    seenKeys: new Set(over.seen ?? []),
    stored: over.stored,
    thresholds: over.thresholds ?? T,
  });
}
const VALID_TRANSITIONS = new Set(["keep-active", "mark-stale", "mark-missing", "mark-gone", "no-op"]);

// ── 1. FAILED / UNHEALTHY: nothing is inspected, nothing is emitted ──
test("failed/unhealthy: NOT ONE action is emitted, not even a no-op for protected records", () => {
  const stored = [
    snap({ key: "s:A", frozen: true }),
    snap({ key: "s:B", cancelled: true }),
    snap({ key: "s:C", sourceStatus: "gone", consecutiveMisses: 4 }),
    snap({ key: "s:D", sourceStatus: "active", consecutiveMisses: 8 }),
  ];
  for (const [runStatus, healthy] of [
    ["failed", false], ["failed", true], ["degraded", false], ["ok", false],
  ] as const) {
    const p = planReconciliation({
      runStatus, healthy, seenKeys: new Set(["s:A", "s:D"]), stored, thresholds: T,
    });
    assert.equal(p.reconciled, false);
    assert.deepEqual(p.actions, []);
    assert.equal(typeof p.skippedReason, "string");
    assert.ok((p.skippedReason ?? "").length > 0);
  }
});

test("failed run keeps the FAILED skip reason; a healthy=false non-failed run gets the degraded reason", () => {
  assert.match(
    planReconciliation({ runStatus: "failed", healthy: false, seenKeys: new Set(), stored: [snap()], thresholds: T }).skippedReason ?? "",
    /failed/,
  );
  assert.match(
    planReconciliation({ runStatus: "degraded", healthy: false, seenKeys: new Set(), stored: [snap()], thresholds: T }).skippedReason ?? "",
    /degraded|unhealthy/,
  );
  assert.match(
    planReconciliation({ runStatus: "ok", healthy: false, seenKeys: new Set(), stored: [snap()], thresholds: T }).skippedReason ?? "",
    /degraded|unhealthy/,
  );
});

// ── 2. PROTECTED-STATE PRECEDENCE — full 2×3 matrix ──────────────────
test("every protected state × {seen, unseen} is a no-op that PRESERVES consecutiveMisses (no +1, no reset)", () => {
  const protectedOvers: Array<[string, Partial<SourceStateSnapshot>]> = [
    ["frozen", { frozen: true, sourceStatus: "active" }],
    ["cancelled", { cancelled: true, sourceStatus: "stale" }],
    ["gone", { sourceStatus: "gone" }],
  ];
  for (const [label, over] of protectedOvers) {
    for (const seen of [true, false]) {
      const misses = 5;
      const p = plan({
        seen: seen ? ["gigstix:E1"] : [],
        stored: [snap({ ...over, consecutiveMisses: misses })],
      });
      const a = p.actions[0];
      assert.equal(a.transition, "no-op", `${label} + ${seen ? "seen" : "unseen"}`);
      assert.equal(a.misses, misses, `${label} + ${seen ? "seen" : "unseen"}: misses preserved verbatim`);
      assert.notEqual(a.transition, "keep-active");
    }
  }
});

test("frozen wins over cancelled wins over gone (precedence within the protected block)", () => {
  // frozen + cancelled + gone all true -> frozen note
  const bothFrozen = plan({ stored: [snap({ frozen: true, cancelled: true, sourceStatus: "gone", consecutiveMisses: 2 })] }).actions[0];
  assert.equal(bothFrozen.transition, "no-op");
  assert.match(bothFrozen.note, /frozen|past/);
  // cancelled + gone (not frozen) -> cancelled note
  const cancelledGone = plan({ stored: [snap({ cancelled: true, sourceStatus: "gone" })] }).actions[0];
  assert.equal(cancelledGone.transition, "no-op");
  assert.match(cancelledGone.note, /cancel/);
  assert.equal(cancelledGone.from, "gone", "`from` still reflects the stored sourceStatus");
});

// ── 3. SEEN, non-protected: always keep-active, misses -> 0 ──────────
test("a seen non-protected record resets to keep-active/0 regardless of prior sourceStatus or miss count", () => {
  for (const sourceStatus of ["active", "stale", "missing"] as const) {
    for (const consecutiveMisses of [0, 1, 2, 9, 999]) {
      const a = plan({ seen: ["gigstix:E1"], stored: [snap({ sourceStatus, consecutiveMisses })] }).actions[0];
      assert.equal(a.transition, "keep-active", `${sourceStatus}/${consecutiveMisses}`);
      assert.equal(a.misses, 0, `${sourceStatus}/${consecutiveMisses}`);
      assert.equal(a.from, sourceStatus, "`from` is the ORIGINAL stored status, not the destination");
    }
  }
});

// ── 4. UNSEEN lifecycle — exact threshold boundaries ────────────────
test("unseen threshold boundaries with thr(2,4,6): each band maps to exactly one transition", () => {
  const t = thr(2, 4, 6);
  // misses = consecutiveMisses + 1
  const cases: Array<[number, string]> = [
    [0, "keep-active"], // misses 1  < stale 2
    [1, "mark-stale"], //  misses 2  == stale
    [2, "mark-stale"], //  misses 3  in [stale, missing)
    [3, "mark-missing"], // misses 4  == missing
    [4, "mark-missing"], // misses 5  in [missing, gone)
    [5, "mark-gone"], //    misses 6  == gone
    [6, "mark-gone"], //    misses 7  > gone
    [500, "mark-gone"], //  large finite
  ];
  for (const [consecutiveMisses, want] of cases) {
    const a = plan({ seen: [], stored: [snap({ sourceStatus: "active", consecutiveMisses })], thresholds: t }).actions[0];
    assert.equal(a.transition, want, `consecutiveMisses=${consecutiveMisses} (misses=${consecutiveMisses + 1})`);
    assert.equal(a.misses, consecutiveMisses + 1, "the action reports misses = stored + 1");
  }
});

test("smallest legal thresholds thr(1,2,3): first miss -> stale, second -> missing, third -> gone", () => {
  const t = thr(1, 2, 3);
  assert.equal(plan({ stored: [snap({ consecutiveMisses: 0 })], thresholds: t }).actions[0].transition, "mark-stale");
  assert.equal(plan({ stored: [snap({ consecutiveMisses: 1 })], thresholds: t }).actions[0].transition, "mark-missing");
  assert.equal(plan({ stored: [snap({ consecutiveMisses: 2 })], thresholds: t }).actions[0].transition, "mark-gone");
});

test("driving misses back run-over-run walks keep-active -> mark-stale -> mark-missing -> mark-gone with NO skipped state", () => {
  const t = thr(2, 4, 6);
  let consecutiveMisses = 0;
  const seq: string[] = [];
  for (let run = 0; run < 8; run++) {
    const a = plan({ seen: [], stored: [snap({ sourceStatus: "active", consecutiveMisses })], thresholds: t }).actions[0];
    seq.push(a.transition);
    consecutiveMisses = a.misses; // engine persists action.misses as the new consecutiveMisses
  }
  assert.deepEqual(seq, [
    "keep-active", "mark-stale", "mark-stale", "mark-missing",
    "mark-missing", "mark-gone", "mark-gone", "mark-gone",
  ]);
});

test("a record already 'missing' never regresses to mark-stale on a further miss (misses is monotonic)", () => {
  // 'missing' => consecutiveMisses >= missingAfterMisses, so misses > missingAfterMisses always.
  for (const t of [thr(1, 2, 3), thr(2, 4, 6), thr(1, 3, 9)]) {
    const a = plan({
      seen: [],
      stored: [snap({ sourceStatus: "missing", consecutiveMisses: t.missingAfterMisses })],
      thresholds: t,
    }).actions[0];
    assert.ok(a.transition === "mark-missing" || a.transition === "mark-gone", `${JSON.stringify(t)} -> ${a.transition}`);
  }
});

// ── 8. ACTION CORRECTNESS — every field, every transition ───────────
test("action fields are complete and correct for each transition kind", () => {
  const base = { key: "gigstix:E1", canonicalId: "ev-1", kind: "event" as const };

  const seen = plan({ seen: ["gigstix:E1"], stored: [snap({ sourceStatus: "stale", consecutiveMisses: 2 })] }).actions[0];
  assert.deepEqual(seen, { ...base, from: "stale", transition: "keep-active", misses: 0, note: seen.note });
  assert.ok(seen.note.length > 0);

  const belowStale = plan({ stored: [snap({ sourceStatus: "active", consecutiveMisses: 0 })], thresholds: thr(3, 5, 7) }).actions[0];
  assert.deepEqual(belowStale, { ...base, from: "active", transition: "keep-active", misses: 1, note: belowStale.note });

  const stale = plan({ stored: [snap({ sourceStatus: "active", consecutiveMisses: 0 })] }).actions[0];
  assert.deepEqual(stale, { ...base, from: "active", transition: "mark-stale", misses: 1, note: stale.note });

  const missing = plan({ stored: [snap({ sourceStatus: "stale", consecutiveMisses: 1 })] }).actions[0];
  assert.deepEqual(missing, { ...base, from: "stale", transition: "mark-missing", misses: 2, note: missing.note });

  const gone = plan({ stored: [snap({ sourceStatus: "missing", consecutiveMisses: 2 })] }).actions[0];
  assert.deepEqual(gone, { ...base, from: "missing", transition: "mark-gone", misses: 3, note: gone.note });

  const frozen = plan({ stored: [snap({ frozen: true, sourceStatus: "active", consecutiveMisses: 4 })] }).actions[0];
  assert.deepEqual(frozen, { ...base, from: "active", transition: "no-op", misses: 4, note: frozen.note });

  const goneNoop = plan({ stored: [snap({ sourceStatus: "gone", consecutiveMisses: 6 })] }).actions[0];
  assert.deepEqual(goneNoop, { ...base, from: "gone", transition: "no-op", misses: 6, note: goneNoop.note });
});

// ── 12. CANCELLATION SEMANTICS ─────────────────────────────────────
test("no action can ever carry a cancellation transition; disappearance stays a lifecycle move", () => {
  const stored = [
    snap({ key: "s:1", sourceStatus: "active", consecutiveMisses: 0 }),
    snap({ key: "s:2", sourceStatus: "stale", consecutiveMisses: 1 }),
    snap({ key: "s:3", sourceStatus: "missing", consecutiveMisses: 2 }),
    snap({ key: "s:4", sourceStatus: "gone", consecutiveMisses: 5 }),
    snap({ key: "s:5", frozen: true }),
    snap({ key: "s:6", cancelled: true }),
    snap({ key: "s:7", sourceStatus: "active", consecutiveMisses: 0 }), // will be seen
  ];
  const p = planReconciliation({ runStatus: "ok", healthy: true, seenKeys: new Set(["s:7"]), stored, thresholds: T });
  for (const a of p.actions) {
    assert.ok(VALID_TRANSITIONS.has(a.transition), a.transition);
    assert.notEqual(a.transition as string, "cancel");
    // only the explicitly-cancelled record's note may contain the word "cancel"
    if (a.key !== "s:6") assert.doesNotMatch(a.note.toLowerCase(), /cancel/, a.key);
  }
});

// ── 7 & 10. PURITY / DETERMINISM / ORDER ───────────────────────────
test("planReconciliation does not mutate input, stored records, seenKeys, or thresholds (deep-frozen)", () => {
  const stored = [
    snap({ key: "s:1", sourceStatus: "active", consecutiveMisses: 0 }),
    snap({ key: "s:2", sourceStatus: "gone", consecutiveMisses: 4 }),
  ];
  stored.forEach((s) => Object.freeze(s));
  Object.freeze(stored);
  const seenKeys = new Set(["s:1"]);
  const thresholds = Object.freeze({ ...T });
  const input = Object.freeze({ runStatus: "ok" as const, healthy: true, seenKeys, stored, thresholds });

  assert.doesNotThrow(() => planReconciliation(input));
  assert.equal(stored[0].consecutiveMisses, 0);
  assert.equal(stored[1].consecutiveMisses, 4);
  assert.equal(seenKeys.size, 1);
});

test("deterministic: identical input yields deep-equal actions across repeated calls", () => {
  const mk = () =>
    planReconciliation({
      runStatus: "ok",
      healthy: true,
      seenKeys: new Set(["s:2"]),
      stored: [
        snap({ key: "s:1", sourceStatus: "active", consecutiveMisses: 1 }),
        snap({ key: "s:2", sourceStatus: "stale", consecutiveMisses: 2 }),
        snap({ key: "s:3", frozen: true, consecutiveMisses: 3 }),
      ],
      thresholds: T,
    });
  assert.deepEqual(mk().actions, mk().actions);
});

test("action order follows stored input order exactly (no sorting, no grouping)", () => {
  const order = ["s:C", "s:A", "s:D", "s:B"];
  const p = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: new Set(["s:A"]),
    stored: order.map((key) => snap({ key, sourceStatus: "active", consecutiveMisses: 0 })),
    thresholds: T,
  });
  assert.deepEqual(p.actions.map((a) => a.key), order);
});

// ── 9. SCOPE ──────────────────────────────────────────────────────
test("only `stored` records produce actions — extra seenKeys are ignored, nothing is fabricated", () => {
  const p = planReconciliation({
    runStatus: "ok",
    healthy: true,
    seenKeys: new Set(["ghost:1", "ghost:2", "gigstix:E1"]),
    stored: [snap({ key: "gigstix:E1" })],
    thresholds: T,
  });
  assert.equal(p.actions.length, 1);
  assert.equal(p.actions[0].key, "gigstix:E1");
});

test("empty stored -> reconciled:true with an empty action list (a healthy run that had nothing to reconcile)", () => {
  const p = planReconciliation({ runStatus: "ok", healthy: true, seenKeys: new Set(), stored: [], thresholds: T });
  assert.equal(p.reconciled, true);
  assert.deepEqual(p.actions, []);
  assert.equal(p.skippedReason, null);
});

// ── PRECONDITION characterization (caller contract, not a bug) ──────
test("[precondition] runStatus 'degraded' with healthy:true DOES reconcile — the function trusts `healthy`", () => {
  // The engine ALWAYS sets healthy=false whenever it sets status to degraded
  // (engine.ts). This combination therefore never occurs in practice; the test
  // documents that reconcile.ts gates on `healthy`, not on `runStatus` spelling.
  const p = planReconciliation({
    runStatus: "degraded",
    healthy: true,
    seenKeys: new Set(),
    stored: [snap({ sourceStatus: "active", consecutiveMisses: 1 })],
    thresholds: T,
  });
  assert.equal(p.reconciled, true);
  assert.equal(p.actions[0].transition, "mark-missing");
});
