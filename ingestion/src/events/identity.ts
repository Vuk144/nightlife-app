/**
 * Canonical identity of ONE source event.
 *
 * For this milestone only ONE source (GIGS TIX) is active, so its own
 * `externalId` is the identity and no cross-source merging happens.
 *
 * The companion module `dedup.ts` compares TWO events for possible merging; it
 * is re-exported below for existing importers.
 *
 * Pure and deterministic. No fuzzy / ML matching.
 */

import { computeNameNormalized } from "../name.ts";
import { sha1 } from "./text.ts";
import { localDatePart } from "./time.ts";
import type { NormalizedEvent } from "./types.ts";

// Cross-source comparison lives in `dedup.ts` now. Re-exported here so existing
// importers (`../sync/event-identity.ts`) keep resolving `compareEvents` from
// this module.
export { compareEvents } from "./dedup.ts";

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
