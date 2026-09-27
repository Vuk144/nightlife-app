/**
 * `npm run sync:osm` — the OpenStreetMap sync through the generic engine.
 *
 *   npm run sync:osm              PLAN ONLY (default): fetch + parse + plan +
 *                                 report. Zero database writes.
 *   npm run sync:osm -- --commit  plan, then apply it via
 *                                 `SupabaseCanonicalStore.apply` — only when the
 *                                 run is ok and healthy.
 *
 * Wiring only: the OSM adapter + config provider (`./adapters/osm-overpass.ts`),
 * `./runner.ts#runSync` (plan → optional apply) and `SupabaseCanonicalStore`
 * (the only write boundary). Configuration comes from `ingestion/.env` / the
 * environment via `../config.ts`, exactly as the legacy runner does; the
 * service-role key is never printed.
 *
 * Every dependency with a side effect is injectable, so the tests run with no
 * network and no Supabase.
 */

import { relative } from "node:path";
import { loadConfig, loadEnvFile, type Config, type EnvFileResult } from "../config.ts";
import { createServiceClient } from "../supabase.ts";
import { TARGETS, type IngestionTarget } from "../targets.ts";
import type { OverpassResponse } from "../types.ts";
import {
  OSM_SOURCE_KEY,
  createOsmConfigProvider,
  createOsmOverpassAdapter,
} from "./adapters/osm-overpass.ts";
import { formatRunReport, runSucceeded, runSync, type SyncMode } from "./runner.ts";
import type { CanonicalStore } from "./store.ts";
import { SupabaseCanonicalStore } from "./supabase-store.ts";

export const OSM_SYNC_USAGE = "Usage: npm run sync:osm [-- --commit]";

export type ParsedOsmSyncArgs = { ok: true; mode: SyncMode } | { ok: false; error: string };

/** `--commit` is the ONLY accepted argument; anything else is an error. */
export function parseOsmSyncArgs(argv: string[]): ParsedOsmSyncArgs {
  let mode: SyncMode = "plan";
  for (const arg of argv) {
    if (arg === "--commit") mode = "commit";
    else return { ok: false, error: `unknown argument "${arg}"` };
  }
  return { ok: true, mode };
}

export interface OsmSyncCliDeps {
  /** Environment to read configuration from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Loads `ingestion/.env` into the environment. Default `../config.ts#loadEnvFile`. */
  loadEnvFile?: () => EnvFileResult;
  targets?: IngestionTarget[];
  /** Default: `SupabaseCanonicalStore` over the service-role client. */
  createStore?: (config: Config) => CanonicalStore;
  /** Overpass transport. Default: the real one (`fetchOverpass`). */
  transport?: (query: string, config: Config) => Promise<OverpassResponse>;
  /** Logical run timestamp. Default: now. */
  now?: () => string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Runs the command; resolves to the process exit code. */
export async function runOsmSyncCli(argv: string[], deps: OsmSyncCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => console.log(t));
  const err = deps.err ?? ((t: string) => console.error(t));

  const args = parseOsmSyncArgs(argv);
  if (!args.ok) {
    err(`\n${args.error}\n${OSM_SYNC_USAGE}\n`);
    return 1;
  }

  let config: Config;
  try {
    const envFile = (deps.loadEnvFile ?? loadEnvFile)();
    const shown = relative(process.cwd(), envFile.path) || envFile.path;
    out(
      envFile.existed
        ? `env: loaded ${shown} (keys: ${envFile.parsedKeys.join(", ") || "none"})`
        : `env: no file at ${shown} — using the process environment`,
    );
    config = loadConfig(deps.env ?? process.env);
  } catch (error) {
    err(`\nConfiguration error: ${(error as Error).message}\n`);
    return 1;
  }

  try {
    const targets = deps.targets ?? TARGETS;
    const provider = createOsmConfigProvider(targets);
    const source = provider.source(OSM_SOURCE_KEY);
    if (!source) throw new Error(`no "${OSM_SOURCE_KEY}" source in the OSM sync config`);
    const adapter = createOsmOverpassAdapter({ targets, config, transport: deps.transport });
    const store = (deps.createStore ?? ((c: Config) => new SupabaseCanonicalStore(createServiceClient(c))))(config);
    const now = (deps.now ?? (() => new Date().toISOString()))();

    out(args.mode === "commit" ? "MODE: COMMIT — writes will be applied if the plan is healthy" : "MODE: PLAN ONLY — no database writes");
    const outcome = await runSync({
      adapter,
      source,
      config: provider,
      store,
      now,
      runId: `osm-${now}`,
      mode: args.mode,
    });
    out(
      formatRunReport(
        outcome,
        targets.map((t) => `${t.cityName} (${t.countryId}, relation ${t.osmRelationId})`),
      ),
    );
    return runSucceeded(outcome) ? 0 : 1;
  } catch (error) {
    err(`\nsync:osm failed: ${(error as Error).message}\n`);
    return 1;
  }
}
