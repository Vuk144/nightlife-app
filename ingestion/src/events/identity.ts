/**
 * Event identity + cross-source deduplication signals.
 *
 * For this milestone only ONE source (GIGS TIX) is active, so its own
 * `externalId` is the identity and no cross-source merging happens. The signal
 * computation and band classifier are built now — deterministically and
 * unit-tested — so a second source is a wiring change, not a redesign.
 *
 * Pure and deterministic. No fuzzy / ML matching.
 */

import { computeNameNormalized } from "../name.ts";
import { sha1, tokenize } from "./text.ts";
import { localDatePart, localMinutesBetween } from "./time.ts";
import type { NormalizedEvent } from "./types.ts";

export interface EventIdentity {
  /** Per-source key: `"<sourceKey>:<externalId>"`. The identity for one source. */
  sourceKey: string;
  /** Cross-source candidate bucket: hash of (venue key + local date). */
  identityKey: string;
  /** `"venue:<uuid>"` when resolved, else `"name:<normalized venue name>"`. */
  venueKey: string;
  /** `YYYY-MM-DD` in the event's local zone. */
  localDate: string;
}

/**
 * Compute the identity of one source event. `resolvedVenueId` is the id of the
 * matched `venues` row, or null when the venue is unresolved / event-first.
 */
export function computeIdentity(
  sourceKey: string,
  event: NormalizedEvent,
  resolvedVenueId: string | null,
): EventIdentity {
  const venueKey = resolvedVenueId
    ? `venue:${resolvedVenueId}`
    : event.venue.name
      ? `name:${computeNameNormalized(event.venue.name)}`
      : `city:${computeNameNormalized(event.venue.city ?? "unknown")}`;
  const localDate = localDatePart(event.startLocal);
  return {
    sourceKey: `${sourceKey}:${event.externalId}`,
    identityKey: sha1(`${venueKey}|${localDate}`),
    venueKey,
    localDate,
  };
}

// ---------------------------------------------------------------------------
//  Cross-source comparison (not wired to any write path in this milestone)
// ---------------------------------------------------------------------------

export type DedupBand = "automatic" | "probable" | "separate" | "ambiguous";

export interface DedupSignals {
  sameVenue: boolean;
  sameLocalDate: boolean;
  startDeltaMinutes: number | null;
  /** Jaccard overlap of significant title tokens, 0..1. */
  titleSimilarity: number;
  sharedTicketId: boolean;
  promoterMatch: boolean;
}

export interface DedupComparison {
  signals: DedupSignals;
  band: DedupBand;
  rationale: string;
}

/** Tokens too generic to carry identity weight in a title comparison. */
const TITLE_STOPWORDS = new Set([
  "live",
  "uzivo",
  "koncert",
  "concert",
  "tour",
  "turneja",
  "in",
  "beograd",
  "belgrade",
  "novi",
  "sad",
  "nis",
  "srbija",
  "serbia",
  "the",
  "and",
  "i",
  "vs",
  "feat",
  "with",
  "sa",
  "gostima",
  "open",
  "air",
  "party",
  "show",
]);

function significantTitleTokens(title: string): Set<string> {
  return new Set(tokenize(title).filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

function ticketIdOf(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/(?:sectionGroup\/index|event|e)\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Compare two source events for the same real-world night. Venue equality is a
 * PRECONDITION for any merge: different resolved venues => `separate`.
 * Ambiguous cases are never merged — they are held for review.
 */
export function compareEvents(
  a: NormalizedEvent,
  aVenueId: string | null,
  b: NormalizedEvent,
  bVenueId: string | null,
): DedupComparison {
  const sameVenue =
    aVenueId != null && bVenueId != null
      ? aVenueId === bVenueId
      : computeNameNormalized(a.venue.name) === computeNameNormalized(b.venue.name);

  const sameLocalDate = localDatePart(a.startLocal) === localDatePart(b.startLocal);
  const startDeltaMinutes = localMinutesBetween(a.startLocal, b.startLocal);
  const titleSimilarity = jaccard(
    significantTitleTokens(a.title),
    significantTitleTokens(b.title),
  );
  const aTicket = ticketIdOf(a.ticketUrl);
  const bTicket = ticketIdOf(b.ticketUrl);
  const sharedTicketId = aTicket != null && aTicket === bTicket;
  const promoterMatch =
    !!a.promoter &&
    !!b.promoter &&
    computeNameNormalized(a.promoter) === computeNameNormalized(b.promoter);

  const signals: DedupSignals = {
    sameVenue,
    sameLocalDate,
    startDeltaMinutes,
    titleSimilarity,
    sharedTicketId,
    promoterMatch,
  };

  if (!sameVenue) {
    return { signals, band: "separate", rationale: "different resolved venue" };
  }
  if (sharedTicketId) {
    return { signals, band: "automatic", rationale: "same venue + shared ticket id" };
  }
  const closeInTime =
    startDeltaMinutes != null ? startDeltaMinutes <= 90 : sameLocalDate;
  if (closeInTime && (titleSimilarity >= 0.6 || promoterMatch)) {
    return {
      signals,
      band: "automatic",
      rationale: "same venue + same night + (title match or promoter match)",
    };
  }
  if (sameLocalDate && (titleSimilarity >= 0.4 || promoterMatch)) {
    return {
      signals,
      band: "probable",
      rationale: "same venue + same date + one weak corroborating signal",
    };
  }
  if (
    !sameLocalDate ||
    (startDeltaMinutes != null && startDeltaMinutes > 240)
  ) {
    return { signals, band: "separate", rationale: "same venue but different night" };
  }
  return { signals, band: "ambiguous", rationale: "insufficient evidence — hold for review" };
}
