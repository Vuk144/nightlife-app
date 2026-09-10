/**
 * Characterization tests for `../../src/sync/canonical-hash.ts`.
 *
 * The audit found NO correctness bug — this file is pure characterization,
 * locking in the current (correct) behavior of `stableStringify` /
 * `hashComparable` so a future change can't silently break it:
 *
 *   - JSON-semantic primitives (via `JSON.stringify`)
 *   - recursive key sorting; arrays never sorted; array order significant
 *   - key PRESENCE significant — `{}`, `{x:null}`, `{x:0}` all distinct
 *   - empty objects / arrays
 *   - structural injectivity — a string value can never collide with the
 *     serialization of a container (delimiters only appear outside quotes)
 *   - the documented end-to-end invariant:
 *         hashComparable(a) === hashComparable(b)  ⟺  diffComparable(a, b) === []
 *
 * `stableStringify` / `hashComparable` interplay with `diffComparable` is also
 * covered from the diff side in `./change-detection.test.ts`; this file
 * concentrates on the serializer itself and adds the exhaustive invariant grid.
 *
 * A few cases exercise inputs OUTSIDE the `JsonValue` contract (`NaN`,
 * `undefined`); each is labelled `[outside-contract]` and asserts that the
 * invariant still holds even there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hashComparable, stableStringify } from "../../src/sync/canonical-hash.ts";
import { diffComparable } from "../../src/sync/change-detection.ts";
import type { JsonValue } from "../../src/sync/types.ts";

// ── 1. primitives ──────────────────────────────────────────────────

test("stableStringify: primitives are JSON-semantic", () => {
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify(true), "true");
  assert.equal(stableStringify(false), "false");
  assert.equal(stableStringify(0), "0");
  assert.equal(stableStringify(-0), "0"); // JSON.stringify(-0) === "0"
  assert.equal(stableStringify(42), "42");
  assert.equal(stableStringify(-7.5), "-7.5");
  assert.equal(stableStringify(1e21), "1e+21");
  assert.equal(stableStringify(""), '""');
  assert.equal(stableStringify("hello"), '"hello"');
  // quotes / backslashes / control chars are the JSON escaping, verbatim
  for (const s of ['a "q" \\ b', "line\nbreak", "\t", "  ", "café"]) {
    assert.equal(stableStringify(s), JSON.stringify(s));
  }
});

test("stableStringify: number identity — 1 and 1.0 collapse; number ≠ string; 0 ≠ false", () => {
  assert.equal(stableStringify(1), stableStringify(1.0));
  assert.notEqual(stableStringify(10), stableStringify("10"));
  assert.notEqual(stableStringify(0), stableStringify(false));
  assert.equal(hashComparable({ x: 10 }), hashComparable({ x: 10.0 }));
  assert.notEqual(hashComparable({ x: 10 }), hashComparable({ x: "10" }));
  assert.notEqual(hashComparable({ x: 0 }), hashComparable({ x: false }));
});

// ── 2. empty containers ────────────────────────────────────────────

test("stableStringify: empty object and empty array", () => {
  assert.equal(stableStringify({}), "{}");
  assert.equal(stableStringify([]), "[]");
  assert.equal(stableStringify({ a: {}, b: [] }), '{"a":{},"b":[]}');
  assert.equal(stableStringify([[], {}]), "[[],{}]");
});

test("hashComparable: empty map is stable, and distinct from every non-empty map", () => {
  assert.equal(hashComparable({}), hashComparable({}));
  assert.notEqual(hashComparable({}), hashComparable({ x: null }));
  assert.notEqual(hashComparable({}), hashComparable({ x: 0 }));
  assert.deepEqual(diffComparable({}, {}), []);
});

// ── 3. recursive key sorting; arrays never sorted ──────────────────

test("stableStringify: keys sorted recursively; array order preserved at every depth", () => {
  assert.equal(stableStringify({ c: 3, a: 1, b: 2 }), '{"a":1,"b":2,"c":3}');
  assert.equal(
    stableStringify({ z: { y: 1, x: 2 }, a: { c: 3, b: 4 } }),
    '{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}',
  );
  assert.equal(
    stableStringify([{ b: 1, a: 2 }, { d: 3, c: 4 }]),
    '[{"a":2,"b":1},{"c":4,"d":3}]',
  );
  assert.equal(stableStringify([3, 1, 2]), "[3,1,2]");
  assert.equal(stableStringify({ a: [3, 1, 2] }), '{"a":[3,1,2]}');
  assert.equal(
    stableStringify({ a: { b: [{ q: 1, p: 2 }, { s: 3, r: 4 }] } }),
    '{"a":{"b":[{"p":2,"q":1},{"r":4,"s":3}]}}',
  );
});

test("stableStringify: key sort is the default lexicographic sort, same as diffComparable", () => {
  // default Array.prototype.sort → UTF-16 code-unit order: "10" < "2".
  assert.equal(stableStringify({ "2": "b", "10": "a" }), '{"10":"a","2":"b"}');
  assert.deepEqual(
    diffComparable({ "10": 1, "2": 1 }, { "10": 9, "2": 9 }).map((d) => d.field),
    ["10", "2"],
  );
});

test("hashComparable / stableStringify are insertion-order independent (deeply)", () => {
  const a: JsonValue = { m: { z: 1, a: [{ q: 1, p: 2 }] }, k: "v" };
  const b: JsonValue = { k: "v", m: { a: [{ p: 2, q: 1 }], z: 1 } };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(
    hashComparable(a as Record<string, JsonValue>),
    hashComparable(b as Record<string, JsonValue>),
  );
});

// ── 4. array element order is significant ──────────────────────────

test("array element order is significant at every depth (arrays are NEVER sorted)", () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  assert.notEqual(
    stableStringify({ a: { b: [1, 2] } }),
    stableStringify({ a: { b: [2, 1] } }),
  );
  assert.notEqual(hashComparable({ a: [1, 2] }), hashComparable({ a: [2, 1] }));
  assert.equal(diffComparable({ a: [1, 2] }, { a: [2, 1] }).length, 1);
});

// ── 5. structural injectivity ──────────────────────────────────────

test("stableStringify: a string value can never collide with a serialized container", () => {
  assert.notEqual(stableStringify("{}"), stableStringify({}));
  assert.notEqual(stableStringify("[]"), stableStringify([]));
  assert.notEqual(stableStringify("[1,2]"), stableStringify([1, 2]));
  assert.notEqual(stableStringify('{"a":1}'), stableStringify({ a: 1 }));
  // a string carrying ':' ',' '{' '}' stays quoted → still no ambiguity
  assert.equal(stableStringify({ k: "x:1,y:{z}" }), '{"k":"x:1,y:{z}"}');
});

test("stableStringify: keys carrying structural punctuation stay quoted+escaped", () => {
  // key literally is  a":1,"b
  assert.equal(stableStringify({ ['a":1,"b']: 2 }), '{"a\\":1,\\"b":2}');
  assert.notEqual(
    stableStringify({ ['a":1,"b']: 2 }),
    stableStringify({ a: 1, b: 2 }),
  );
  assert.notEqual(
    hashComparable({ ['a":1,"b']: 2 } as Record<string, JsonValue>),
    hashComparable({ a: 1, b: 2 }),
  );
});

// ── 6. presence vs explicit null vs value ──────────────────────────

test("presence, explicit null and value are three distinct serializations", () => {
  assert.equal(new Set([
    stableStringify({}),
    stableStringify({ x: null }),
    stableStringify({ x: 0 }),
  ]).size, 3);
  assert.notEqual(hashComparable({}), hashComparable({ x: null }));
  assert.notEqual(hashComparable({ x: null }), hashComparable({ x: 0 }));
  // nested: a nested absent key is distinct from a nested null
  assert.notEqual(
    hashComparable({ o: {} }),
    hashComparable({ o: { x: null } as JsonValue }),
  );
});

// ── 7. the documented hash ⟺ diff invariant, exhaustively ──────────

test("INVARIANT: hashComparable(a) === hashComparable(b)  ⟺  diffComparable(a, b) === []", () => {
  const cases: [Record<string, JsonValue>, Record<string, JsonValue>][] = [
    // ── equal ──
    [{}, {}],
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    [{ a: null }, { a: null }],
    [{ a: {} }, { a: {} }],
    [{ a: [] }, { a: [] }],
    [
      { o: { p: 1, q: [{ y: 2, x: 1 }] } },
      { o: { q: [{ x: 1, y: 2 }], p: 1 } },
    ],
    [{ s: '{"a":1}' }, { s: '{"a":1}' }],
    [{ a: "", b: 0, c: false, d: null }, { d: null, c: false, b: 0, a: "" }],
    // ── not equal ──
    [{}, { a: null }],
    [{ a: null }, {}],
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, {}],
    [{ a: {} }, { a: { x: null } as JsonValue }],
    [{ a: [] }, { a: [null] }],
    [{ a: [1, 2] }, { a: [2, 1] }],
    [{ a: { x: 1 } }, { a: { x: 1, y: 2 } }],
    [{ n: 0 }, { n: false }],
    [{ n: 1 }, { n: "1" }],
    [{ s: '{"a":1}' }, { s: { a: 1 } as unknown as JsonValue }],
    [{ a: null }, { a: 0 }],
  ];
  for (const [a, b] of cases) {
    const hashEqual = hashComparable(a) === hashComparable(b);
    const diffEmpty = diffComparable(a, b).length === 0;
    assert.equal(
      hashEqual,
      diffEmpty,
      `${stableStringify(a)}  vs  ${stableStringify(b)} : hashEqual=${hashEqual} diffEmpty=${diffEmpty}`,
    );
  }
});

// ── 8. hashComparable format & determinism ─────────────────────────

test("hashComparable: 64-char lowercase hex, deterministic across calls and key orders", () => {
  const f = { name: "Depo", lat: 44.8125, lon: 20.4612, isActive: true, website: null };
  const h1 = hashComparable(f);
  assert.match(h1, /^[0-9a-f]{64}$/);
  for (let i = 0; i < 5; i++) assert.equal(hashComparable({ ...f }), h1);
  assert.equal(
    hashComparable({ website: null, isActive: true, lon: 20.4612, lat: 44.8125, name: "Depo" }),
    h1,
  );
});

test("hashComparable: a flat primitives-or-null map (the real production shape) round-trips", () => {
  // shape of `store.ts#comparable()` for a venue
  const a = {
    name: "Klub", normalizedName: "klub", address: null,
    lat: 44.8, lon: 20.5, website: "https://x", wikidata: null,
    openingHours: null, description: null, openingTime: "22:00",
    closingTime: "06:00", isActive: true,
  };
  assert.equal(hashComparable(a), hashComparable({ ...a }));
  assert.deepEqual(diffComparable(a, { ...a }), []);
  assert.notEqual(hashComparable(a), hashComparable({ ...a, openingTime: "23:00" }));
  assert.deepEqual(diffComparable(a, { ...a, openingTime: "23:00" }), [
    { field: "openingTime", from: "22:00", to: "23:00" },
  ]);
});

// ── 9. OUTSIDE the JsonValue contract — invariant still holds ──────

test("[outside-contract] NaN / Infinity serialize as null (JSON has no NaN); hash & diff agree", () => {
  assert.equal(stableStringify(NaN as unknown as JsonValue), "null");
  assert.equal(stableStringify(Infinity as unknown as JsonValue), "null");
  assert.equal(stableStringify(-Infinity as unknown as JsonValue), "null");

  const withNaN = { lat: NaN } as unknown as Record<string, JsonValue>;
  const withNull = { lat: null };
  // a NaN field and a null field are indistinguishable to BOTH the hash and
  // the diff — lossy, but the hash⟺diff invariant is preserved.
  assert.equal(hashComparable(withNaN), hashComparable(withNull));
  assert.deepEqual(diffComparable(withNaN, withNull), []);
});

test("[outside-contract] an explicit `undefined` field value — hash & diff still agree", () => {
  // Store projections coerce with `?? null`, so `undefined` should never reach
  // here. If it did: the key is still PRESENT (`Object.keys` sees it), and both
  // the hash and the diff treat undefined==undefined and undefined!=null.
  const u = () => ({ x: undefined }) as unknown as Record<string, JsonValue>;

  assert.equal(hashComparable(u()), hashComparable(u()));
  assert.deepEqual(diffComparable(u(), u()), []);

  assert.notEqual(hashComparable(u()), hashComparable({ x: null }));
  assert.equal(diffComparable(u(), { x: null }).length, 1);

  assert.notEqual(hashComparable(u()), hashComparable({}));
  assert.equal(diffComparable(u(), {}).length, 1);
});

test("[outside-contract] hashComparable(non-object) — a top-level non-map input throws loudly", () => {
  // `hashComparable`'s contract is `Record<string, JsonValue>`. A bare
  // `undefined` makes `stableStringify` return `undefined`, which `createHash`
  // rejects — it fails loud, never silently hashes to a constant.
  assert.throws(() => hashComparable(undefined as unknown as Record<string, JsonValue>), TypeError);
});
