/**
 * Characterization of the event-ingestion dry-run entry point
 * (`../../src/events/index.ts`).
 *
 * Like `../index.test.ts` (the venue runner's counterpart), this module has no
 * exports — it calls `main()` at module load — so it can only be exercised as a
 * child process. These tests pin the parts that matter for this entry point's
 * own contract: `--source` validation, the startup ordering that made a real
 * `.env`-load-order bug possible before (see `events/config.test.ts`'s
 * `loadEventsRuntime` regression — this file checks that `index.ts` still wires
 * that helper's output into `SourceContext` correctly, not the helper itself),
 * that Supabase being unavailable degrades rather than aborts the run, the
 * exit-code contract, and that the service-role key is never leaked.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is always overridden with a sentinel and
 * `GIGSTIX_BASE_URL` is pointed at an unreachable local address, so nothing
 * here touches the real GIGS TIX site, a real database, or the developer's
 * actual `ingestion/.env` values (dotenv's `override:false` means an
 * already-set env var always wins over the file).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INGESTION_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** A stand-in for the privileged key. If this string ever appears in the
 *  runner's output, index.ts leaked the service-role-key slot. */
const SENTINEL_KEY = "SENTINEL-svc-role-value-must-never-be-printed-q9z";

function runCli(
  args: string[],
  env: Record<string, string>,
): { code: number | null; out: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/events/index.ts", ...args],
    {
      cwd: INGESTION_DIR,
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// A resolvable-but-refusing address: fails fast (no DNS wait), never reaches
// the real network, and forces `httpGetText` through its real retry/back-off
// path deterministically (~9s: two retries at 3s/6s) rather than hanging.
const UNREACHABLE = "http://127.0.0.1:1";
const BLANK_CONFIG = { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY };

// ── startup: --source validation ──────────────────────────────────────

test("[startup] no --source -> usage + exit 1, before any env loading or network", () => {
  const { code, out } = runCli([], BLANK_CONFIG);
  assert.equal(code, 1);
  assert.match(out, /Usage: npm run ingest:events:dry -- --source <name>/);
  assert.match(out, /Available sources: gigstix/);
  // the usage check runs BEFORE loadEventsRuntime() / the Supabase block
  assert.doesNotMatch(out, /^env: /m);
  assert.doesNotMatch(out, /DRY RUN/);
  assert.doesNotMatch(out, /venue resolution/);
});

test("[startup] a trailing --source with no value is treated as missing, not a crash", () => {
  const { code, out } = runCli(["--source"], BLANK_CONFIG);
  assert.equal(code, 1);
  assert.match(out, /Usage: npm run ingest:events:dry/);
  assert.doesNotMatch(out, /Unexpected error/);
});

test("[startup] an unknown --source -> usage + exit 1, listing the real available sources", () => {
  const { code, out } = runCli(["--source", "bogus"], BLANK_CONFIG);
  assert.equal(code, 1);
  assert.match(out, /Available sources: gigstix/);
  assert.doesNotMatch(out, /DRY RUN/);
});

test("[startup] repeated / garbled / unknown flags are tolerated and never crash the runner (exact --source match; last one wins)", () => {
  const { code, out } = runCli(
    ["--source", "--source", "--verbose", "--verbose", "--what=1", "--source=gigstixX", "-v", "positional"],
    BLANK_CONFIG,
  );
  // the LAST --source= wins ("gigstixX"), which is not a configured adapter,
  // so this still lands on the clean, handled usage/exit-1 path — not a parse
  // crash and not a fuzzy/partial match against "gigstix"
  assert.equal(code, 1);
  assert.match(out, /Usage: npm run ingest:events:dry/);
  assert.doesNotMatch(out, /Unexpected error/);
});

// ── main flow: Supabase optional, discovery failure, exit code, secrecy ──

test(
  "[main flow] Supabase unavailable warns and continues (not fatal); a source failure still fails the run, exits 1, shows the limit, and never leaks the service-role key",
  { timeout: 40_000 },
  () => {
    const { code, out } = runCli(["--source", "gigstix", "--limit", "3"], {
      ...BLANK_CONFIG,
      GIGSTIX_BASE_URL: UNREACHABLE,
    });

    // env line reports key NAMES only (or that no file exists) — never values
    assert.match(out, /^env: (loaded .*\(keys:.*\)|no file at )/m);

    // Supabase is optional here: a config failure warns and the run continues
    // — this is NOT the venue CLI's fatal "Configuration error" path.
    assert.match(out, /venue resolution unavailable:/);
    assert.match(out, /continuing without it/);
    assert.doesNotMatch(out, /Configuration error/);

    // the DRY RUN banner still prints, with the requested limit
    assert.match(out, /DRY RUN — gigstix — READ ONLY \(no writes, no migration, no schedule\)\s+\[limit 3\]/);

    // discovery itself fails (unreachable base URL) -> engine reports a
    // source-level "failed" run -> the CLI's exit-code contract kicks in
    assert.equal(code, 1);
    assert.match(out, /discovery failed:/);

    // the privileged key slot is never echoed anywhere, in either outcome
    assert.equal(out.includes(SENTINEL_KEY), false);
  },
);

test(
  "[main flow] no --limit -> the DRY RUN banner omits the [limit N] suffix",
  { timeout: 40_000 },
  () => {
    const { out } = runCli(["--source", "gigstix"], {
      ...BLANK_CONFIG,
      GIGSTIX_BASE_URL: UNREACHABLE,
    });
    assert.match(out, /DRY RUN — gigstix — READ ONLY \(no writes, no migration, no schedule\)\n/);
  },
);
