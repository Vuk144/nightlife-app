/**
 * Human-readable rendering of a `SyncPlan`. Pure string building.
 */

import type { SyncPlan } from "./types.ts";

function pad(n: number, w = 5): string {
  return String(n).padStart(w);
}

export function formatSyncPlan(plan: SyncPlan): string {
  const s = plan.stats;
  const out: string[] = [];
  out.push("");
  out.push(`SYNC PLAN — ${plan.run.sourceKey}  (run ${plan.run.runId})  [${plan.run.mode}]`);
  out.push(
    `  scope: countries=${plan.run.scope.countries.join(",") || "(all)"} ` +
      `cities=${plan.run.scope.cities.join(",") || "(all)"}`,
  );
  out.push(`  status: ${s.status.toUpperCase()}  healthy=${s.healthy}  (${s.durationMs}ms)`);
  out.push("");
  out.push("  discovery/fetch/parse");
  out.push(`    discovered ${pad(s.discovered)}   fetched ${pad(s.fetched)}   fetchFailed ${pad(s.fetchFailed)}`);
  out.push(`    parsed     ${pad(s.parsed)}   parseFailed ${pad(s.parseFailed)}`);
  out.push("");
  out.push("  change status");
  for (const [k, v] of Object.entries(s.byChangeStatus)) {
    if (v > 0) out.push(`    ${k.padEnd(13)} ${pad(v)}`);
  }
  out.push("");
  out.push("  identity");
  out.push(`    venues: matched ${s.venuesMatched}  new ${s.venuesNew}`);
  out.push(`    events: matched ${s.eventsMatched}  new ${s.eventsNew}`);
  out.push(`    review items: ${s.reviewItems}`);
  out.push("");
  out.push("  canonical upserts (nothing written — plan only)");
  const byOp: Record<string, number> = {};
  for (const u of plan.upserts) byOp[`${u.kind}:${u.operation}`] = (byOp[`${u.kind}:${u.operation}`] ?? 0) + 1;
  for (const [k, v] of Object.entries(byOp).sort()) out.push(`    ${k.padEnd(16)} ${pad(v)}`);
  out.push("");
  out.push(
    `  reconciliation: ${plan.reconciliation.reconciled ? "RECONCILED" : "SKIPPED"}` +
      (plan.reconciliation.skippedReason ? ` — ${plan.reconciliation.skippedReason}` : ""),
  );
  for (const a of plan.reconciliation.actions) {
    if (a.transition === "keep-active" || a.transition === "no-op") continue;
    out.push(`    ${a.transition.padEnd(13)} ${a.kind} ${a.key} (miss ${a.misses}) — ${a.note}`);
  }
  if (plan.reviewItems.length > 0) {
    out.push("");
    out.push(`  review queue (${plan.reviewItems.length})`);
    for (const r of plan.reviewItems.slice(0, 20)) {
      const name = r.record.kind === "venue" ? r.record.fields.name : r.record.fields.title;
      out.push(`    [${r.kind}] ${name} — ${r.reasonCode}`);
    }
  }
  if (s.notes.length > 0) {
    out.push("");
    out.push("  notes");
    for (const n of s.notes) out.push(`    - ${n}`);
  }
  out.push("");
  return out.join("\n");
}
