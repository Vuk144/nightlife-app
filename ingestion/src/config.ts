/**
 * Runtime configuration for the ingestion runner.
 *
 * `ingestion/.env` (git-ignored) is loaded by ABSOLUTE PATH resolved from this
 * module — never relative to the current working directory — so it is found
 * whether the runner is started with `npm run` from `ingestion/`, with
 * `npm --prefix ingestion run ...` from the repo root, or from a scheduler.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is privileged and RLS-bypassing. It lives only
 * here (in `ingestion/.env` / the process environment) and is never printed —
 * only key *names* and emptiness are ever surfaced.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_USER_AGENT =
  "nightlife-app-ingestion/0.1 (+https://github.com/Vuk144/nightlife-app-v2)";

/** Absolute path to `ingestion/.env`, resolved from this file's location. */
export const ENV_FILE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".env",
);

export const REQUIRED_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  overpassUrl: string;
  overpassUserAgent: string;
}

export interface EnvFileResult {
  /** Absolute path that was checked. */
  path: string;
  /** Whether a file existed there. */
  existed: boolean;
  /** Names — never values — of the keys parsed from the file. */
  parsedKeys: string[];
}

/**
 * Load `ingestion/.env` into `process.env` by absolute path. Variables already
 * present in the real environment are NOT overridden. A missing file is fine
 * (values may come from the environment); a present-but-unreadable file throws.
 * Only key names are ever exposed.
 */
export function loadEnvFile(path: string = ENV_FILE_PATH): EnvFileResult {
  if (!existsSync(path)) {
    return { path, existed: false, parsedKeys: [] };
  }
  const result = dotenvConfig({ path, override: false });
  if (result.error) {
    throw new Error(
      `Found an env file at ${path} but could not read it: ${result.error.message}`,
    );
  }
  return { path, existed: true, parsedKeys: Object.keys(result.parsed ?? {}) };
}

/**
 * Names of REQUIRED_KEYS that are absent or blank in `env`. Only emptiness is
 * inspected — a value's contents are never read or logged.
 */
export function missingRequiredKeys(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return REQUIRED_KEYS.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim().length === 0;
  });
}

/** Build the typed config from `env`, or throw listing the missing keys. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = missingRequiredKeys(env);
  if (missing.length > 0) {
    throw new Error(
      `Missing or empty required variable(s): ${missing.join(", ")}. ` +
        `Set them in ${ENV_FILE_PATH} (copy ingestion/.env.example), then SAVE the file. ` +
        `Values are never printed.`,
    );
  }
  return {
    supabaseUrl: env.SUPABASE_URL!.trim(),
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    overpassUrl: env.OVERPASS_URL?.trim() || DEFAULT_OVERPASS_URL,
    overpassUserAgent: env.OVERPASS_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  };
}
