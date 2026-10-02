/**
 * Controlled bulk EVENT write — source-agnostic, insert-only, preflight first.
 *
 * Input: the source-agnostic planner's result for each event
 * (`./event-plan.ts#EventPlanItem`). No second event model, no source logic.
 *
 *   Phase A — `prepareBulkEventWrite` (a dry run: reads only, ZERO writes)
 *     validates EVERY candidate, checks every target venue and every existing
 *     event identity, and runs the existing engine (`planSync`) over the batch
 *     for identity + change detection. Any failed precondition rejects the
 *     WHOLE batch before anything is written. On success it returns a frozen
 *     `PreparedBulkEventWrite`: the exact insert set.
 *
 *   Phase B — `commitBulkEventWrite(prepared, store)`
 *     writes exactly that prepared set, one event insert per `store.apply`,
 *     with reconciliation off. A prepared batch can be committed only once.
 *
 * NOT TRANSACTIONAL. `SupabaseCanonicalStore.apply` issues one PostgREST
 * request per row; nothing spans the batch. Phase B therefore stops at the
 * first failure and reports exactly which external ids were inserted, which
 * failed, and which were never attempted. Recovery is always the same: run
 * Phase A again with `onExisting: "skip-unchanged"` — rows that did land are
 * found by (source, external id) and skipped, never inserted twice. Never
 * re-commit a prepared batch after a failure.
 *
 * Write scope is event INSERTS only. This module only hands the store plans
 * that contain a single NEW event insert with reconciliation disabled, and
 * checks each apply result. The hard per-operation boundary for the Supabase
 * store is the client guard in `./supabase-write-guard.ts`.
 */

import type { ConfigProvider } from "./config.ts";
import { createInMemoryAdapter } from "./adapters/in-memory.ts";
import { planSync } from "./engine.ts";
import { eventInstants, validateEventContract } from "./event-contract.ts";
import type { EventPlanItem } from "./event-plan.ts";
import type { CanonicalStore } from "./store.ts";
import type { CanonicalUpsert, SyncApplyResult, SyncPlan } from "./types.ts";
import type { CrossSourceVenueIdentity } from "./venue-cross-source-identity.ts";

/** What to do with a READY event whose identity is already stored. */
export type ExistingEventMode =
  /** Reject the whole batch (default). */
  | "reject"
  /** Skip it — but ONLY when the engine sees it UNCHANGED. A changed row is still rejected: this writer never updates. */
  | "skip-unchanged";

export interface BulkEventWriteDeps {
  store: CanonicalStore;
  config: ConfigProvider;
  /** Every candidate must come from this one source. */
  sourceKey: string;
  /** Pass the same curated identities the planner used (e.g. `CROSS_SOURCE_VENUE_IDENTITIES`). */
  crossSourceIdentities?: CrossSourceVenueIdentity[];
  /** Logical run timestamp (ISO) and id. */
  now: string;
  runId: string;
}

export interface BulkEventWriteOptions {
  onExisting?: ExistingEventMode;
}

export interface BulkEventRejection {
  /** null when the rejection is about the batch, not one candidate. */
  externalId: string | null;
  reason: string;
}

export interface PreparedEventInsert {
  externalId: string;
  venueId: string;
  title: string;
  startAt: string;
  endAt: string | null;
  /** The engine's upsert for this event — the exact thing `store.apply` receives. */
  upsert: CanonicalUpsert;
}

/** The frozen, exact insert set that passed preflight. */
export interface PreparedBulkEventWrite {
  readonly sourceKey: string;
  readonly runId: string;
  readonly inserts: readonly PreparedEventInsert[];
  readonly skippedExisting: readonly { externalId: string; canonicalId: string }[];
  /** The engine plan's run context; each insert is applied under it. */
  readonly run: SyncPlan["run"];
}

export type BulkEventPreflight =
  | { ok: true; prepared: PreparedBulkEventWrite; summary: BulkEventWriteResult }
  | { ok: false; rejections: BulkEventRejection[]; summary: BulkEventWriteResult };

export interface BulkEventFailure {
  externalId: string;
  error: string;
  /** Read back after the failure: did the row land anyway? null = the read itself failed (state unknown). */
  rowPresentAfterFailure: boolean | null;
}

