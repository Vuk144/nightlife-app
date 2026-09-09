/**
 * Generic event identity resolution.
 *
 * A thin adapter over the event pipeline's existing deterministic comparison
 * (`../events/identity.ts#compareEvents`). No new fuzzy matching.
 *
 *   Tier 0  exact source key + external id  (same source, same record)
 *   Tier 1  an existing source-link row already points at a canonical event
 *   Tier 2  EXACTLY ONE candidate at the resolved venue whose `compareEvents`
 *           band is "automatic" — a confident, unique merge
 *   Tier 3  otherwise a new candidate
 *
 * Ambiguity (decision "ambiguous", `canonicalId: null`) when there is no unique
 * automatic match but the field is not clean: two or more automatic candidates,
 * or at least one "probable" / "ambiguous" candidate. Held for review, never
 * auto-merged, never handed back as a canonical id.
 *
 * Determinism: EVERY candidate at the resolved venue is evaluated before the
 * decision is made, so the outcome cannot depend on candidate array order.
 * Venue equality is a PRECONDITION for any Tier 2 merge — two events at
 * different venues are always separate.
 */

import { compareEvents } from "../events/identity.ts";
import type { NormalizedEvent } from "../events/types.ts";
import type { IdentityOutcome, SourceRef } from "./types.ts";

export interface EventIdentityInput {
  source: SourceRef;
  title: string;
  /** Local wall-clock start. */
  startLocal: string;
  ticketUrl: string | null;
  promoter: string | null;
  /**
   * UNUSED as an identity signal today: `../events/identity.ts#compareEvents`
   * does not consult lineup, so `shim()` below does not pass it. Carried on the
   * input for parity with `NormalizedEvent` and so a future identity rule can
   * use it without re-plumbing the caller. Do not add a lineup comparison to
   * `compareEvents` as part of unrelated work.
   */
  lineup: string[];
  /** Venue name as the source stated it (fallback identity when unresolved). */
  venueName: string;
}

export interface CanonicalEventForMatch {
  id: string;
  venueId: string;
  title: string;
  startLocal: string;
  ticketUrl: string | null;
  promoter: string | null;
}

export interface EventIdentityRequest {
  incoming: EventIdentityInput;
  /** From the venue identity pass; null when the venue is unresolved / new. */
  resolvedVenueId: string | null;
  /** Tier 0 — a canonical event already carries this (sourceKey, externalId). */
  existingBySource: { canonicalId: string } | null;
  /** Tier 1 — a source-link (`event_sources`) row already points at a canonical event. */
  existingLink: { canonicalId: string } | null;
  /** Tier 2 pool — canonical events at the same venue on/near the same date. */
  candidates: CanonicalEventForMatch[];
}

/** Minimal `NormalizedEvent` shim — only the fields `compareEvents` reads. */
function shim(
  title: string,
  startLocal: string,
  venueName: string,
  ticketUrl: string | null,
  promoter: string | null,
): NormalizedEvent {
  return {
    externalId: "",
    sourceUrl: "",
    title,
    startLocal,
    startPrecision: startLocal.length > 10 ? "datetime" : "date",
    venue: { name: venueName },
    ticketUrl: ticketUrl ?? undefined,
    promoter: promoter ?? undefined,
    reported: {},
  };
}

export function resolveEventIdentity(req: EventIdentityRequest): IdentityOutcome {
  if (req.existingBySource) {
    return {
      entity: "event",
      decision: "matched",
      tier: 0,
      canonicalId: req.existingBySource.canonicalId,
      reasonCode: "event-tier-0",
      note: "same source key + external id",
    };
  }
  if (req.existingLink) {
    return {
      entity: "event",
      decision: "matched",
      tier: 1,
      canonicalId: req.existingLink.canonicalId,
      reasonCode: "event-tier-1",
      note: "existing source-link row",
    };
  }

  if (req.resolvedVenueId) {
    const a = shim(
      req.incoming.title,
      req.incoming.startLocal,
      req.incoming.venueName,
      req.incoming.ticketUrl,
      req.incoming.promoter,
    );

    // Evaluate EVERY candidate at the resolved venue before deciding — the
    // outcome must not depend on the order of `req.candidates`.
    const automatic: { id: string; rationale: string }[] = [];
    let weakCandidateCount = 0;
    for (const c of req.candidates) {
      if (c.venueId !== req.resolvedVenueId) continue;
      const b = shim(c.title, c.startLocal, req.incoming.venueName, c.ticketUrl, c.promoter);
      const cmp = compareEvents(a, req.resolvedVenueId, b, c.venueId);
      if (cmp.band === "automatic") automatic.push({ id: c.id, rationale: cmp.rationale });
      else if (cmp.band === "probable" || cmp.band === "ambiguous") weakCandidateCount++;
      // a "separate" candidate contributes nothing
    }

    // Exactly one automatic match — a confident, unique merge (Tier 2). A
    // weaker candidate alongside it does not block a definitive automatic match.
    if (automatic.length === 1) {
      return {
        entity: "event",
        decision: "matched",
        tier: 2,
        canonicalId: automatic[0].id,
        reasonCode: "event-tier-2",
        note: automatic[0].rationale,
      };
    }

    // No unique automatic match, but the field is not clean: two or more
    // automatic candidates (cannot choose), or at least one weakly-corroborated
    // candidate. Hold for review — never guess, and NEVER return a canonicalId
    // (an ambiguous decision must not read as "update this canonical event").
    if (automatic.length > 1 || weakCandidateCount > 0) {
      return {
        entity: "event",
        decision: "ambiguous",
        tier: null,
        canonicalId: null,
        reasonCode: "event-ambiguous",
        note:
          automatic.length > 1
            ? `${automatic.length} candidates at this venue matched automatically — cannot choose one`
            : `${weakCandidateCount} weakly-corroborated candidate(s) at this venue — hold for review`,
      };
    }
  }

  return {
    entity: "event",
    decision: "new_candidate",
    tier: 3,
    canonicalId: null,
    reasonCode: "event-new-candidate",
    note: "no existing canonical event matched",
  };
}
