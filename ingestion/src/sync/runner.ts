/**
 * One sync run for one source: `planSync` → (optionally) `CanonicalStore.apply`.
 *
 * Pure composition — no sync logic of its own:
 *   - planning is `./engine.ts#planSync` (reads only)
 *   - the ONLY write boundary is `store.apply(plan, { commit: true })`, called
 *     at most once, and only in `"commit"` mode for a plan that passed
 *     `commitRefusal`. `"plan"` mode never calls `apply` at all.
 *
 * Source-agnostic: the OSM specifics (targets, adapter, Supabase client) are
 * wired by the caller (`./osm-cli.ts`).
 */

import { planSync, type PlanSyncInput } from "./engine.ts";
import { formatSyncPlan } from "./report.ts";
import type { SyncApplyResult, SyncPlan } from "./types.ts";

/** `"plan"` = read-only (the default everywhere); `"commit"` = apply the plan. */
export type SyncMode = "plan" | "commit";

export interface RunSyncInput extends PlanSyncInput {
  mode: SyncMode;
}

export interface RunSyncOutcome {
  mode: SyncMode;
  plan: SyncPlan;
  /**
   * Venue rows ALREADY linked to this source before the run, counted only in
   * the cities this run covers (`config.citiesInScope`). A non-zero baseline is
   * normal (e.g. an earlier import). Informational only — read-only, never
   * blocks a commit. `null` when the source does not sync venues.
   */
  baseline: { venues: number; cities: string[] } | null;
  /** The apply result — `null` when nothing was applied (plan mode, or refused). */
  apply: SyncApplyResult | null;
  /** Why a `"commit"` run did NOT apply its plan; `null` otherwise. */
  commitRefused: string | null;
}

/**
 * Why a plan must not be applied, or `null` when it may be. A failed or
 * unhealthy run (discovery failure, fetch/parse failure ratios, a failed /
 * empty / collapsed snapshot) is not a trustworthy picture of the source —
 * nothing from it is written.
 */
export function commitRefusal(plan: SyncPlan): string | null {
  const s = plan.stats;
  if (s.status === "failed") return "run FAILED — nothing applied";
  if (s.status !== "ok" || !s.healthy) {
    return `run ${s.status.toUpperCase()} / unhealthy — nothing applied (see notes)`;
  }
  return null;
}

/**
 * `RunSyncOutcome.baseline`: this source's venue links whose venue is in a
 * city in scope. The city row is resolved exactly as the engine does
 * (`listCities(country)` + canonical name); reads only.
 */
async function baselineInScope(input: RunSyncInput): Promise<RunSyncOutcome["baseline"]> {
  if (!input.source.kinds.includes("venue")) return null;
  const linked = new Set(
    (await input.store.listSourceLinks("venue", input.source.key)).map((l) => l.canonicalId),
  );
  let venues = 0;
  const cities: string[] = [];
  for (const city of input.config.citiesInScope(input.source)) {
    cities.push(city.canonicalName);
    const row = (await input.store.listCities(city.countryCode)).find((c) => c.name === city.canonicalName);
    if (!row) continue;
    for (const v of await input.store.listVenuesInCity(row.id)) if (linked.has(v.id)) venues++;
  }
  return { venues, cities };
}

export async function runSync(input: RunSyncInput): Promise<RunSyncOutcome> {
  const baseline = await baselineInScope(input);

  const plan = await planSync(input);
  if (input.mode !== "commit") {
    return { mode: input.mode, plan, baseline, apply: null, commitRefused: null };
  }

  const refused = commitRefusal(plan);
  if (refused) return { mode: input.mode, plan, baseline, apply: null, commitRefused: refused };

  const apply = await input.store.apply(plan, { commit: true });
  return { mode: input.mode, plan, baseline, apply, commitRefused: null };
}

/** Did the run end the way it should (exit code 0)? */
export function runSucceeded(outcome: RunSyncOutcome): boolean {
  if (outcome.mode === "plan") return outcome.plan.stats.status !== "failed";
  return outcome.apply != null && outcome.apply.committed && outcome.apply.error == null;
}

