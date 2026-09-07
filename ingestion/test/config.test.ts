import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  missingRequiredKeys,
  REQUIRED_KEYS,
} from "../src/config.ts";

/**
 * These tests only ever use obvious placeholder strings. They verify that the
 * loader DETECTS required variables as present/non-empty vs absent/blank —
 * they never assert on, log, or depend on any real credential value.
 */
const PLACEHOLDER_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "placeholder-not-a-real-key",
} satisfies Record<string, string>;

test("missingRequiredKeys: all keys reported when the env is empty", () => {
  assert.deepEqual(missingRequiredKeys({}), [...REQUIRED_KEYS]);
});

test("missingRequiredKeys: keys present but blank are still 'missing'", () => {
  assert.deepEqual(
    missingRequiredKeys({
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "   ",
    }),
    [...REQUIRED_KEYS],
  );
});

test("missingRequiredKeys: nothing missing when every key is non-empty", () => {
  assert.deepEqual(missingRequiredKeys({ ...PLACEHOLDER_ENV }), []);
});

test("loadConfig: throws and names every missing/blank key", () => {
  assert.throws(
    () => loadConfig({ SUPABASE_URL: "" }),
    (error: Error) =>
      /SUPABASE_URL/.test(error.message) &&
      /SUPABASE_SERVICE_ROLE_KEY/.test(error.message),
  );
});

test("loadConfig: succeeds with non-empty values and applies Overpass defaults", () => {
  const config = loadConfig({ ...PLACEHOLDER_ENV });
  assert.equal(config.supabaseUrl, PLACEHOLDER_ENV.SUPABASE_URL);
  assert.ok(config.supabaseServiceRoleKey.length > 0);
  assert.equal(config.overpassUrl, "https://overpass-api.de/api/interpreter");
  assert.match(config.overpassUserAgent, /nightlife-app-ingestion/);
});

test("loadConfig: trims surrounding whitespace from required values", () => {
  const config = loadConfig({
    SUPABASE_URL: "  https://example.supabase.co  ",
    SUPABASE_SERVICE_ROLE_KEY: "  abc  ",
  });
  assert.equal(config.supabaseUrl, "https://example.supabase.co");
  assert.equal(config.supabaseServiceRoleKey, "abc");
});

test("loadConfig: honours OVERPASS_URL / OVERPASS_USER_AGENT overrides", () => {
  const config = loadConfig({
    ...PLACEHOLDER_ENV,
    OVERPASS_URL: "https://overpass.example/api",
    OVERPASS_USER_AGENT: "custom-agent/1.0",
  });
  assert.equal(config.overpassUrl, "https://overpass.example/api");
  assert.equal(config.overpassUserAgent, "custom-agent/1.0");
});
