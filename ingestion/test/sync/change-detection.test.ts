import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectChange, diffComparable } from "../../src/sync/change-detection.ts";
import { hashComparable, stableStringify } from "../../src/sync/canonical-hash.ts";
import type { JsonValue, StoredRecordState, ValidationResult } from "../../src/sync/types.ts";

const OK: ValidationResult = { outcome: "ok", reasonCode: null, reasons: [] };
const NOW = "2026-06-01T12:00:00.000Z";

function stored(over: Partial<StoredRecordState> = {}): StoredRecordState {
  return {
    canonicalId: "ev-1",
    contentHash: "hash-A",
    comparableFields: { title: "DJ Night", startLocal: "2026-07-01T22:00", status: "scheduled" },
    firstSeenAt: "2026-05-01T00:00:00.000Z",
    lastSeenAt: "2026-05-20T00:00:00.000Z",
    lastSyncedAt: "2026-05-20T00:00:00.000Z",
    sourceStatus: "active",
    consecutiveMisses: 0,
    ...over,
  };
}

test("NEW when there is no stored state", () => {
  const r = detectChange({
    incoming: { contentHash: "h", comparableFields: { title: "X" } },
    stored: null,
    validation: OK,
    now: NOW,
  });
  assert.equal(r.status, "NEW");
  assert.equal(r.firstSeenAt, NOW);
});

test("UNCHANGED when the content hash matches", () => {
  const r = detectChange({
    incoming: { contentHash: "hash-A", comparableFields: stored().comparableFields },
    stored: stored(),
    validation: OK,
    now: NOW,
  });
  assert.equal(r.status, "UNCHANGED");
  assert.deepEqual(r.fieldDeltas, []);
  assert.equal(r.firstSeenAt, "2026-05-01T00:00:00.000Z"); // preserved
});

test("UPDATED with a field-level delta when the hash changes", () => {
  const r = detectChange({
    incoming: {
      contentHash: "hash-B",
      comparableFields: { title: "DJ Night", startLocal: "2026-07-01T23:00", status: "scheduled" },
    },
    stored: stored(),
    validation: OK,
    now: NOW,
  });
  assert.equal(r.status, "UPDATED");
  assert.deepEqual(r.fieldDeltas, [
    { field: "startLocal", from: "2026-07-01T22:00", to: "2026-07-01T23:00" },
  ]);
});

test("REJECTED / NEEDS_REVIEW short-circuit on validation", () => {
  const rej = detectChange({
    incoming: { contentHash: "h", comparableFields: {} },
    stored: null,
    validation: { outcome: "rejected", reasonCode: "placeholder-venue-name", reasons: [] },
    now: NOW,
  });
  assert.equal(rej.status, "REJECTED");

  const rev = detectChange({
    incoming: { contentHash: "hash-B", comparableFields: stored().comparableFields },
    stored: stored(),
    validation: { outcome: "needs_review", reasonCode: "city-unresolved", reasons: [] },
    now: NOW,
  });
  assert.equal(rev.status, "NEEDS_REVIEW");
});

test("diffComparable ignores object key order; an absent field omits from/to (not null)", () => {
  const d = diffComparable(
    { a: 1, b: "x", removed: true },
    { b: "x", a: 2, added: "new" },
  );
  assert.deepEqual(d, [
    { field: "a", from: 1, to: 2 },
    { field: "added", to: "new" }, // absent -> value: NO `from` key
    { field: "removed", from: true }, // value -> absent: NO `to` key
  ]);
});

// ── missing-field vs explicit-null: the six transitions ──────────────
test("diffComparable distinguishes a missing field from an explicit null", () => {
  // a) missing -> null
  assert.deepEqual(diffComparable({}, { x: null }), [{ field: "x", to: null }]);
  // b) null -> missing
  assert.deepEqual(diffComparable({ x: null }, {}), [{ field: "x", from: null }]);
  // c) missing -> value
  assert.deepEqual(diffComparable({}, { x: 5 }), [{ field: "x", to: 5 }]);
  // d) value -> missing
  assert.deepEqual(diffComparable({ x: 5 }, {}), [{ field: "x", from: 5 }]);
  // e) null -> value
  assert.deepEqual(diffComparable({ x: null }, { x: 5 }), [{ field: "x", from: null, to: 5 }]);
  // f) value -> null
  assert.deepEqual(diffComparable({ x: 5 }, { x: null }), [{ field: "x", from: 5, to: null }]);

  // and the no-op case: identical (present) null is NOT a delta
  assert.deepEqual(diffComparable({ x: null }, { x: null }), []);
});