export interface BulkEventWriteResult {
  mode: "preflight" | "commit";
  /** Commit: every prepared insert succeeded. Preflight: always false. */
  committed: boolean;
  /** Candidates handed in. */
  candidates: number;
  /** Inserts in the prepared set. */
  planned: number;
  /** Inserts actually handed to `store.apply`. */
  attempted: number;
  inserted: number;
  insertedExternalIds: string[];
  skippedExisting: number;
  skippedExternalIds: string[];
  rejected: number;
  review: number;
  /** Always 0: this writer never plans or applies a venue write. */
  venueUpserts: number;
  /** Always 0: reconciliation is disabled. */
  reconciliation: number;
  failed: number;
  failedExternalIds: string[];
  failures: BulkEventFailure[];
  notAttemptedExternalIds: string[];
  partialFailure: boolean;
  /** True when every failure's row state is known, so re-running preflight with `skip-unchanged` cannot duplicate. */
  retrySafe: boolean;
  retryGuidance: string | null;
  rejections: BulkEventRejection[];
}

const RETRY_GUIDANCE =
  'Do not re-commit this prepared batch. Re-run prepareBulkEventWrite with onExisting: "skip-unchanged": ' +
  "rows that were inserted are found by (source, external id) and skipped; only the rest are prepared again.";

function emptyResult(mode: BulkEventWriteResult["mode"], candidates: number): BulkEventWriteResult {
  return {
    mode,
    committed: false,
    candidates,
    planned: 0,
    attempted: 0,
    inserted: 0,
    insertedExternalIds: [],
    skippedExisting: 0,
    skippedExternalIds: [],
    rejected: 0,
    review: 0,
    venueUpserts: 0,
    reconciliation: 0,
    failed: 0,
    failedExternalIds: [],
    failures: [],
    notAttemptedExternalIds: [],
    partialFailure: false,
    retrySafe: true,
    retryGuidance: null,
    rejections: [],
  };
}

/** Prepared batches this module issued, and the ones already committed. */
const issued = new WeakSet<PreparedBulkEventWrite>();
const consumed = new WeakSet<PreparedBulkEventWrite>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────
//  Phase A — preflight (reads only)
// ─────────────────────────────────────────────────────────────────────

