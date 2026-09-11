import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENV_FILE_PATH,
  loadConfig,
  loadEnvFile,
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

// ════════════════════════════════════════════════════════════════════════
//  AUDIT PASS — characterization of ENV_FILE_PATH / loadEnvFile / the
//  missing-key + trimming contract, and no-secret-leakage guarantees.
//  No production behavior is asserted that the module did not already have.
// ════════════════════════════════════════════════════════════════════════

const FAKE_SECRET = "s3cr3t-VALUE-should-never-appear-anywhere-x9f2";

// ── ENV_FILE_PATH: absolute, points at ingestion/.env, cwd-independent ──

test("[env-path] ENV_FILE_PATH is absolute and resolves to <ingestion>/.env from the module location", () => {
  assert.equal(isAbsolute(ENV_FILE_PATH), true);
  assert.equal(basename(ENV_FILE_PATH), ".env");
  // parent dir is the ingestion workspace root, and this test file lives in
  // <ingestion>/test — so they must share the same workspace root.
  assert.equal(basename(dirname(ENV_FILE_PATH)), "ingestion");
  const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url))); // <ingestion>
  assert.equal(ENV_FILE_PATH, join(workspaceRoot, ".env"));
  // never a compiled-output path
  assert.equal(ENV_FILE_PATH.includes(`${sep}dist${sep}`), false);
});