function count(n: number): string {
  return String(n).padStart(5);
}

/**
 * The full CLI report: a mode banner, the existing `formatSyncPlan` body, a
 * summary, and — in commit mode — the apply result.
 */
export function formatRunReport(outcome: RunSyncOutcome, targets: string[]): string {
  const { plan } = outcome;
  const s = plan.stats;
  const commit = outcome.mode === "commit";
  const ops = (op: string) => plan.upserts.filter((u) => u.operation === op).length;
  const out: string[] = [];

  out.push("");
  out.push("════════════════════════════════════════════════════════════");
  out.push(commit ? "MODE: COMMIT — the plan below is applied to the database" : "MODE: PLAN ONLY");
  out.push(commit ? "DATABASE WRITES: via CanonicalStore.apply (result below)" : "DATABASE WRITES: 0");
  out.push(`source:  ${plan.run.sourceKey}`);
  out.push(`targets: ${targets.join("; ") || "(none)"}`);
  if (outcome.baseline) {
    out.push(
      `baseline: ${outcome.baseline.venues} existing ${plan.run.sourceKey}-linked venue rows in current scope ` +
        `(${outcome.baseline.cities.join(", ") || "no cities"})`,
    );
  }
  out.push("════════════════════════════════════════════════════════════");

  out.push(formatSyncPlan(plan));

  out.push("SUMMARY");
  out.push(`  discovered ${count(s.discovered)}   parsed ${count(s.parsed)}   failed ${count(s.fetchFailed + s.parseFailed)} (fetch ${s.fetchFailed}, parse ${s.parseFailed})`);
  out.push(`  inserts    ${count(ops("insert"))}`);
  out.push(`  updates    ${count(ops("update"))}`);
  out.push(`  link-only  ${count(ops("link-only"))}`);
  out.push(`  unchanged  ${count(s.byChangeStatus.UNCHANGED)}`);
  out.push(`  review     ${count(plan.reviewItems.length)}`);
  out.push(`  rejected   ${count(s.byChangeStatus.REJECTED)}`);
  if (plan.reconciliation.reconciled) {
    out.push(
      `  reconciliation: RECONCILED — stale ${s.byChangeStatus.STALE}, missing ${s.byChangeStatus.MISSING}, gone ${s.byChangeStatus.GONE}`,
    );
  } else {
    out.push(`  reconciliation: SKIPPED — ${plan.reconciliation.skippedReason ?? "(no reason given)"}`);
    for (const n of s.notes.filter((x) => /reconciliation skipped|unhealthy run|discovery/.test(x))) {
      out.push(`    reason: ${n}`);
    }
  }

  if (!commit) {
    out.push("");
    out.push("PLAN ONLY — nothing was written. Re-run with --commit to apply this plan.");
  } else if (outcome.commitRefused) {
    out.push("");
    out.push(`COMMIT REFUSED: ${outcome.commitRefused}`);
    out.push("DATABASE WRITES: 0");
  } else if (outcome.apply) {
    const a = outcome.apply;
    out.push("");
    out.push(`APPLY RESULT — committed=${a.committed}`);
    out.push(`  inserted ${count(a.inserted)}   updated ${count(a.updated)}   linked ${count(a.linked)}   skipped ${count(a.skipped)}`);
    if (a.deferred.length > 0) {
      out.push(`  deferred (${a.deferred.length}) — not persisted by the current schema:`);
      for (const d of a.deferred.slice(0, 20)) out.push(`    - ${d}`);
      if (a.deferred.length > 20) out.push(`    .. ${a.deferred.length - 20} more`);
    }
    for (const n of a.notes.filter((x) => !x.startsWith("venue updated:"))) out.push(`  note: ${n}`);
    if (a.error) {
      out.push(
        `  APPLY HALTED: ${a.error.operation} ${a.error.kind ?? ""} ${a.error.sourceKey ?? ""}:${a.error.externalId ?? ""} ` +
          `(${a.error.supabaseOp}) — ${a.error.message}`,
      );
    }
  }
  out.push("");
  return out.join("\n");
}