export async function prepareBulkEventWrite(
  items: EventPlanItem[],
  deps: BulkEventWriteDeps,
  opts: BulkEventWriteOptions = {},
): Promise<BulkEventPreflight> {
  const onExisting = opts.onExisting ?? "reject";
  const summary = emptyResult("preflight", items.length);
  const rejections: BulkEventRejection[] = [];
  const reject = (externalId: string | null, reason: string) => rejections.push({ externalId, reason });
  const fail = (): BulkEventPreflight => {
    summary.rejections = rejections;
    summary.rejected = rejections.length;
    return { ok: false, rejections, summary };
  };

  const source = deps.config.source(deps.sourceKey);
  if (!deps.sourceKey.trim() || !source) {
    reject(null, `source "${deps.sourceKey}" is not configured`);
    return fail();
  }

  // 1. only READY candidates — any REVIEW / REJECTED rejects the whole batch
  const ready: Extract<EventPlanItem, { action: "READY" }>[] = [];
  for (const item of items) {
    if (item.action === "READY") {
      ready.push(item);
      continue;
    }
    const id = item.event?.provenance.externalId ?? null;
    if (item.action === "REVIEW") summary.review++;
    reject(id, `candidate is ${item.action} (${item.reasonCode}), not READY`);
  }

  // 2. per-candidate identity, contract, instants, venue, duplicates
  const byId = new Map<string, Extract<EventPlanItem, { action: "READY" }>>();
  for (const item of ready) {
    const p = item.event.provenance;
    const id = p.externalId?.trim() ?? "";
    if (!p.sourceKey?.trim()) {
      reject(id || null, "missing source identity");
      continue;
    }
    if (p.sourceKey !== deps.sourceKey) {
      reject(id || null, `source "${p.sourceKey}" does not match the batch source "${deps.sourceKey}"`);
      continue;
    }
    if (!id || id !== p.externalId) {
      reject(id || null, "missing or untrimmed external id");
      continue;
    }
    const prior = byId.get(id);
    if (prior) {
      const identical = JSON.stringify(prior) === JSON.stringify(item);
      reject(id, identical ? "duplicate external id in the batch" : "conflicting duplicate external id in the batch");
      continue;
    }
    byId.set(id, item);

    const contract = validateEventContract(item.event, item.event.fields.timeZone);
    if (contract) {
      reject(id, `invalid canonical event data: ${contract.reasons.join("; ")}`);
      continue;
    }
    const instants = eventInstants(item.event.fields, item.event.fields.timeZone);
    if (!instants.ok || instants.startAt !== item.startAt || instants.endAt !== item.endAt) {
      reject(id, "planned start/end do not match the event's own instants");
      continue;
    }
    if (!item.venueId) {
      reject(id, "no canonical venue");
      continue;
    }
    const venue = await deps.store.getVenueById(item.venueId);
    if (!venue) reject(id, `canonical venue ${item.venueId} does not exist`);
  }
  if (rejections.length > 0) return fail();
  if (ready.length === 0) {
    // empty batch: a safe no-op — nothing to plan, nothing to write
    const run: SyncPlan["run"] = {
      runId: deps.runId,
      sourceKey: deps.sourceKey,
      startedAt: deps.now,
      mode: "plan",
      scope: { countries: [], cities: [] },
      completeness: "partial",
    };
    const prepared = issue({ sourceKey: deps.sourceKey, runId: deps.runId, inserts: [], skippedExisting: [], run });
    return { ok: true, prepared, summary };
  }

  // 3. existing identities (store read)
  const existing = new Map<string, string>();
  for (const id of byId.keys()) {
    const row = await deps.store.getEventBySource(deps.sourceKey, id);
    if (!row) continue;
    if (onExisting === "reject") reject(id, `event ${deps.sourceKey}:${id} already exists (${row.id})`);
    else existing.set(id, row.id);
  }
  if (rejections.length > 0) return fail();

  // 4. the existing engine: identity + change detection over exactly this batch
  const adapter = createInMemoryAdapter({
    key: deps.sourceKey,
    items: ready.map((i) => ({ externalId: i.event.provenance.externalId, kind: "event" as const, payload: i.event })),
  });
  const plan = await planSync({
    adapter,
    source,
    config: deps.config,
    store: deps.store,
    now: deps.now,
    runId: deps.runId,
    completeness: "partial",
    crossSourceIdentities: deps.crossSourceIdentities,
  });
  if (plan.stats.status !== "ok" || !plan.stats.healthy) reject(null, `engine plan is ${plan.stats.status} / unhealthy`);
  for (const r of plan.reviewItems) reject(r.record.provenance.externalId, `engine review: ${r.reasonCode}`);

  const inserts: PreparedEventInsert[] = [];
  const skippedExisting: { externalId: string; canonicalId: string }[] = [];
  const seen = new Set<string>();
  for (const u of plan.upserts) {
    const id = u.record.provenance.externalId;
    if (u.kind !== "event") {
      summary.venueUpserts++;
      reject(id, `engine planned a ${u.kind} ${u.operation} — this writer never writes venues`);
      continue;
    }
    const item = byId.get(id);
    if (!item || seen.has(id)) {
      reject(id, "engine planned an event outside the batch");
      continue;
    }
    seen.add(id);
    if (u.changeStatus === "NEW" && u.operation === "insert" && u.canonicalId === null && !existing.has(id)) {
      if (u.resolvedVenueId !== item.venueId) {
        reject(id, `engine venue ${u.resolvedVenueId ?? "none"} != planner venue ${item.venueId}`);
        continue;
      }
      inserts.push({ externalId: id, venueId: item.venueId, title: item.event.fields.title, startAt: item.startAt, endAt: item.endAt, upsert: structuredClone(u) });
    } else if (u.changeStatus === "UNCHANGED" && existing.has(id) && u.canonicalId === existing.get(id)) {
      skippedExisting.push({ externalId: id, canonicalId: existing.get(id)! });
    } else {
      reject(id, `engine planned ${u.changeStatus} ${u.operation} — this writer only inserts NEW events`);
    }
  }
  for (const id of byId.keys()) if (!seen.has(id)) reject(id, "engine planned nothing for this candidate");
  if (rejections.length > 0) return fail();

  const prepared = issue({ sourceKey: deps.sourceKey, runId: deps.runId, inserts, skippedExisting, run: structuredClone(plan.run) });
  summary.planned = inserts.length;
  summary.skippedExisting = skippedExisting.length;
  summary.skippedExternalIds = skippedExisting.map((s) => s.externalId);
  return { ok: true, prepared, summary };
}

function issue(p: PreparedBulkEventWrite): PreparedBulkEventWrite {
  const frozen = deepFreeze(p);
  issued.add(frozen);
  return frozen;
}

/** The exact Supabase rows' identity set a client guard should allow for this batch. */
export function preparedInsertAllowances(prepared: PreparedBulkEventWrite): { externalId: string; venueId: string }[] {
  return prepared.inserts.map((i) => ({ externalId: i.externalId, venueId: i.venueId }));
}

// ─────────────────────────────────────────────────────────────────────
//  Phase B — commit the prepared set
// ─────────────────────────────────────────────────────────────────────