test("[env-path] ENV_FILE_PATH does not change when the process cwd changes", () => {
  // The child keeps cwd = <ingestion> so `--import tsx` resolves, then chdirs to
  // an unrelated directory BEFORE importing config.ts. A cwd-relative resolution
  // would now point somewhere under the temp dir.
  const modUrl = new URL("../src/config.ts", import.meta.url).href;
  const otherCwd = mkdtempSync(join(tmpdir(), "config-cwd-"));
  const script =
    `process.chdir(${JSON.stringify(otherCwd)});` +
    `import(${JSON.stringify(modUrl)}).then(m => process.stdout.write(m.ENV_FILE_PATH));`;
  try {
    const fromElsewhere = execFileSync(
      process.execPath,
      ["--import", "tsx", "-e", script],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(fromElsewhere, ENV_FILE_PATH);
    assert.equal(fromElsewhere.includes("config-cwd-"), false);
  } finally {
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

// ── loadEnvFile ───────────────────────────────────────────────────────

test("[env-file] a missing file is fine: existed=false, no keys, path echoed verbatim", () => {
  const missing = join(tmpdir(), `definitely-absent-${Date.now()}.env`);
  const result = loadEnvFile(missing);
  assert.deepEqual(result, { path: missing, existed: false, parsedKeys: [] });
});

test("[env-file] a present file: existed=true, parsedKeys are NAMES ONLY, values never surface", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-present-"));
  const path = join(dir, ".env");
  const KEY = `AUDIT_PROBE_${Date.now()}`;
  writeFileSync(path, `${KEY}=${FAKE_SECRET}\nAUDIT_PROBE_EMPTY=\n`);
  const saved = process.env[KEY];
  try {
    delete process.env[KEY];
    const result = loadEnvFile(path);
    assert.equal(result.path, path);
    assert.equal(result.existed, true);
    assert.deepEqual(result.parsedKeys, [KEY, "AUDIT_PROBE_EMPTY"]);
    // the value went into process.env but is NOWHERE in the returned structure
    assert.equal(process.env[KEY], FAKE_SECRET);
    assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    delete process.env.AUDIT_PROBE_EMPTY;
    delete process.env[KEY];
    if (saved !== undefined) process.env[KEY] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[env-file] override:false — a value already in process.env is NOT replaced by the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-override-"));
  const path = join(dir, ".env");
  const PRESET = `AUDIT_PRESET_${Date.now()}`;
  const FRESH = `AUDIT_FRESH_${Date.now()}`;
  writeFileSync(path, `${PRESET}=from-file\n${FRESH}=from-file\n`);
  try {
    process.env[PRESET] = "from-real-env";
    delete process.env[FRESH];
    const result = loadEnvFile(path);
    assert.equal(process.env[PRESET], "from-real-env", "real env wins");
    assert.equal(process.env[FRESH], "from-file", "unset key is filled from the file");
    // parsedKeys still reflects the FILE contents, not what was injected
    assert.deepEqual(result.parsedKeys.sort(), [FRESH, PRESET].sort());
  } finally {
    delete process.env[PRESET];
    delete process.env[FRESH];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[env-file][characterization] dotenv is lenient: a junk-laced file does NOT throw, valid lines are still parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-junk-"));
  const path = join(dir, ".env");
  writeFileSync(path, 'this is not valid\n=noKeyName\nGOOD_ONE=yes\n"dangling');
  try {
    const result = loadEnvFile(path);
    assert.equal(result.existed, true);
    assert.deepEqual(result.parsedKeys, ["GOOD_ONE"]);
  } finally {
    delete process.env.GOOD_ONE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[env-file] a present-but-unreadable path throws, names the path, leaks no value, and mutates nothing", () => {
  // A directory at the path: existsSync() is true, the read fails (EISDIR).
  const dir = mkdtempSync(join(tmpdir(), "env-unreadable-"));
  const asDir = join(dir, ".env");
  mkdirSync(asDir);
  const SENTINEL = `AUDIT_SENTINEL_${Date.now()}`;
  try {
    delete process.env[SENTINEL];
    assert.throws(
      () => loadEnvFile(asDir),
      (error: Error) => {
        assert.match(error.message, /could not read it/);
        assert.ok(error.message.includes(asDir), "message names the path");
        assert.equal(error.message.includes(FAKE_SECRET), false);
        return true;
      },
    );
    assert.equal(process.env[SENTINEL], undefined, "no partial mutation on the throw path");
  } finally {
    delete process.env[SENTINEL];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[env-file] the returned path is always exactly the path that was checked", () => {
  const weird = join(tmpdir(), "no", "such", "dir", `x-${Date.now()}.env`);
  assert.equal(loadEnvFile(weird).path, weird);
});

// ── missingRequiredKeys: blank detection, ordering, no leakage ─────────

test("[missing-keys] undefined / '' / spaces / tabs+newlines all count as missing", () => {
  for (const blank of [undefined, "", "   ", "\t", "\n", " \t\r\n "]) {
    const env =
      blank === undefined
        ? { SUPABASE_SERVICE_ROLE_KEY: "x" }
        : { SUPABASE_URL: blank, SUPABASE_SERVICE_ROLE_KEY: "x" };
    assert.deepEqual(missingRequiredKeys(env), ["SUPABASE_URL"], JSON.stringify(blank));
  }
});

test("[missing-keys] a value with surrounding whitespace but real content is NOT missing", () => {
  assert.deepEqual(
    missingRequiredKeys({
      SUPABASE_URL: "  https://x.supabase.co  ",
      SUPABASE_SERVICE_ROLE_KEY: "\tkey\t",
    }),
    [],
  );
});

test("[missing-keys] ordering follows REQUIRED_KEYS and is deterministic; output holds only names", () => {
  const out = missingRequiredKeys({});
  assert.deepEqual(out, [...REQUIRED_KEYS]);
  // stable across calls
  assert.deepEqual(missingRequiredKeys({}), out);
  // only names, never values
  const withSecrets = missingRequiredKeys({ SUPABASE_SERVICE_ROLE_KEY: "  " });
  assert.deepEqual(withSecrets, [...REQUIRED_KEYS]);
});

// ── loadConfig: trimming, optional defaults, error hygiene ────────────

test("[load-config] whitespace-only OVERPASS_URL / OVERPASS_USER_AGENT fall back to the defaults", () => {
  const config = loadConfig({
    ...PLACEHOLDER_ENV,
    OVERPASS_URL: "   ",
    OVERPASS_USER_AGENT: "\t\n",
  });
  assert.equal(config.overpassUrl, "https://overpass-api.de/api/interpreter");
  assert.match(config.overpassUserAgent, /nightlife-app-ingestion/);
});

test("[load-config] optional values with surrounding whitespace are trimmed, not defaulted", () => {
  const config = loadConfig({
    ...PLACEHOLDER_ENV,
    OVERPASS_URL: "  https://op.example/api  ",
    OVERPASS_USER_AGENT: "  agent/9  ",
  });
  assert.equal(config.overpassUrl, "https://op.example/api");
  assert.equal(config.overpassUserAgent, "agent/9");
});

test("[load-config] the missing-key error names the keys and the .env path, never a value", () => {
  assert.throws(
    () => loadConfig({ SUPABASE_URL: "ok", SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET.slice(0, 0) }),
    (error: Error) => {
      assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY/);
      assert.ok(error.message.includes(ENV_FILE_PATH), "points the user at the .env path");
      assert.match(error.message, /never printed/i);
      return true;
    },
  );
});

test("[load-config] a populated config never stringifies to include values that came from a throwing path", () => {
  // sanity: the happy-path config obviously DOES contain its own values — this
  // asserts only that loadConfig does not, e.g., attach the whole env to the
  // returned object.
  const config = loadConfig({ ...PLACEHOLDER_ENV, UNRELATED_SECRET: FAKE_SECRET });
  assert.equal(JSON.stringify(config).includes(FAKE_SECRET), false);
  assert.deepEqual(Object.keys(config).sort(), [
    "overpassUrl",
    "overpassUserAgent",
    "supabaseServiceRoleKey",
    "supabaseUrl",
  ]);
});
