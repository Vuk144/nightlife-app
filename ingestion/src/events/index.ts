/**
 * Event ingestion — DRY RUN CLI.
 *
 *   npm run ingest:events:dry -- --source gigstix [--limit N] [--verbose]
 *
 * This command is READ-ONLY. It fetches from the source and reads `venues` /
 * `cities` from Supabase to resolve venues, but it performs NO writes, applies
 * NO migration, and never enables scheduled ingestion. It prints an auditable
 * plan and exits.
 */

import { relative } from "node:path";
import { loadConfig } from "../config.ts";
import { createServiceClient } from "../supabase.ts";
import {
  DEFAULT_COUNTRIES,
  DEFAULT_TIME_ZONE,
  loadEventsRuntime,
  type EventsConfig,
} from "./config.ts";
import type { EnvFileResult } from "../config.ts";
import { gigstixAdapter } from "./adapters/gigstix.ts";
import { runEventDryRun } from "./engine.ts";
import { formatReport } from "./report.ts";
import { createVenueResolver, type VenueResolver } from "./venue-resolve.ts";
import type { EventSourceAdapter, SourceContext } from "./types.ts";

const ADAPTERS: Record<string, EventSourceAdapter> = {
  gigstix: gigstixAdapter,
};

interface Args {
  source: string | null;
  limit: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  let source: string | null = null;
  let limit = 0;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") source = argv[++i] ?? null;
    else if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
    else if (arg === "--limit") limit = Number(argv[++i]);
    else if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--dry-run") {
      /* always a dry run — accepted for symmetry with the venue runner */
    }
  }
  return { source, limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0, verbose };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.source || !ADAPTERS[args.source]) {
    console.error(
      `\nUsage: npm run ingest:events:dry -- --source <name> [--limit N] [--verbose]\n` +
        `Available sources: ${Object.keys(ADAPTERS).join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const adapter = ADAPTERS[args.source];

  // Load `ingestion/.env` into `process.env` BEFORE reading the events config —
  // `loadEventsConfig()` reads the environment eagerly, so a `.env`-only
  // override would otherwise never reach it.
  let eventsConfig: EventsConfig;
  let envFile: EnvFileResult;
  try {
    const runtime = loadEventsRuntime();
    envFile = runtime.envFile;
    eventsConfig = runtime.config;
  } catch (error) {
    console.error(`\nConfiguration error: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const shownEnvPath = relative(process.cwd(), envFile.path) || envFile.path;
  console.log(
    envFile.existed
      ? `env: loaded ${shownEnvPath}${envFile.parsedKeys.length ? ` (keys: ${envFile.parsedKeys.join(", ")})` : ""}`
      : `env: no file at ${shownEnvPath} — using the process environment`,
  );

  const ctx: SourceContext = {
    countries: DEFAULT_COUNTRIES,
    cities: [],
    defaultTimeZone: DEFAULT_TIME_ZONE,
    userAgent: eventsConfig.userAgent,
    baseUrl: eventsConfig.gigstixBaseUrl,
    limit: args.limit,
    verbose: args.verbose,
  };

  // ---- Supabase (read-only) — optional but expected --------------------
  let resolver: VenueResolver | null = null;
  try {
    const config = loadConfig();
    const supabase = createServiceClient(config);
    resolver = await createVenueResolver(supabase, {
      countryIds: DEFAULT_COUNTRIES,
      sourceKey: adapter.key,
      sourceTrusted: eventsConfig.trustedSources.includes(adapter.key),
      enabledCities: eventsConfig.eventFirstCities,
      fetchSourceVenue: adapter.fetchSourceVenue
        ? (id) => adapter.fetchSourceVenue!(id, ctx)
        : undefined,
    });
    console.log(
      `venue resolution: ready — venues in: ${resolver.knownCities.join(", ") || "none"}` +
        ` | event-first enabled for: ${resolver.enabledCities.join(", ")}` +
        ` | source trusted: ${eventsConfig.trustedSources.includes(adapter.key)}` +
        ` | per-run cap: ${eventsConfig.eventFirstMaxNewVenues}`,
    );
  } catch (error) {
    console.warn(
      `\nvenue resolution unavailable: ${(error as Error).message}\n` +
        `continuing without it — discovery, parsing and relevance still run.\n`,
    );
  }

  console.log(
    `\nDRY RUN — ${adapter.key} — READ ONLY (no writes, no migration, no schedule)` +
      (args.limit ? `  [limit ${args.limit}]` : ""),
  );

  const report = await runEventDryRun({
    adapter,
    ctx,
    resolver,
    eventFirstMaxNewVenues: eventsConfig.eventFirstMaxNewVenues,
  });
  console.log(formatReport(report, { verbose: args.verbose }));

  if (report.stats.status === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Unexpected error: ${(error as Error).message}`);
  process.exitCode = 1;
});
