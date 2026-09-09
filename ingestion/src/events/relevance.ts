/**
 * Deterministic nightlife / music relevance classifier for event sources.
 *
 * GIGS TIX (and every later source) is broader than this app. An event is
 * imported only when the EVENT ITSELF carries a genuine music / nightlife /
 * performance signal — never merely because of the venue it is in. A concert
 * hall or a serious music venue is fully in scope when the event has that
 * signal; it is not excluded for being a concert hall.
 *
 * The classifier errs toward RECALL for genuine music/nightlife and toward
 * REJECTION for events with no such signal. Every rejection carries a reason.
 *
 * Pure and deterministic: same input -> same result, no I/O, no clock.
 */

import { tokenize } from "./text.ts";
import {
  CAT_FESTIVAL,
  CAT_GENERIC,
  CAT_MUSIC,
  CAT_NEWYEAR,
  CAT_SPORT,
  CAT_STANDUP,
  CAT_THEATRE,
  HARD_NEGATIVE,
  KIDS,
  MUSIC_STRONG,
  NIGHTLIFE_SECONDARY,
  NON_MUSIC_FESTIVAL,
} from "./relevance-keywords.ts";

export type RelevanceTier = "primary" | "secondary";

export type RelevanceResult =
  | { accepted: true; tier: RelevanceTier; reason: string }
  | { accepted: false; reason: string };

export interface RelevanceInput {
  title: string;
  description?: string;
  /** `eventcat-*` slugs with the `eventcat-` prefix removed. */
  categories: string[];
  /** Source-stated event-type label(s), e.g. `"Koncert"`. */
  eventType?: string;
  lineup?: { name: string }[];
  /**
   * Resolved venue category from our DB, if known. Informational only — it is
   * NOT used to accept or reject. Kept on the signature so callers can pass it
   * for the dry-run report without a second lookup.
   */
  venueCategory?: string | null;
}

function hasAny(tokens: Set<string>, against: Set<string>): string | null {
  for (const token of against) {
    if (tokens.has(token)) return token;
  }
  return null;
}

/**
 * Classify one event.
 *
 * Order:
 *   1. decisive source categories (koncert / festival / stand-up / docek /
 *      pozoriste / sport) — these are curated by GIGS TIX editors and outrank
 *      loose keyword matches in the free text;
 *   2. for everything else, a hard-negative keyword gate (fairs, talks,
 *      exhibitions, sport, theatre, kids, motoring);
 *   3. then keyword evidence about the EVENT itself — a strong music word is
 *      enough for `primary`, a nightlife word for `secondary`;
 *   4. otherwise reject, with the reason.
 *
 * The venue is never consulted. Pure and deterministic.
 */
export function classifyRelevance(input: RelevanceInput): RelevanceResult {
  const cats = new Set(input.categories.map((c) => c.toLowerCase()));
  const textTokens = new Set([
    ...tokenize(input.title),
    ...tokenize(input.description ?? ""),
    ...tokenize(input.eventType ?? ""),
    ...(input.lineup ?? []).flatMap((p) => tokenize(p.name)),
  ]);
  const kids = hasAny(textTokens, KIDS);

  // 1. Decisive source categories.
  if (cats.has(CAT_MUSIC)) {
    return { accepted: true, tier: "primary", reason: 'category "koncert"' };
  }
  if (cats.has(CAT_FESTIVAL)) {
    // Music evidence wins even over a non-music marker (a concert at a wine
    // fest is still a concert) — recall bias for genuine music.
    const strong = hasAny(textTokens, MUSIC_STRONG);
    if (strong) {
      return { accepted: true, tier: "primary", reason: `festival + music keyword "${strong}"` };
    }
    const nonMusic = hasAny(textTokens, NON_MUSIC_FESTIVAL);
    if (nonMusic) {
      return { accepted: false, reason: `festival, non-music marker "${nonMusic}"` };
    }
    // A kids marker keeps the event out even as a festival-secondary — the same
    // rule the `stand-up` branch applies (see KIDS). Confirmed strong music
    // above still wins.
    if (kids) {
      return { accepted: false, reason: `festival, kids marker "${kids}"` };
    }
    return { accepted: true, tier: "secondary", reason: "festival, music not confirmed by keyword" };
  }
  if (cats.has(CAT_STANDUP)) {
    if (kids) return { accepted: false, reason: `stand-up, kids marker "${kids}"` };
    return {
      accepted: true,
      tier: "secondary",
      reason: 'category "stand-up" (nightlife-adjacent comedy)',
    };
  }
  if (cats.has(CAT_NEWYEAR)) {
    // `docek` only ever accepts at SECONDARY, so a kids marker rejects it —
    // same as `stand-up` (see KIDS).
    if (kids) {
      return { accepted: false, reason: `New Year event, kids marker "${kids}"` };
    }
    const party =
      hasAny(textTokens, NIGHTLIFE_SECONDARY) ?? hasAny(textTokens, MUSIC_STRONG);
    return party
      ? { accepted: true, tier: "secondary", reason: `New Year event + "${party}"` }
      : { accepted: false, reason: "New Year event with no music/party signal" };
  }
  if (cats.has(CAT_THEATRE) || cats.has(CAT_SPORT)) {
    return {
      accepted: false,
      reason: `category "${cats.has(CAT_THEATRE) ? CAT_THEATRE : CAT_SPORT}"`,
    };
  }

  // 2. No decisive category (e.g. "dogadjaj" or only venue-group cats):
  //    hard-negative keyword gate.
  const negative = hasAny(textTokens, HARD_NEGATIVE) ?? kids;
  if (negative) {
    return { accepted: false, reason: `hard-negative keyword "${negative}"` };
  }

  // 3. Keyword evidence about the event itself.
  const strong = hasAny(textTokens, MUSIC_STRONG);
  if (strong) {
    return { accepted: true, tier: "primary", reason: `music keyword "${strong}"` };
  }
  const secondary = hasAny(textTokens, NIGHTLIFE_SECONDARY);
  if (secondary) {
    return { accepted: true, tier: "secondary", reason: `nightlife keyword "${secondary}"` };
  }

  // 4. No signal.
  if (cats.has(CAT_GENERIC)) {
    return { accepted: false, reason: 'category "dogadjaj" with no music/nightlife signal' };
  }
  return { accepted: false, reason: "no music or nightlife signal found" };
}
