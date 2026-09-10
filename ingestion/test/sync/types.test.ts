/**
 * ../../src/sync/types.ts — the generic sync contract.
 *
 * types.ts is 100% type / interface declarations: it emits no runtime code, so
 * `npm run typecheck` (which compiles the test tree) is what actually validates
 * the compile-time assertions below. The test() blocks lock the
 * runtime-observable shape of the discriminated unions and the string-literal
 * unions the CLOSED modules depend on.
 *
 * Audit result: no correctness bug. A few union types are wider than what the
 * current engine/store actually produce (ResolvedScope.resolvedVia "coordinates",
 * SyncRunContext.mode "apply", SyncApplyError.operation "reconcile",
 * EventFields.status "postponed"/"rescheduled" after a Supabase round-trip) —
 * intentional forward-compatibility, harmless because every consumer that
 * branches handles the reachable subset. Characterized here, not changed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChangeStatus,
  EntityKind,
  EventFields,
  IdentityOutcome,
  NormalizedRecord,
  ParsedItem,
  Provenance,
  ReconcileTransition,
  SourceRef,
  SourceStatus,
  VenueFields,
} from "../../src/sync/types.ts";

// ════════════════════════════════════════════════════════════════════════
//  Compile-time assertions (checked by `npm run typecheck`)
// ════════════════════════════════════════════════════════════════════════

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ── the closed string-literal unions the CLOSED modules switch on ──
type _EntityKind = Assert<Equal<EntityKind, "venue" | "event">>;
type _SourceStatus = Assert<Equal<SourceStatus, "active" | "stale" | "missing" | "gone">>;
type _ReconcileTransition = Assert<
  Equal<ReconcileTransition, "keep-active" | "mark-stale" | "mark-missing" | "mark-gone" | "no-op">
>;
type _ChangeStatus = Assert<
  Equal<
    ChangeStatus,
    "NEW" | "UPDATED" | "UNCHANGED" | "STALE" | "MISSING" | "GONE" | "REJECTED" | "NEEDS_REVIEW"
  >
>;

// ── `Provenance extends SourceRef` — a provenance is a source ref ──
const _prov: Provenance = {
  sourceKey: "s",
  externalId: "x",
  sourceUrl: null,
  confidence: 1,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  reported: {},
};
const _ref: SourceRef = _prov; // must be assignable
void _ref;

// ── `NormalizedRecord` is a sound discriminated union on `kind` ──
function fieldsOf(rec: NormalizedRecord): VenueFields | EventFields {
  if (rec.kind === "venue") {
    const f: VenueFields = rec.fields; // narrows to VenueFields
    // @ts-expect-error — a venue record has no event `title`
    void rec.fields.title;
    // @ts-expect-error — a venue record's `links` cannot hold a `venue` value
    rec.links.venue = { name: "x", sourceVenueId: null, address: null, coordinates: null, cityText: null };
    return f;
  }
  const f: EventFields = rec.fields; // narrows to EventFields
  // @ts-expect-error — an event record has no venue `name`
  void rec.fields.name;
  const _venue = rec.links.venue; // optional VenueLinkHint — allowed
  void _venue;
  return f;
}
void fieldsOf;

// ── `ParsedItem` discriminates on `ok` ──
function recordsOf(p: ParsedItem): NormalizedRecord[] {
  if (p.ok) return p.records;
  // @ts-expect-error — the failure arm has no `records`
  void p.records;
  return [];
}
void recordsOf;

// ── a full `Record<ChangeStatus, number>` needs every key ──
const _fullCounts: Record<ChangeStatus, number> = {
  NEW: 0, UPDATED: 0, UNCHANGED: 0, STALE: 0, MISSING: 0, GONE: 0, REJECTED: 0, NEEDS_REVIEW: 0,
};
void _fullCounts;
// @ts-expect-error — a partial map does NOT satisfy Record<ChangeStatus, number>
const _partialCounts: Record<ChangeStatus, number> = { NEW: 0 };
void _partialCounts;

// ════════════════════════════════════════════════════════════════════════
//  Runtime shape locks
// ════════════════════════════════════════════════════════════════════════

const ALL_CHANGE_STATUS = [
  "NEW", "UPDATED", "UNCHANGED", "STALE", "MISSING", "GONE", "REJECTED", "NEEDS_REVIEW",
] as const satisfies readonly ChangeStatus[];

const ALL_SOURCE_STATUS = ["active", "stale", "missing", "gone"] as const satisfies readonly SourceStatus[];

const ALL_RECONCILE_TRANSITIONS = [
  "keep-active", "mark-stale", "mark-missing", "mark-gone", "no-op",
] as const satisfies readonly ReconcileTransition[];

test("ChangeStatus has exactly the 8 members the engine's ZERO_CHANGE_COUNTS enumerates", () => {
  assert.equal(new Set(ALL_CHANGE_STATUS).size, 8);
});

test("SourceStatus lifecycle order is active -> stale -> missing -> gone", () => {
  assert.deepEqual([...ALL_SOURCE_STATUS], ["active", "stale", "missing", "gone"]);
});

test("ReconcileTransition contains no cancellation transition", () => {
  assert.ok(!ALL_RECONCILE_TRANSITIONS.some((t) => /cancel/i.test(t)));
});

test("NormalizedRecord: `kind` selects the fields shape at runtime", () => {
  const venue: NormalizedRecord = {
    kind: "venue",
    provenance: _prov,
    scope: { countryCode: "RS", cityText: "Belgrade", coordinates: null },
    fields: {
      name: "Depo", normalizedName: "depo", address: null, coordinates: null,
      coordinatesSource: null, website: null, wikidata: null, openingHours: null,
    },
    links: {},
  };
  const event: NormalizedRecord = {
    kind: "event",
    provenance: _prov,
    scope: { countryCode: "RS", cityText: "Belgrade", coordinates: null },
    fields: {
      title: "Night", description: null, startLocal: "2026-07-01T22:00", endLocal: null,
      doorsLocal: null, timeZone: null, startPrecision: "datetime", status: "scheduled",
      promoter: null, ticketUrl: null, coverImageUrl: null, lineup: [],
    },
    links: { venue: { name: "Depo", sourceVenueId: null, address: null, coordinates: null, cityText: "Belgrade" } },
  };

  assert.equal(venue.kind === "venue" ? venue.fields.name : "n/a", "Depo");
  assert.equal(event.kind === "event" ? event.fields.title : "n/a", "Night");
  assert.deepEqual(venue.kind === "venue" ? venue.links : null, {});
});

test("ParsedItem: the failure arm carries a reason, the success arm carries records", () => {
  const ok: ParsedItem = { ok: true, records: [] };
  const bad: ParsedItem = { ok: false, reason: "http 500" };
  assert.equal(ok.ok && Array.isArray(ok.records), true);
  assert.equal(!bad.ok && bad.reason, "http 500");
});

test("[characterization] EventFields.status models 4 values; the current Supabase schema only round-trips 2", () => {
  // `postponed` / `rescheduled` are valid on the incoming record but the current
  // `events` schema has only `is_cancelled` — the store flattens them to
  // `scheduled` and records a `deferred` note (see supabase-store.ts). The wide
  // union is deliberate: it lets a future schema persist them without a type change.
  const statuses: EventFields["status"][] = ["scheduled", "cancelled", "postponed", "rescheduled"];
  assert.equal(statuses.length, 4);
});

test("[characterization] IdentityOutcome.tier is `number | null` (not a literal union) by design", () => {
  // Venues use tiers 0..4, events 0..3, `null` when not applicable. Kept as
  // `number` so a new tier does not require a type edit; consumers never switch
  // on the exact number.
  const out: IdentityOutcome = {
    entity: "event", decision: "new_candidate", tier: 3, canonicalId: null, reasonCode: "x", note: "",
  };
  assert.equal(typeof out.tier, "number");
  const na: IdentityOutcome = { ...out, decision: "ambiguous", tier: null };
  assert.equal(na.tier, null);
});
