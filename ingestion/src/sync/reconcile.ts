/**
 * Reconciliation — pure, generic, for records NOT seen this run.
 *
 * Safety invariants (see the architecture report, section RECONCILIATION):
 *
 *  1. A FAILED run reconciles nothing. An unhealthy run (too few discovered,
 *     too many parse failures) reconciles nothing.
 *  2. Source disappearance is NEVER a cancellation. This function never emits a
 *     "cancel" transition. Explicit cancellation is an INCOMING signal handled
 *     in change detection / canonicalization, not here.
 *  3. Missing records move through a lifecycle: active → stale → missing → gone.
 *     Nothing is ever hard-deleted.
 *  4. Past events are FROZEN: always `no-op`, always retained.
 *  5. Explicitly cancelled records and records already `gone` are always
 *     `no-op` — and reconciliation NEVER reactivates them.
 *
 * Precedence (this is the part that was previously wrong): the protected states
 * in (4) and (5) are checked BEFORE `seenKeys`. A gone/cancelled record that
 * re-appears in the source stays gone/cancelled; a frozen past event that
 * re-appears is still untouched. Only a record that is NOT in a protected state
 * is subject to the seen → reset / unseen → lifecycle rules.
 */

import type {
  ReconcileAction,
  ReconciliationPlan,
  ReconciliationThresholds,
  RunStatus,
  SourceStateSnapshot,
} from "./types.ts";

export function planReconciliation(input: {
  runStatus: RunStatus;
  healthy: boolean;
  /** "sourceKey:externalId" for every record seen this run. */
  seenKeys: Set<string>;
  /** All stored source-link states for this source within the run's scope. */
  stored: SourceStateSnapshot[];
  thresholds: ReconciliationThresholds;
}): ReconciliationPlan {
  const { runStatus, healthy, seenKeys, stored, thresholds } = input;

  if (runStatus === "failed") {
    return {
      reconciled: false,
      runStatus,
      actions: [],
      skippedReason: "run failed — reconciliation skipped, no records touched",
    };
  }
  if (!healthy) {
    return {
      reconciled: false,
      runStatus,
      actions: [],
      skippedReason:
        "run degraded / unhealthy (discovery or parse-failure thresholds) — reconciliation skipped",
    };
  }

  const actions: ReconcileAction[] = [];
  for (const rec of stored) {
    // ── protected states: ALWAYS no-op, whether or not the record was seen ──
    // Reconciliation must never resurrect these.
    if (rec.frozen) {
      actions.push(action(rec, "no-op", rec.consecutiveMisses, "past event — frozen, retained"));
      continue;
    }
    if (rec.cancelled) {
      actions.push(
        action(rec, "no-op", rec.consecutiveMisses, "explicitly cancelled — retained, never reactivated"),
      );
      continue;
    }
    if (rec.sourceStatus === "gone") {
      actions.push(
        action(rec, "no-op", rec.consecutiveMisses, "already gone — retained, never reactivated"),
      );
      continue;
    }

    // ── not protected: seen resets to active; unseen progresses the lifecycle ──
    if (seenKeys.has(rec.key)) {
      actions.push(action(rec, "keep-active", 0, "seen again — reset to active, misses cleared"));
      continue;
    }

    const misses = rec.consecutiveMisses + 1;
    if (misses >= thresholds.goneAfterMisses) {
      actions.push(action(rec, "mark-gone", misses, `missed ${misses}× — source dropped it`));
    } else if (misses >= thresholds.missingAfterMisses) {
      actions.push(action(rec, "mark-missing", misses, `missed ${misses}×`));
    } else if (misses >= thresholds.staleAfterMisses) {
      actions.push(action(rec, "mark-stale", misses, `missed ${misses}×`));
    } else {
      actions.push(action(rec, "keep-active", misses, `missed ${misses}× — below stale threshold`));
    }
  }

  return { reconciled: true, runStatus, actions, skippedReason: null };
}

function action(
  rec: SourceStateSnapshot,
  transition: ReconcileAction["transition"],
  misses: number,
  note: string,
): ReconcileAction {
  return {
    key: rec.key,
    canonicalId: rec.canonicalId,
    kind: rec.kind,
    from: rec.sourceStatus,
    transition,
    misses,
    note,
  };
}
