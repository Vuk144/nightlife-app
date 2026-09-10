/**
 * `../../src/sync/index.ts` — the sync public-surface barrel.
 *
 * The barrel is pure `export * from "./<module>.ts"`: no logic, no side effects.
 * These are characterization guards for the EXPORT SURFACE — `tsc` already
 * proves every re-export path type-checks, but it does NOT catch a symbol
 * silently dropped by an `export *` name collision, a module accidentally
 * removed from the barrel, or a submodule gaining a throw-on-import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as barrel from "../../src/sync/index.ts";
import { planSync } from "../../src/sync/engine.ts";
import { InMemoryCanonicalStore, comparable } from "../../src/sync/store.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { InMemoryConfigProvider } from "../../src/sync/config.ts";

// Representative — one public symbol per re-exported module.
const EXPECTED_FUNCTIONS = [
  "planSync", // engine.ts
  "formatSyncPlan", // report.ts
  "validateRecord", // validation.ts
  "resolveVenueIdentity", // venue-identity.ts
  "resolveEventIdentity", // event-identity.ts
  "detectChange", // change-detection.ts
  "diffComparable", // change-detection.ts
  "stableStringify", // canonical-hash.ts
  "hashComparable", // canonical-hash.ts
  "planReconciliation", // reconcile.ts
  "localToInstant", // time-zone.ts
  "profileFor", // normalization.ts
  "cityKey", // config.ts
  "comparable", // store.ts (also re-exported by supabase-store.ts — same binding)
  "venueComparable", // store.ts
] as const;

const EXPECTED_CLASSES = [
  "InMemoryCanonicalStore", // store.ts
  "SupabaseCanonicalStore", // supabase-store.ts
  "InMemoryConfigProvider", // config.ts
] as const;

const EXPECTED_VALUES = [
  "DEFAULT_RECONCILIATION", // config.ts
  "PLACEHOLDER_REGEX_FLAGS", // config.ts
  "latinProfile", // normalization.ts
  "serbianProfile", // normalization.ts
] as const;

test("importing the barrel has no side effects and does not throw", () => {
  // (reaching this line already proves the static import above resolved)
  assert.equal(typeof barrel, "object");
  assert.ok(Object.keys(barrel).length >= 25, `barrel exposes ${Object.keys(barrel).length} runtime symbols`);
});

test("every re-exported module contributes its key public function", () => {
  for (const name of EXPECTED_FUNCTIONS) {
    assert.equal(
      typeof (barrel as Record<string, unknown>)[name],
      "function",
      `barrel is missing function export "${name}" (an export * collision or a dropped module?)`,
    );
  }
});

test("the store / config classes are re-exported as constructors", () => {
  for (const name of EXPECTED_CLASSES) {
    const ctor = (barrel as Record<string, unknown>)[name];
    assert.equal(typeof ctor, "function", `barrel is missing class export "${name}"`);
    assert.match(String(ctor), /^class\b/, `"${name}" should be a class`);
  }
});

test("shared constants / profile singletons are re-exported", () => {
  for (const name of EXPECTED_VALUES) {
    assert.notEqual(
      (barrel as Record<string, unknown>)[name],
      undefined,
      `barrel is missing value export "${name}"`,
    );
  }
});

test("barrel re-exports are the SAME bindings as the direct module imports (no aliasing / copying)", () => {
  assert.equal(barrel.planSync, planSync);
  assert.equal(barrel.InMemoryCanonicalStore, InMemoryCanonicalStore);
  assert.equal(barrel.SupabaseCanonicalStore, SupabaseCanonicalStore);
  assert.equal(barrel.InMemoryConfigProvider, InMemoryConfigProvider);
  // `comparable` is exported by BOTH store.ts and supabase-store.ts; the barrel
  // must still expose the one, shared declaration (not drop it as ambiguous).
  assert.equal(barrel.comparable, comparable);
});

test("the in-memory SourceAdapter test double is deliberately NOT on the public barrel", () => {
  assert.equal(
    (barrel as Record<string, unknown>).createInMemoryAdapter,
    undefined,
    "adapters/in-memory.ts is a test fixture — it must not leak into the public surface",
  );
});
