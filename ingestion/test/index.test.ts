/**
 * Characterization of the venue ingestion runner entry point
 * (`../src/index.ts`).
 *
 * `src/index.ts` has no exports — it calls `main()` at module load — so it can
 * only be exercised as a child process. These tests pin the parts that matter
 * for a scheduled runner: the startup/exit-code contract, that a configuration
 * problem never prints the service-role key, that `--dry-run` is matched
 * exactly, and that one failing target does not abort the rest.
 *
 * Every case forces an early, hermetic failure (blank / malformed / unreachable
 * Supabase URL) so nothing here touches a real database or the Overpass API.
 * `SUPABASE_SERVICE_ROLE_KEY` is always overridden with a sentinel, so the real
 * `ingestion/.env` value is never loaded into the child.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INGESTION_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** A stand-in for the privileged key. If this string ever appears in the
 *  runner's output, index.ts leaked the service-role-key slot. */
const SENTINEL_KEY = "SENTINEL-svc-role-value-must-never-be-printed-q9z";

function runCli(
  args: string[],
  env: Record<string, string>,
): { code: number | null; out: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", ...args],
    {
      cwd: INGESTION_DIR,
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const BLANK_CONFIG = { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY };

// ── startup: missing configuration ───────────────────────────────────

test("[startup] missing SUPABASE_URL -> 'Configuration error', exit 1, no DRY RUN banner, no key leak", () => {
  const { code, out } = runCli(["--dry-run"], BLANK_CONFIG);
  assert.equal(code, 1);
  assert.match(out, /Configuration error: Missing or empty required variable\(s\): SUPABASE_URL/);
  assert.match(out, /Values are never printed/);
  // loadConfig() throws before createServiceClient / the banner
  assert.doesNotMatch(out, /DRY RUN/);
  // the "env:" line reports key NAMES only …
  assert.match(out, /env: (loaded .*\(keys:[^)]*SUPABASE_URL[^)]*\)|no file at )/);
  // … and the privileged-key slot value is never echoed anywhere
  assert.equal(out.includes(SENTINEL_KEY), false);
});

// ── startup: argument handling is deliberately minimal ───────────────

test("[startup] unknown / repeated / near-miss args are tolerated, never crash the runner", () => {
  const { code, out } = runCli(
    ["--dry-run", "--dry-run", "--verbose", "--verbose", "--what=1", "--dry-runX", "-v", "positional"],
    BLANK_CONFIG,
  );
  // still the clean, handled config-error exit — not a parse crash
  assert.equal(code, 1);
  assert.match(out, /Configuration error/);
  assert.doesNotMatch(out, /Unexpected error/);
});

// ── startup: a malformed (but non-empty) URL still fails safely ──────

test("[startup] a malformed non-empty SUPABASE_URL fails safely: exit 1, no key leak", () => {
  // loadConfig() only checks non-emptiness; createServiceClient() runs OUTSIDE
  // the startup try/catch, so supabase-js's URL rejection surfaces through
  // main().catch() as 'Unexpected error' rather than 'Configuration error'.
  // The outcome is still a clean exit 1 with nothing sensitive printed.
  const { code, out } = runCli(["--dry-run"], {
    SUPABASE_URL: "not-a-url",
    SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY,
  });
  assert.equal(code, 1);
  assert.match(out, /Unexpected error: Invalid supabaseUrl/);
  assert.equal(out.includes(SENTINEL_KEY), false);
});

// ── dry run: banner, per-target isolation, duration line ────────────

test("[dry-run] banner prints, a failing target is isolated, 'Done in' still prints, exit 1", { timeout: 40_000 }, () => {
  const { code, out } = runCli(["--dry-run"], {
    SUPABASE_URL: "http://127.0.0.1:1", // resolvable, connection refused
    SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY,
  });
  assert.equal(code, 1);
  assert.match(out, /DRY RUN — fetch \+ match only, no writes\./);
  assert.match(out, /\[dry run\]: FAILED/);   // caught by the per-target try/catch
  assert.match(out, /\nDone in .*s/);          // loop path always reports duration
  assert.equal(out.includes(SENTINEL_KEY), false);
});

test("[dry-run] '--dry-runX' is not '--dry-run' (exact match): no banner, no [dry run] label", { timeout: 40_000 }, () => {
  const { code, out } = runCli(["--dry-runX"], {
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY,
  });
  assert.equal(code, 1);
  assert.doesNotMatch(out, /DRY RUN — fetch/);
  assert.doesNotMatch(out, /\[dry run\]/);
});
