/**
 * Dry-run ingestion engine.
 *
 * Orchestrates one source, read-only:
 *   discover -> fetch -> parse -> relevance -> event-first venue resolution
 *   -> identity -> aggregate event-first candidates -> report
 *
 * It performs NO database writes. Per-event failures (a bad fetch, an
 * unparseable page, an unresolved venue) are counted and reported, never fatal.
 * A source-level failure (discovery throws, or nothing is discovered) makes the
 * whole run `failed`; a high fetch- or parse-failure rate makes it `degraded`.
 */

import { classifyRelevance, type RelevanceResult } from "./relevance.ts";
import { computeIdentity, type EventIdentity } from "./identity.ts";
import {
  aggregateEventFirstCandidates,
  type EventFirstAggregate,
} from "./event-first.ts";
import type {
  EventRef,
  EventSourceAdapter,
  NormalizedEvent,
  SourceContext,
} from "./types.ts";
import type { EventVenueResolution, VenueResolver } from "./venue-resolve.ts";

export interface DryRunScope {
  countries: string[];
  cities: string[];
}

export interface VenueResolutionStats {
  matchedExisting: number;
  safeNewVenue: number;
  needsReview: number;
  rejected: number;
  /** matched_existing, by matcher tier. */
  byTier: Record<string, number>;
  /** every reason code seen across all resolutions. */
  reasonCodes: Record<string, number>;
}

export interface DryRunStats {
  source: string;
  scope: DryRunScope;
  discovered: number;
  fetched: number;
  fetchFailed: number;
  parsed: number;
  parseFailed: number;
  accepted: number;
  acceptedPrimary: number;
  acceptedSecondary: number;
  rejected: number;
  /**
   * Events that fetched AND parsed, but then hit an UNEXPECTED exception in a
   * post-parse stage (relevance / venue resolution / identity). Never a normal
   * outcome — always a bug or an unhandled data shape. Reported as `stage:
   * "error"` items and, when non-zero, forces the run to `degraded`.
   */
  processFailed: number;
  rejectionReasons: Record<string, number>;
  parseFailureReasons: Record<string, number>;
  fetchFailureReasons: Record<string, number>;
  processFailureReasons: Record<string, number>;
  /** Accepted events that name a specific venue (the ones we resolve). */
  venuesNamed: number;
  /** Accepted events that name only a city, no venue. */
  noVenueInSource: number;
  venueResolution: VenueResolutionStats;
  venueResolutionSkipped: boolean;
  plannedCanonicalInserts: number;
  durationMs: number;
  status: "ok" | "degraded" | "failed";
  notes: string[];
}

export interface DryRunItem {
  url: string;
  lastmod?: string;
  stage: "fetch-failed" | "parse-failed" | "rejected" | "accepted" | "error";
  reason?: string;
  event?: NormalizedEvent;
  relevance?: RelevanceResult;
  venue?: EventVenueResolution;
  identity?: EventIdentity;
}

