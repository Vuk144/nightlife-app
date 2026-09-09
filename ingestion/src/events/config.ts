/**
 * Event-ingestion configuration.
 *
 * Layered on top of the shared `../config.ts` (Supabase URL + service-role
 * key). Supabase is read ONLY — the event dry run never writes — but it reuses
 * the same service client the venue pipeline uses.
 *
 * The event-source settings below are plain constants with optional env
 * overrides; they carry no secrets.
 */

import { loadEnvFile, type EnvFileResult } from "../config.ts";

export const DEFAULT_GIGSTIX_BASE_URL = "https://new.gigstix.com";

export const DEFAULT_INGEST_USER_AGENT =
  "nightlife-app-ingestion/0.1 (+https://github.com/Vuk144/nightlife-app-v2)";

/** Default region scope + zone. GIGS TIX is a Serbian ticketing platform. */
export const DEFAULT_COUNTRIES = ["RS"];
export const DEFAULT_TIME_ZONE = "Europe/Belgrade";

/**
 * Cities for which an event-first venue may become `safe_new_venue`. Other
 * cities' new venues fall to `needs_review` — the venue DB is Belgrade-only for
 * the pilot. A new city is a config change, not a code change.
 */
export const DEFAULT_EVENT_FIRST_CITIES = ["Belgrade"];

/**
 * Per-run ceiling on how many NEW event-first venues could eventually be
 * auto-created. A safety guard for the future write-enabled phase: excess
 * candidates are reported and marked `needs_review`, never silently dropped.
 */
export const DEFAULT_EVENT_FIRST_MAX_NEW_VENUES = 50;

/** Event sources trusted to seed venues in this pilot. */
export const DEFAULT_TRUSTED_SOURCES = ["gigstix"];

export interface EventsConfig {
  gigstixBaseUrl: string;
  userAgent: string;
  eventFirstCities: string[];
  eventFirstMaxNewVenues: number;
  trustedSources: string[];
}

function csv(value: string | undefined, fallback: string[]): string[] {
  const parts = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Copy the fallback — never hand a caller a reference to the exported
  // `DEFAULT_*` array, or a mutation would leak into every later call.
  return parts.length > 0 ? parts : [...fallback];
}

export function loadEventsConfig(
  env: NodeJS.ProcessEnv = process.env,
): EventsConfig {
  // An unset OR empty/whitespace value means "use the default" (as every other
  // override here does) — only an explicit number, including "0", overrides.
  const capText = env.EVENT_FIRST_MAX_NEW_VENUES?.trim();
  const capRaw = capText ? Number(capText) : Number.NaN;
  return {
    gigstixBaseUrl:
      env.GIGSTIX_BASE_URL?.trim().replace(/\/+$/, "") ||
      DEFAULT_GIGSTIX_BASE_URL,
    userAgent: env.INGEST_USER_AGENT?.trim() || DEFAULT_INGEST_USER_AGENT,
    eventFirstCities: csv(env.EVENT_FIRST_CITIES, DEFAULT_EVENT_FIRST_CITIES),
    eventFirstMaxNewVenues:
      Number.isFinite(capRaw) && capRaw >= 0
        ? Math.floor(capRaw)
        : DEFAULT_EVENT_FIRST_MAX_NEW_VENUES,
    trustedSources: csv(env.EVENT_FIRST_TRUSTED_SOURCES, DEFAULT_TRUSTED_SOURCES),
  };
}

/**
 * Startup helper for the CLI: load `ingestion/.env` into `process.env` FIRST,
 * then read the events config from the now-populated environment.
 *
 * `loadEventsConfig()` reads `process.env` eagerly, so the `.env` file — the
 * project's documented config mechanism — must be applied before it runs, or
 * every `.env`-only override (GIGSTIX_BASE_URL, INGEST_USER_AGENT,
 * EVENT_FIRST_CITIES, EVENT_FIRST_MAX_NEW_VENUES, EVENT_FIRST_TRUSTED_SOURCES)
 * is silently ignored and only real shell variables take effect.
 */
export function loadEventsRuntime(envFilePath?: string): {
  envFile: EnvFileResult;
  config: EventsConfig;
} {
  const envFile = loadEnvFile(envFilePath);
  return { envFile, config: loadEventsConfig() };
}
