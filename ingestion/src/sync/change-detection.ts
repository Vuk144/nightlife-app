/**
 * Change detection — pure, generic, per record seen this run.
 *
 * Compares an incoming source record against the stored state for the same
 * `(sourceKey, externalId)`:
 *
 *   REJECTED       validation says the record is not admissible
 *   NEEDS_REVIEW   validation defers to a human
 *   NEW            no stored state
 *   UNCHANGED      content hash unchanged
 *   UPDATED        content hash changed — `fieldDeltas` says what
 *
 * STALE / MISSING / GONE are the province of reconciliation (`./reconcile.ts`),
 * which looks at records NOT seen this run.
 *
 * Serialization / equality is owned by `./canonical-hash.ts#stableStringify` —
 * there is exactly ONE stable-serialization implementation, shared by the hash
 * and by `diffComparable` here. The relationship is guaranteed:
 *
 *     hashComparable(a) === hashComparable(b)   ⟺   diffComparable(a, b) === []
 *
 * So a hash mismatch with an EMPTY `fieldDeltas` is not a normal state — it can
 * only mean the stored hash was produced by a different serializer/algorithm
 * (an older build). `detectChange` still reports UPDATED in that case and says
 * so in `note`; it never silently swallows the mismatch.
 */

import { stableStringify } from "./canonical-hash.ts";
import type {
  ChangeResult,
  FieldDelta,
  JsonValue,
  StoredRecordState,
  ValidationResult,
} from "./types.ts";

/** Deep JSON-value equality via the ONE canonical serializer. */
function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Per-field diff of two comparable-field maps, kept consistent with the
 * canonical hash: `diffComparable(a, b)` is `[]` iff `hashComparable(a) ===
 * hashComparable(b)`.
 *
 *   - OBJECT KEY ORDER is irrelevant — fields are matched by name, output sorted.
 *   - KEY PRESENCE is significant — an ABSENT field is distinct from one set to
 *     `null`. A delta encodes absence by OMITTING the `from` / `to` key:
 *
 *       absent -> value   →  { field, to }              (no `from`)
 *       value  -> absent   →  { field, from }             (no `to`)
 *       absent -> null     →  { field, to: null }         (still a delta)
 *       null   -> absent   →  { field, from: null }       (still a delta)
 *       null   -> value    →  { field, from: null, to }
 *       value  -> null     →  { field, from, to: null }
 *
 *   - ARRAY ELEMENT ORDER is significant (arrays are never sorted) — see
 *     `stableStringify`.
 */
export function diffComparable(
  before: Record<string, JsonValue>,
  after: Record<string, JsonValue>,
): FieldDelta[] {
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  const deltas: FieldDelta[] = [];
  for (const field of [...new Set([...beforeKeys, ...afterKeys])].sort()) {
    const hasBefore = beforeKeys.has(field);
    const hasAfter = afterKeys.has(field);
    if (hasBefore && hasAfter) {
      if (jsonEqual(before[field], after[field])) continue;
      deltas.push({ field, from: before[field], to: after[field] });
    } else if (hasBefore) {
      deltas.push({ field, from: before[field] }); // `to` omitted → now absent
    } else {
      deltas.push({ field, to: after[field] }); // `from` omitted → was absent
    }
  }
  return deltas;
}

export function detectChange(input: {
  incoming: { contentHash: string; comparableFields: Record<string, JsonValue> };
  stored: StoredRecordState | null;
  validation: ValidationResult;
  now: string;
}): ChangeResult {
  const { incoming, stored, validation, now } = input;
  const firstSeenAt = stored?.firstSeenAt ?? now;

  if (validation.outcome === "rejected") {
    return {
      status: "REJECTED",
      contentHashChanged: false,
      fieldDeltas: [],
      firstSeenAt,
      lastSeenAt: now,
      note: validation.reasonCode ?? "rejected by validation",
    };
  }
  if (validation.outcome === "needs_review") {
    return {
      status: "NEEDS_REVIEW",
      contentHashChanged: stored ? stored.contentHash !== incoming.contentHash : true,
      fieldDeltas: stored
        ? diffComparable(stored.comparableFields, incoming.comparableFields)
        : [],
      firstSeenAt,
      lastSeenAt: now,
      note: validation.reasonCode ?? "held for review",
    };
  }

  if (!stored) {
    return {
      status: "NEW",
      contentHashChanged: true,
      fieldDeltas: [],
      firstSeenAt: now,
      lastSeenAt: now,
      note: "no stored state for this source record",
    };
  }

  if (stored.contentHash === incoming.contentHash) {
    return {
      status: "UNCHANGED",
      contentHashChanged: false,
      fieldDeltas: [],
      firstSeenAt,
      lastSeenAt: now,
      note: "content hash unchanged",
    };
  }

  const fieldDeltas = diffComparable(stored.comparableFields, incoming.comparableFields);
  return {
    status: "UPDATED",
    contentHashChanged: true,
    fieldDeltas,
    firstSeenAt,
    lastSeenAt: now,
    note:
      fieldDeltas.length > 0
        ? `changed: ${fieldDeltas.map((d) => d.field).join(", ")}`
        : "content hash differs but the comparable fields are identical — the stored " +
          "hash predates the current serializer/algorithm; treating as UPDATED",
  };
}