export interface DryRunReport {
  stats: DryRunStats;
  items: DryRunItem[];
  eventFirst: EventFirstAggregate;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function emptyStats(source: string, scope: DryRunScope): DryRunStats {
  return {
    source,
    scope,
    discovered: 0,
    fetched: 0,
    fetchFailed: 0,
    parsed: 0,
    parseFailed: 0,
    accepted: 0,
    acceptedPrimary: 0,
    acceptedSecondary: 0,
    rejected: 0,
    processFailed: 0,
    rejectionReasons: {},
    parseFailureReasons: {},
    fetchFailureReasons: {},
    processFailureReasons: {},
    venuesNamed: 0,
    noVenueInSource: 0,
    venueResolution: {
      matchedExisting: 0,
      safeNewVenue: 0,
      needsReview: 0,
      rejected: 0,
      byTier: {},
      reasonCodes: {},
    },
    venueResolutionSkipped: false,
    plannedCanonicalInserts: 0,
    durationMs: 0,
    status: "ok",
    notes: [],
  };
}

export async function runEventDryRun(opts: {
  adapter: EventSourceAdapter;
  ctx: SourceContext;
  resolver: VenueResolver | null;
  eventFirstMaxNewVenues: number;
}): Promise<DryRunReport> {
  const { adapter, ctx, resolver, eventFirstMaxNewVenues } = opts;
  const startedAt = Date.now();
  const stats = emptyStats(adapter.key, {
    countries: ctx.countries,
    cities: ctx.cities,
  });
  const items: DryRunItem[] = [];
  const resolutions: EventVenueResolution[] = [];
  const canonicalKeys = new Set<string>();

  // ---- discovery ------------------------------------------------------
  const refs: EventRef[] = [];
  try {
    for await (const ref of adapter.discover(ctx)) {
      refs.push(ref);
      if (ctx.limit > 0 && refs.length >= ctx.limit) break;
    }
  } catch (error) {
    stats.status = "failed";
    stats.notes.push(`discovery failed: ${(error as Error).message}`);
    stats.durationMs = Date.now() - startedAt;
    return { stats, items, eventFirst: aggregateEventFirstCandidates([], { maxNewVenues: eventFirstMaxNewVenues }) };
  }
  stats.discovered = refs.length;
  if (refs.length === 0) {
    stats.status = "failed";
    stats.notes.push("discovery returned no events");
    stats.durationMs = Date.now() - startedAt;
    return { stats, items, eventFirst: aggregateEventFirstCandidates([], { maxNewVenues: eventFirstMaxNewVenues }) };
  }

  if (!resolver) {
    stats.venueResolutionSkipped = true;
    stats.notes.push(
      "venue resolution skipped — no Supabase credentials; venue keys are name-based",
    );
  }

  /**
   * A parsed event whose POST-PARSE processing (relevance / venue resolution /
   * identity) threw an unexpected exception. Isolated exactly like a fetch/parse
   * failure: one item, one counter bump, the run keeps going. Never silent — the
   * message is preserved and `stats.processFailed` forces `degraded`.
   */
  const recordProcessFailure = (
    r: EventRef,
    ev: NormalizedEvent,
    error: unknown,
  ): void => {
    stats.processFailed++;
    bump(stats.processFailureReasons, "exception");
    items.push({
      url: r.url,
      lastmod: r.lastmod,
      stage: "error",
      reason: `unexpected error: ${(error as Error).message}`,
      event: ev,
    });
  };

  // ---- per-event -----------------------------------------------------
  for (const ref of refs) {
    let raw;
    try {
      raw = await adapter.fetch(ref, ctx);
    } catch (error) {
      stats.fetchFailed++;
      bump(stats.fetchFailureReasons, "network/timeout");
      items.push({
        url: ref.url,
        lastmod: ref.lastmod,
        stage: "fetch-failed",
        reason: (error as Error).message,
      });
      continue;
    }

    if (raw.status >= 400 || raw.status < 200) {
      stats.fetchFailed++;
      bump(stats.fetchFailureReasons, `HTTP ${raw.status}`);
      items.push({
        url: ref.url,
        lastmod: ref.lastmod,
        stage: "fetch-failed",
        reason: `HTTP ${raw.status}`,
      });
      continue;
    }
    stats.fetched++;

    let parsed;
    try {
      parsed = adapter.parse(raw, ctx);
    } catch (error) {
      stats.parseFailed++;
      bump(stats.parseFailureReasons, "exception");
      items.push({
        url: ref.url,
        lastmod: ref.lastmod,
        stage: "parse-failed",
        reason: `exception: ${(error as Error).message}`,
      });
      continue;
    }
    if (!parsed.ok) {
      stats.parseFailed++;
      bump(stats.parseFailureReasons, parsed.reason);
      items.push({
        url: ref.url,
        lastmod: ref.lastmod,
        stage: "parse-failed",
        reason: parsed.detail ? `${parsed.reason} (${parsed.detail})` : parsed.reason,
      });
      continue;
    }
    stats.parsed++;
    const event = parsed.event;

    // ---- relevance (the classify call can throw on a malformed event) ---
    let relevance: RelevanceResult;
    try {
      const reported = event.reported as {
        categories?: string[];
        eventTypeText?: string | null;
      };
      relevance = classifyRelevance({
        title: event.title,
        description: event.description,
        categories: reported.categories ?? [],
        eventType: reported.eventTypeText ?? undefined,
        lineup: event.lineup,
      });
    } catch (error) {
      recordProcessFailure(ref, event, error);
      continue;
    }
    if (!relevance.accepted) {
      stats.rejected++;
      bump(stats.rejectionReasons, relevance.reason);
      items.push({
        url: ref.url,
        lastmod: ref.lastmod,
        stage: "rejected",
        reason: relevance.reason,
        event,
        relevance,
      });
      continue;
    }

    // ---- venue resolution + identity ---------------------------------
    // Every fallible step (`resolver.resolve`, `computeIdentity`) runs FIRST;
    // stats + the item are committed only after all of them succeed. So an
    // unexpected throw here leaves every counter untouched and yields exactly
    // one `stage: "error"` item — the accepted-family counters are never
    // half-incremented for an event that did not finish processing.
    try {
      const namesVenue = !!event.venue.name;
      let venue: EventVenueResolution | undefined;
      let resolvedVenueId: string | null = null;
      if (namesVenue && resolver) {
        venue = await resolver.resolve(event, relevance.tier);
        if (venue.status === "matched_existing") resolvedVenueId = venue.matchedVenueId;
      }
      const identity = computeIdentity(adapter.key, event, resolvedVenueId);

      // ---- commit (no fallible calls past this point) ----
      stats.accepted++;
      if (relevance.tier === "primary") stats.acceptedPrimary++;
      else stats.acceptedSecondary++;

      if (!namesVenue) {
        stats.noVenueInSource++;
      } else {
        stats.venuesNamed++;
        if (venue) {
          resolutions.push(venue);
          const vr = stats.venueResolution;
          for (const code of venue.reasonCodes) bump(vr.reasonCodes, code);
          switch (venue.status) {
            case "matched_existing":
              vr.matchedExisting++;
              if (venue.matchTier != null) bump(vr.byTier, `tier ${venue.matchTier}`);
              break;
            case "safe_new_venue":
              vr.safeNewVenue++;
              break;
            case "needs_review":
              vr.needsReview++;
              break;
            case "rejected":
              vr.rejected++;
              break;
          }
        }
      }

      if (!canonicalKeys.has(identity.sourceKey)) {
        canonicalKeys.add(identity.sourceKey);
        stats.plannedCanonicalInserts++;
      }

      items.push({
        url: ref.url,
        lastmod: ref.lastmod,
        stage: "accepted",
        event,
        relevance,
        venue,
        identity,
      });
    } catch (error) {
      recordProcessFailure(ref, event, error);
      continue;
    }
  }

  // ---- aggregate event-first candidates (dedup + per-run cap) ------
  let eventFirst: EventFirstAggregate;
  try {
    eventFirst = aggregateEventFirstCandidates(resolutions, {
      maxNewVenues: eventFirstMaxNewVenues,
    });
  } catch (error) {
    // A post-processing step must not silently produce a "successful" report.
    eventFirst = {
      candidates: [],
      safeCount: 0,
      needsReviewCount: 0,
      capLimit: eventFirstMaxNewVenues,
      capExceeded: false,
      demotedByCap: 0,
    };
    stats.status = "degraded";
    stats.notes.push(
      `event-first aggregation failed: ${(error as Error).message} — candidate list omitted from this report`,
    );
  }
  if (eventFirst.capExceeded) {
    stats.notes.push(
      `per-run cap (${eventFirst.capLimit}) exceeded — ${eventFirst.demotedByCap} safe candidate(s) demoted to needs_review`,
    );
  }

  // ---- run health --------------------------------------------------
  stats.durationMs = Date.now() - startedAt;
  if (stats.fetchFailed > 0 && stats.fetchFailed / stats.discovered >= 0.5) {
    stats.status = "degraded";
    stats.notes.push(
      `high fetch-failure rate: ${stats.fetchFailed}/${stats.discovered}`,
    );
  }
  const parseAttempts = stats.parsed + stats.parseFailed;
  if (parseAttempts > 0 && stats.parseFailed / parseAttempts >= 0.3) {
    stats.status = "degraded";
    stats.notes.push(
      `high parse-failure rate: ${stats.parseFailed}/${parseAttempts} — adapter may need attention`,
    );
  }
  if (stats.processFailed > 0) {
    // A post-parse processing error is always unexpected (a bug or an
    // unhandled data shape), so even one drops the run to `degraded`.
    stats.status = "degraded";
    stats.notes.push(
      `${stats.processFailed} event(s) hit an unexpected post-parse processing error — see stage:"error" items`,
    );
  }
  stats.notes.push(
    "events table not read — every accepted event is counted as a planned canonical insert",
  );
  stats.notes.push(
    "no database writes: venue resolution and event-first candidates are analysis only",
  );

  return { stats, items, eventFirst };
}