test("the canonical hash also distinguishes {} from { x: null } (hash & diff agree)", () => {
  assert.notEqual(hashComparable({}), hashComparable({ x: null }));
  assert.ok(diffComparable({}, { x: null }).length > 0, "diff must agree with the hash");

  assert.equal(hashComparable({ x: null }), hashComparable({ x: null }));
  assert.deepEqual(diffComparable({ x: null }, { x: null }), []);
});

// ── array vs object ordering semantics ──────────────────────────────
test("hashComparable ignores object key order (recursively) but respects array order", () => {
  assert.equal(hashComparable({ a: 1, b: 2 }), hashComparable({ b: 2, a: 1 }));
  assert.equal(
    hashComparable({ tags: ["x", "y"], n: 1 }),
    hashComparable({ n: 1, tags: ["x", "y"] }),
  );
  assert.equal(
    hashComparable({ o: { p: 1, q: 2 } }),
    hashComparable({ o: { q: 2, p: 1 } }),
    "nested object key order is also irrelevant",
  );

  assert.notEqual(
    hashComparable({ tags: ["x", "y"] }),
    hashComparable({ tags: ["y", "x"] }),
    "array element order IS significant",
  );
  assert.equal(diffComparable({ tags: ["x", "y"] }, { tags: ["y", "x"] }).length, 1);
});

test("stableStringify: keys sorted (recursively), arrays left as-is", () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(stableStringify([3, 1, 2]), "[3,1,2]");
  assert.equal(stableStringify({ z: [2, 1], a: [1, 2] }), '{"a":[1,2],"z":[2,1]}');
});

// ── one implementation of stable serialization ─────────────────────
test("change-detection.ts reuses canonical-hash.ts and defines no second serializer", () => {
  const src = readFileSync(
    new URL("../../src/sync/change-detection.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /from "\.\/canonical-hash\.ts"/, "must import the canonical serializer");
  assert.doesNotMatch(
    src,
    /Object\.keys\([^)]*\)\s*\.sort\(\)/,
    "must not re-sort object keys (that logic lives only in canonical-hash.ts)",
  );
  // diffComparable's equality must match stableStringify EXACTLY, incl. nested key order
  assert.deepEqual(diffComparable({ o: { p: 1, q: 2 } }, { o: { q: 2, p: 1 } }), []);
});

// ── hash <-> diff relationship ─────────────────────────────────────
test("if the canonical hash changes, diffComparable reports at least one field (and vice versa)", () => {
  const pairs: [Record<string, JsonValue>, Record<string, JsonValue>][] = [
    [{ a: 1 }, { a: 2 }],
    [{}, { a: null }],
    [{ a: null }, {}],
    [{ a: 1 }, {}],
    [{ a: [1, 2] }, { a: [2, 1] }],
    [{ a: { x: 1 } }, { a: { x: 2 } }],
    [{ a: 1, b: 2 }, { a: 1, b: 2, c: 3 }],
    // no-change pairs:
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    [{ a: { p: 1, q: 2 } }, { a: { q: 2, p: 1 } }],
    [{ a: null }, { a: null }],
  ];
  for (const [before, after] of pairs) {
    const hashChanged = hashComparable(before) !== hashComparable(after);
    const hasDelta = diffComparable(before, after).length > 0;
    assert.equal(
      hashChanged,
      hasDelta,
      `${stableStringify(before)} -> ${stableStringify(after)}: hashChanged=${hashChanged} hasDelta=${hasDelta}`,
    );
  }
});

test("detectChange: a hash mismatch with identical comparable fields is flagged, not hidden", () => {
  // The only way to reach this state: a stored hash from an older
  // serializer/algorithm. Same fields, different hash string.
  const cf = { title: "DJ Night", startLocal: "2026-07-01T22:00" };
  const r = detectChange({
    incoming: { contentHash: "current-algo-digest", comparableFields: cf },
    stored: stored({ contentHash: "legacy-or-foreign-digest", comparableFields: { ...cf } }),
    validation: OK,
    now: NOW,
  });
  assert.equal(r.status, "UPDATED");
  assert.deepEqual(r.fieldDeltas, [], "fields really are identical");
  assert.match(r.note, /predates the current serializer\/algorithm/);
});

// ── SHA-256 ────────────────────────────────────────────────────────
test("hashComparable is SHA-256 (64 lowercase hex) and order-stable", () => {
  const h = hashComparable({ a: 1, b: "x", c: null });
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashComparable({ c: null, b: "x", a: 1 }));
});
