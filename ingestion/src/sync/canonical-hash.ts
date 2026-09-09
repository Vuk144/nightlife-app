/**
 * Canonical content hashing for change detection.
 *
 * `stableStringify` is the ONE canonical serializer, used for BOTH hashing
 * (`hashComparable`) and diffing (`./change-detection.ts#diffComparable`). The
 * two are kept in lock-step on purpose: for any two comparable-field maps,
 *
 *     hashComparable(a) === hashComparable(b)   ⟺   diffComparable(a, b) === []
 *
 * Serialization rules — deterministic and JSON-semantic:
 *
 *   - OBJECT KEY ORDER is irrelevant. Keys are emitted sorted, recursively, so
 *     `{a:1,b:2}` and `{b:2,a:1}` serialize identically.
 *   - OBJECT KEY PRESENCE is significant. `{}`, `{x:null}` and `{x:0}` are three
 *     distinct serializations — a MISSING field is not the same as an explicit
 *     `null` (see `diffComparable`).
 *   - ARRAY ELEMENT ORDER is significant. `[1,2]` ≠ `[2,1]`. Arrays are NEVER
 *     sorted. A comparable field is order-sensitive unless the comparable-field
 *     contract in `./store.ts` explicitly declares it order-independent AND
 *     normalizes (sorts) it before it reaches here. Today no comparable field is
 *     an array, so this is a forward-looking rule.
 *   - Primitives go through `JSON.stringify`, so `undefined` is not
 *     representable: comparable-field maps must use `null`, never `undefined`
 *     (the projections in `./store.ts` already coerce with `?? null`).
 *
 * The hash is deliberately independent of any adapter-supplied hash so the
 * engine and every `CanonicalStore` agree on "did the canonical data change",
 * and a store can RECONSTRUCT it from a persisted canonical row. There is no
 * `content_hash` column — the hash is recomputed from the comparable fields on
 * every run and is never stored or transmitted.
 */

import { createHash } from "node:crypto";
import type { JsonValue } from "./types.ts";

/**
 * Digest algorithm for change detection. This is NOT a security primitive:
 *
 *   - the input is our own canonical projection, never attacker-controlled;
 *   - the digest is only ever compared for equality, same run, same process;
 *   - it is never persisted (no `content_hash` column) or transmitted — both
 *     the engine and the store recompute it from the comparable fields.
 *
 * SHA-256 rather than SHA-1 purely so security scanners have nothing to flag;
 * the switch cost nothing here precisely because there is no stored digest to
 * migrate. Any deterministic hash with a negligible accidental-collision rate
 * would be correct for this use.
 */
const HASH_ALGORITHM = "sha256";

export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

export function hashComparable(fields: Record<string, JsonValue>): string {
  return createHash(HASH_ALGORITHM).update(stableStringify(fields), "utf8").digest("hex");
}
