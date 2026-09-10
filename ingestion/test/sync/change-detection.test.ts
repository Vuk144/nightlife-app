import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectChange, diffComparable } from "../../src/sync/change-detection.ts";
import { hashComparable, stableStringify } from "../../src/sync/canonical-hash.ts";
import type {
  ChangeResult,
  JsonValue,
  StoredRecordState,
  ValidationResult,
} from "../../src/sync/types.ts";

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

// ════════════════════════════════════════════════════════════════════
//  detectChange — full status × field matrix (characterization)
//
//  The audit found NO correctness bug. These lock in every branch of
//  detectChange: which validation outcomes short-circuit, what each
//  outcome reports for status / contentHashChanged / fieldDeltas / note
//  / firstSeenAt / lastSeenAt, and the stored===null edges.
// ════════════════════════════════════════════════════════════════════

const REJECT = (code: string | null = "some-reason"): ValidationResult => ({
  outcome: "rejected",
  reasonCode: code,
  reasons: code ? [code] : [],
});
const REVIEW = (code: string | null = "city-unresolved"): ValidationResult => ({
  outcome: "needs_review",
  reasonCode: code,
  reasons: code ? [code] : [],
});

const inc = (contentHash: string, comparableFields: Record<string, JsonValue> = {}) => ({
  contentHash,
  comparableFields,
});

test("[detectChange] lastSeenAt is `now` in EVERY outcome — the record WAS seen this run", () => {
  const cf = stored().comparableFields;
  const runs: ChangeResult[] = [
    detectChange({ incoming: inc("h"), stored: null, validation: OK, now: NOW }), // NEW
    detectChange({ incoming: inc("hash-A", cf), stored: stored(), validation: OK, now: NOW }), // UNCHANGED
    detectChange({ incoming: inc("hash-B", { t: 1 }), stored: stored(), validation: OK, now: NOW }), // UPDATED
    detectChange({ incoming: inc("h"), stored: stored(), validation: REJECT(), now: NOW }), // REJECTED + stored
    detectChange({ incoming: inc("h"), stored: null, validation: REJECT(), now: NOW }), // REJECTED, no stored
    detectChange({ incoming: inc("h"), stored: stored(), validation: REVIEW(), now: NOW }), // NEEDS_REVIEW + stored
    detectChange({ incoming: inc("h"), stored: null, validation: REVIEW(), now: NOW }), // NEEDS_REVIEW, no stored
  ];
  for (const r of runs) assert.equal(r.lastSeenAt, NOW);
});

test("[detectChange] firstSeenAt: preserved from stored where stored exists, else `now`", () => {
  const S = "2026-01-01T00:00:00.000Z";
  const st = () => stored({ firstSeenAt: S });
  const preserved = [
    detectChange({ incoming: inc("hash-A", st().comparableFields), stored: st(), validation: OK, now: NOW }), // UNCHANGED
    detectChange({ incoming: inc("hash-Z", { x: 1 }), stored: st(), validation: OK, now: NOW }), // UPDATED
    detectChange({ incoming: inc("h"), stored: st(), validation: REJECT(), now: NOW }), // REJECTED + stored
    detectChange({ incoming: inc("h"), stored: st(), validation: REVIEW(), now: NOW }), // NEEDS_REVIEW + stored
  ];
  for (const r of preserved) assert.equal(r.firstSeenAt, S);

  const fresh = [
    detectChange({ incoming: inc("h"), stored: null, validation: OK, now: NOW }), // NEW
    detectChange({ incoming: inc("h"), stored: null, validation: REJECT(), now: NOW }), // REJECTED, no stored
    detectChange({ incoming: inc("h"), stored: null, validation: REVIEW(), now: NOW }), // NEEDS_REVIEW, no stored
  ];
  for (const r of fresh) assert.equal(r.firstSeenAt, NOW);
});