/** A one-insert plan: the prepared upsert, reconciliation disabled. */
function singleInsertPlan(prepared: PreparedBulkEventWrite, insert: PreparedEventInsert): SyncPlan {
  return {
    run: { ...structuredClone(prepared.run), mode: "apply" },
    upserts: [structuredClone(insert.upsert)],
    reviewItems: [],
    reconciliation: { reconciled: false, runStatus: "ok", actions: [], skippedReason: "controlled bulk event write: reconciliation disabled" },
    stats: {
      discovered: 0, fetched: 0, fetchFailed: 0, parsed: 0, parseFailed: 0,
      byChangeStatus: { NEW: 1, UPDATED: 0, UNCHANGED: 0, STALE: 0, MISSING: 0, GONE: 0, REJECTED: 0, NEEDS_REVIEW: 0 },
      venuesMatched: 0, venuesNew: 0, eventsMatched: 0, eventsNew: 1, reviewItems: 0,
      reconciled: false, reconciliationActions: 0, durationMs: 0, status: "ok", healthy: true, notes: [],
    },
  };
}

/** Only an exact, single, NEW event insert with reconciliation off may reach the store. Throws otherwise. */
export function assertControlledInsertPlan(plan: SyncPlan, allowed: Set<string>): void {
  if (plan.reconciliation.reconciled || plan.reconciliation.actions.length > 0) {
    throw new Error("controlled bulk event write: reconciliation must be disabled");
  }
  if (plan.upserts.length !== 1) throw new Error("controlled bulk event write: exactly one upsert per apply");
  const [u] = plan.upserts;
  if (u.kind !== "event") throw new Error(`controlled bulk event write: forbidden ${u.kind} write`);
  if (u.operation !== "insert" || u.changeStatus !== "NEW" || u.canonicalId !== null) {
    throw new Error(`controlled bulk event write: forbidden event ${u.operation}`);
  }
  if (!allowed.has(u.record.provenance.externalId)) {
    throw new Error(`controlled bulk event write: ${u.record.provenance.externalId} is not in the prepared set`);
  }
}

function applyOk(r: SyncApplyResult): boolean {
  return r.committed && r.error == null && r.inserted === 1 && r.updated === 0 && r.linked === 0 && r.reconciled === 0 && r.deferred.length === 0;
}

export async function commitBulkEventWrite(
  prepared: PreparedBulkEventWrite,
  store: CanonicalStore,
): Promise<BulkEventWriteResult> {
  if (!issued.has(prepared)) throw new Error("commitBulkEventWrite: not a prepared batch from prepareBulkEventWrite");
  if (consumed.has(prepared)) throw new Error("commitBulkEventWrite: this prepared batch was already committed — re-run prepareBulkEventWrite");
  consumed.add(prepared);

  const result = emptyResult("commit", prepared.inserts.length + prepared.skippedExisting.length);
  result.planned = prepared.inserts.length;
  result.skippedExisting = prepared.skippedExisting.length;
  result.skippedExternalIds = prepared.skippedExisting.map((s) => s.externalId);
  const allowed = new Set(prepared.inserts.map((i) => i.externalId));

  // validate the whole prepared set again before the first write
  const plans = prepared.inserts.map((i) => singleInsertPlan(prepared, i));
  for (const p of plans) assertControlledInsertPlan(p, allowed);

  for (let n = 0; n < prepared.inserts.length; n++) {
    const insert = prepared.inserts[n];
    const stop = async (error: string) => {
      let present: boolean | null;
      try {
        present = (await store.getEventBySource(prepared.sourceKey, insert.externalId)) != null;
      } catch {
        present = null;
      }
      result.failed++;
      result.failedExternalIds.push(insert.externalId);
      result.failures.push({ externalId: insert.externalId, error, rowPresentAfterFailure: present });
      result.notAttemptedExternalIds = prepared.inserts.slice(n + 1).map((i) => i.externalId);
    };

    // the identity may have been written by someone else since preflight
    let already: boolean;
    try {
      already = (await store.getEventBySource(prepared.sourceKey, insert.externalId)) != null;
    } catch (e) {
      await stop(`pre-write read failed: ${(e as Error).message}`);
      break;
    }
    if (already) {
      await stop("event appeared in the store after preflight — not written (would not be an insert)");
      break;
    }

    result.attempted++;
    let applied: SyncApplyResult;
    try {
      applied = await store.apply(plans[n], { commit: true });
    } catch (e) {
      await stop((e as Error).message);
      break;
    }
    if (!applyOk(applied)) {
      await stop(applied.error?.message ?? `unexpected apply result: ${JSON.stringify({ inserted: applied.inserted, updated: applied.updated, linked: applied.linked, deferred: applied.deferred })}`);
      break;
    }
    result.inserted++;
    result.insertedExternalIds.push(insert.externalId);
  }

  result.committed = result.failed === 0 && result.inserted === prepared.inserts.length;
  result.partialFailure = result.inserted > 0 && !result.committed;
  result.retrySafe = result.failures.every((f) => f.rowPresentAfterFailure !== null);
  result.retryGuidance = result.committed ? null : RETRY_GUIDANCE;
  return result;
}
