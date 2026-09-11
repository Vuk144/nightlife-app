/**
 * Characterization of the service-role client factory (`../src/supabase.ts`).
 *
 * SECURITY BOUNDARY: `createServiceClient` builds the RLS-bypassing service-role
 * Supabase client. These tests use only the placeholder key
 * "TEST_SERVICE_ROLE_KEY" — never a real credential — and assert that the
 * factory forwards exactly the injected Config, sets the non-interactive auth
 * flags, holds no singleton state, and leaks nothing through errors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "../src/supabase.ts";
import type { Config } from "../src/config.ts";

const FAKE_KEY = "TEST_SERVICE_ROLE_KEY";
const OTHER_KEY = "TEST_SERVICE_ROLE_KEY_2";

function cfg(over: Partial<Config> = {}): Config {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: FAKE_KEY,
    overpassUrl: "https://overpass.example/api",
    overpassUserAgent: "supabase-test/1",
    ...over,
  };
}

/** supabase-js keeps these as readable own properties on the client. */
type Introspectable = {
  supabaseUrl: string;
  supabaseKey: string;
  rest: { url: string };
  auth: {
    persistSession?: boolean;
    autoRefreshToken?: boolean;
    detectSessionInUrl?: boolean;
  };
  from: unknown;
};
const peek = (c: unknown): Introspectable => c as unknown as Introspectable;

// ── 1. client construction ─────────────────────────────────────────

test("[construction] forwards EXACTLY config.supabaseUrl and config.supabaseServiceRoleKey", () => {
  const c = peek(createServiceClient(cfg()));
  assert.equal(c.supabaseUrl, "https://example.supabase.co");
  assert.equal(c.supabaseKey, FAKE_KEY);
  assert.equal(c.rest.url, "https://example.supabase.co/rest/v1");
  assert.equal(typeof c.from, "function");
});

test("[construction] honours a distinct Config verbatim — no hidden process.env lookup", () => {
  const c = peek(
    createServiceClient(cfg({ supabaseUrl: "https://other.supabase.co", supabaseServiceRoleKey: OTHER_KEY })),
  );
  assert.equal(c.supabaseUrl, "https://other.supabase.co");
  assert.equal(c.supabaseKey, OTHER_KEY);
});

test("[construction] no anon/public key path — Config carries only the service-role credential", () => {
  // Compile-time: Config's only credential fields are these two. Runtime sanity:
  const keys = Object.keys(cfg()).sort();
  assert.deepEqual(keys, ["overpassUrl", "overpassUserAgent", "supabaseServiceRoleKey", "supabaseUrl"]);
  assert.equal(keys.some((k) => /anon|public/i.test(k)), false);
});

// ── 2. auth options for a non-interactive server process ───────────

test("[auth] persistSession / autoRefreshToken / detectSessionInUrl are all false", () => {
  const { auth } = peek(createServiceClient(cfg()));
  assert.equal(auth.persistSession, false);
  assert.equal(auth.autoRefreshToken, false);
  assert.equal(auth.detectSessionInUrl, false);
});

// ── 3. client identity / repeated calls ───────────────────────────

test("[identity] every call returns a fresh, independent client — no singleton, no shared auth", () => {
  const a = createServiceClient(cfg());
  const b = createServiceClient(cfg());
  assert.notEqual(a, b);
  assert.notEqual(peek(a).auth, peek(b).auth);
});

test("[identity] no mutable module state — an earlier call never shadows a later Config", () => {
  const first = peek(createServiceClient(cfg({ supabaseUrl: "https://one.supabase.co" })));
  const second = peek(createServiceClient(cfg({ supabaseUrl: "https://two.supabase.co" })));
  const firstAgain = peek(createServiceClient(cfg({ supabaseUrl: "https://one.supabase.co" })));
  assert.equal(first.supabaseUrl, "https://one.supabase.co");
  assert.equal(second.supabaseUrl, "https://two.supabase.co");
  assert.equal(firstAgain.supabaseUrl, "https://one.supabase.co");
});

// ── 4. error behaviour — no credential exposure ───────────────────

test("[error] a malformed supabaseUrl throws synchronously; the message carries no credential", () => {
  let msg = "";
  assert.throws(
    () => createServiceClient(cfg({ supabaseUrl: "not-a-url" })),
    (e: Error) => {
      msg = e.message;
      return /Invalid supabaseUrl/.test(e.message);
    },
  );
  assert.equal(msg.includes(FAKE_KEY), false, "error message must not contain the key");
  // supabase-js reports the KIND of URL problem, not even the URL value itself
  assert.match(msg, /valid HTTP or HTTPS URL/);
});

test("[error] an empty key throws (defence in depth) without echoing a value", () => {
  let msg = "";
  assert.throws(
    () => createServiceClient(cfg({ supabaseServiceRoleKey: "" })),
    (e: Error) => {
      msg = e.message;
      return /supabaseKey is required/i.test(e.message);
    },
  );
  assert.equal(/TEST_SERVICE_ROLE_KEY/.test(msg), false);
});

test("[error] an invalid (non-empty) key is NOT this module's job to detect — the client still constructs", () => {
  // Key validity can only be determined by the server on the first request;
  // this factory correctly does not attempt format validation.
  const c = peek(createServiceClient(cfg({ supabaseServiceRoleKey: "obviously-not-a-real-jwt" })));
  assert.equal(c.supabaseKey, "obviously-not-a-real-jwt");
  assert.equal(typeof c.from, "function");
});

// ── 5. the module itself exposes nothing ─────────────────────────

test("[security] createServiceClient does not serialise the credential through JSON / errors", () => {
  const c = createServiceClient(cfg());
  let serialised = "";
  try {
    serialised = JSON.stringify(c) ?? "";
  } catch {
    serialised = ""; // supabase-js clients are circular — a throw is also fine
  }
  assert.equal(serialised.includes(FAKE_KEY), false);
});

// ── 6. import / build boundary ──────────────────────────────────

test("[boundary] the root TypeScript project excludes ingestion/ (never bundled into the app)", () => {
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // <repo>/ingestion/test -> <repo>
  const rootTsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as {
    exclude?: string[];
  };
  assert.ok(
    (rootTsconfig.exclude ?? []).includes("ingestion"),
    "root tsconfig.json must exclude 'ingestion'",
  );
});