test("[detectChange] REJECTED short-circuits: no diff, no hash comparison, whatever the stored state", () => {
  for (const st of [null, stored({ contentHash: "totally-diff", comparableFields: { a: 1, b: 2, c: 3 } })]) {
    const r = detectChange({
      incoming: inc("x", { z: 99 }),
      stored: st,
      validation: REJECT("placeholder-venue-name"),
      now: NOW,
    });
    assert.equal(r.status, "REJECTED");
    assert.equal(r.contentHashChanged, false, "REJECTED never reports a content change");
    assert.deepEqual(r.fieldDeltas, [], "REJECTED never diffs");
    assert.equal(r.note, "placeholder-venue-name");
  }
});

test("[detectChange] REJECTED note falls back to a default when validation carries no reasonCode", () => {
  const r = detectChange({
    incoming: inc("x"),
    stored: null,
    validation: { outcome: "rejected", reasonCode: null, reasons: [] },
    now: NOW,
  });
  assert.equal(r.note, "rejected by validation");
});

test("[detectChange] NEEDS_REVIEW short-circuits status but STILL reports the real hash/field comparison", () => {
  const st = stored({
    contentHash: "hash-A",
    comparableFields: { title: "DJ Night", startLocal: "2026-07-01T22:00", status: "scheduled" },
  });

  // a) would-be UNCHANGED (same hash) — still NEEDS_REVIEW, nothing "changed"
  const same = detectChange({
    incoming: inc("hash-A", st.comparableFields),
    stored: st,
    validation: REVIEW("city-unresolved"),
    now: NOW,
  });
  assert.equal(same.status, "NEEDS_REVIEW");
  assert.equal(same.contentHashChanged, false);
  assert.deepEqual(same.fieldDeltas, []);
  assert.equal(same.note, "city-unresolved");

  // b) would-be UPDATED (different hash) — NEEDS_REVIEW, real deltas surfaced, note falls back
  const changed = detectChange({
    incoming: inc("hash-B", { title: "DJ Night", startLocal: "2026-07-01T23:00", status: "scheduled" }),
    stored: st,
    validation: REVIEW(null),
    now: NOW,
  });
  assert.equal(changed.status, "NEEDS_REVIEW");
  assert.equal(changed.contentHashChanged, true);
  assert.deepEqual(changed.fieldDeltas, [
    { field: "startLocal", from: "2026-07-01T22:00", to: "2026-07-01T23:00" },
  ]);
  assert.equal(changed.note, "held for review");
});

test("[detectChange] NEEDS_REVIEW with NO stored state → contentHashChanged:true, no deltas", () => {
  const r = detectChange({
    incoming: inc("h", { title: "x" }),
    stored: null,
    validation: REVIEW(),
    now: NOW,
  });
  assert.equal(r.status, "NEEDS_REVIEW");
  assert.equal(r.contentHashChanged, true);
  assert.deepEqual(r.fieldDeltas, []);
});

test("[detectChange] contentHashChanged / note per non-review outcome", () => {
  const st = stored();
  const nw = detectChange({ incoming: inc("h"), stored: null, validation: OK, now: NOW });
  assert.equal(nw.status, "NEW");
  assert.equal(nw.contentHashChanged, true);
  assert.equal(nw.note, "no stored state for this source record");
  assert.deepEqual(nw.fieldDeltas, []);

  const un = detectChange({ incoming: inc("hash-A", st.comparableFields), stored: st, validation: OK, now: NOW });
  assert.equal(un.status, "UNCHANGED");
  assert.equal(un.contentHashChanged, false);
  assert.equal(un.note, "content hash unchanged");

  const up = detectChange({
    incoming: inc("hash-B", { title: "DJ Night", startLocal: "2026-07-01T23:00", status: "scheduled" }),
    stored: st,
    validation: OK,
    now: NOW,
  });
  assert.equal(up.status, "UPDATED");
  assert.equal(up.contentHashChanged, true);
  assert.equal(up.note, "changed: startLocal");
});

