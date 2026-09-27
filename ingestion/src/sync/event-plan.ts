/**
 * Event PLAN — what would happen to one parsed event, without doing any of it.
 *
 *   READY     a valid event (event contract) whose venue matched ONE existing
 *             canonical venue confidently, with a resolved UTC start
 *   REVIEW    a valid event a human must look at first: the venue is
 *             ambiguous / unresolved, or its start has no zone to resolve in
 *   REJECTED  the source page did not parse, or the event breaks the contract
 *
 * Source-agnostic: it takes any source's parse result (the existing
 * `NormalizedRecord` event) and the existing venue matcher's result. It never
 * writes, never calls `CanonicalStore.apply`, never creates a venue or event.
 */

import type { ConfigProvider } from "./config.ts";
import { eventInstants, validateEventContract, type NormalizedEvent } from "./event-contract.ts";
import { matchEventVenueInStore, type EventVenueMatch } from "./event-venue-match.ts";
import type { CanonicalStore } from "./store.ts";
import type { CrossSourceVenueIdentity } from "./venue-cross-source-identity.ts";

/** A source adapter's parse result for one event page (e.g. `parseGigstixEventRecord`). */
export type EventParseResult =
  | { ok: true; record: NormalizedEvent }
  | { ok: false; reason: string; detail?: string };

export type EventPlanItem =
  | {
      action: "READY";
      event: NormalizedEvent;
      startAt: string;
      endAt: string | null;
      venueId: string;
      venueName: string;
    }
  | {
      action: "REVIEW";
      event: NormalizedEvent;
      startAt: string | null;
      endAt: string | null;
      reasonCode: string;
      note: string;
      /** The venue matcher's non-confident result, when that is the reason. */
      venueMatch: EventVenueMatch | null;
    }
  | {
      action: "REJECTED";
      /** null when the page did not even parse. */
      event: NormalizedEvent | null;
      reasonCode: string;
      note: string;
    };

/**
 * Pure. `venueMatch` is the existing matcher's result for this event (it is
 * ignored for a rejected event, so a caller may pass null there).
 * `fallbackTimeZone` is the config-resolved zone the contract uses when the
 * event carries none.
 */
export function planEvent(input: {
  parsed: EventParseResult;
  venueMatch: EventVenueMatch | null;
  fallbackTimeZone: string | null;
}): EventPlanItem {
  const { parsed } = input;
  if (!parsed.ok) {
    return { action: "REJECTED", event: null, reasonCode: parsed.reason, note: parsed.detail ?? "the source page did not parse" };
  }
  const event = parsed.record;

  const contract = validateEventContract(event, input.fallbackTimeZone);
  if (contract) {
    return { action: "REJECTED", event, reasonCode: contract.reasonCode ?? "contract-rejected", note: contract.reasons.join("; ") };
  }
  const times = eventInstants(event.fields, input.fallbackTimeZone);
  // the contract already passed, so the times are valid; guard for the type
  const startAt = times.ok ? times.startAt : null;
  const endAt = times.ok ? times.endAt : null;

  const match = input.venueMatch;
  if (!match || match.status !== "matched") {
    return {
      action: "REVIEW",
      event,
      startAt,
      endAt,
      reasonCode: match ? match.reasonCode : "venue-not-matched",
      note: match ? match.note : "no venue match result was supplied",
      venueMatch: match,
    };
  }
  if (startAt === null) {
    return {
      action: "REVIEW",
      event,
      startAt,
      endAt,
      reasonCode: "start-time-unresolved",
      note: "the start is a local time with no time zone to resolve it in",
      venueMatch: match,
    };
  }
  return { action: "READY", event, startAt, endAt, venueId: match.venueId, venueName: match.venueName };
}

/**
 * Read-only convenience: validate, run the existing store-backed venue
 * matcher for a VALID event only, then `planEvent`. Reads the store; never
 * writes to it.
 */
export async function planEventInStore(
  parsed: EventParseResult,
  deps: { config: ConfigProvider; store: CanonicalStore; crossSourceIdentities?: CrossSourceVenueIdentity[] },
): Promise<EventPlanItem> {
  if (!parsed.ok) return planEvent({ parsed, venueMatch: null, fallbackTimeZone: null });

  const event = parsed.record;
  const city = deps.config.resolveCity(event.scope.countryCode, event.links.venue?.cityText || event.scope.cityText);
  const fallbackTimeZone = city?.city.timeZone ?? deps.config.country(event.scope.countryCode)?.defaultTimeZone ?? null;

  if (validateEventContract(event, fallbackTimeZone)) {
    return planEvent({ parsed, venueMatch: null, fallbackTimeZone }); // → REJECTED, no store read
  }
  const venueMatch = await matchEventVenueInStore(event, deps);
  return planEvent({ parsed, venueMatch, fallbackTimeZone });
}