// ════════════════════════════════════════════════════════════════════
//  Engine contract — incoming.contentHash === hashComparable(fields),
//  stored.contentHash === hashComparable(stored.comparableFields).
//  Under that contract detectChange's status follows the hash⟺diff
//  invariant exactly (this is how the real engine calls it — see
//  engine.ts: `hashComparable(comparable(record))`).
// ════════════════════════════════════════════════════════════════════

const realInc = (fields: Record<string, JsonValue>) => ({
  contentHash: hashComparable(fields),
  comparableFields: fields,
});
const realStored = (fields: Record<string, JsonValue>, over: Partial<StoredRecordState> = {}) =>
  stored({ contentHash: hashComparable(fields), comparableFields: fields, ...over });

test("[engine-contract] key-reordered-identical fields → UNCHANGED, empty deltas", () => {
  const a = { name: "Depo", lat: 44.8, lon: 20.5, website: null, isActive: true };
  const b = { isActive: true, website: null, lon: 20.5, lat: 44.8, name: "Depo" };
  const r = detectChange({ incoming: realInc(b), stored: realStored(a), validation: OK, now: NOW });
  assert.equal(r.status, "UNCHANGED");
  assert.deepEqual(r.fieldDeltas, []);
  assert.equal(r.contentHashChanged, false);
});

test("[engine-contract] a real field change → UPDATED with the matching sorted non-empty deltas", () => {
  const before = { name: "Depo", lat: 44.8, lon: 20.5, address: null };
  const after = { name: "Depo Klub", lat: 44.8, lon: 20.5, address: "Trg 1" };
  const r = detectChange({ incoming: realInc(after), stored: realStored(before), validation: OK, now: NOW });
  assert.equal(r.status, "UPDATED");
  assert.equal(r.contentHashChanged, true);
  assert.deepEqual(r.fieldDeltas, [
    { field: "address", from: null, to: "Trg 1" },
    { field: "name", from: "Depo", to: "Depo Klub" },
  ]);
  assert.equal(r.fieldDeltas.length > 0, r.contentHashChanged, "invariant at the detectChange level");
});

test("[engine-contract] UPDATED note lists exactly the changed field names, sorted", () => {
  const r = detectChange({
    incoming: realInc({ a: 1, b: 2, c: 3 }),
    stored: realStored({ a: 9, b: 2, c: 9 }),
    validation: OK,
    now: NOW,
  });
  assert.equal(r.status, "UPDATED");
  assert.equal(r.note, "changed: a, c");
});

test("[engine-contract] detectChange is idempotent — identical inputs give deep-equal outputs", () => {
  const build = () => ({
    incoming: realInc({ name: "X", lat: 1, lon: 2 }),
    stored: realStored({ name: "X", lat: 1, lon: 9 }),
    validation: OK,
    now: NOW,
  });
  assert.deepEqual(detectChange(build()), detectChange(build()));
});

// ── diffComparable: determinism + deep comparison ───────────────────

test("[diffComparable] delta order is the sorted union of field names", () => {
  const d = diffComparable(
    { zebra: 1, apple: 1, mango: 1, "10": 1, "2": 1 },
    { zebra: 2, apple: 2, mango: 2, "10": 2, "2": 2 },
  );
  assert.deepEqual(d.map((x) => x.field), ["10", "2", "apple", "mango", "zebra"]);
});

test("[diffComparable] nested objects / arrays are compared deeply (whole value as from/to)", () => {
  assert.deepEqual(
    diffComparable({ o: { a: 1 } }, { o: { a: 1, b: 2 } }),
    [{ field: "o", from: { a: 1 }, to: { a: 1, b: 2 } }],
  );
  assert.deepEqual(
    diffComparable({ tags: ["a", "b"] }, { tags: ["b", "a"] }),
    [{ field: "tags", from: ["a", "b"], to: ["b", "a"] }],
  );
  // nested key reorder only → NOT a delta (jsonEqual is via stableStringify)
  assert.deepEqual(diffComparable({ o: { a: 1, b: 2 } }, { o: { b: 2, a: 1 } }), []);
});
