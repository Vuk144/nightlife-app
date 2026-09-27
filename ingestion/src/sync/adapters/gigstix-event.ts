/**
 * One GIGS TIX event page → the sync engine's normalized event record
 * (`NormalizedRecord` of kind `"event"`, see `../event-contract.ts`).
 *
 * A thin mapping layer — it owns no HTML parsing of its own:
 *   - parse:    `../../events/adapters/gigstix-parse.ts#parseGigstixEvent`
 *               (the existing pure Event Champ parser: `gt-*` detail rows,
 *               Serbian labels, WordPress post id)
 *   - here:     map its result onto the sync contract
 *   - validate: `../event-contract.ts#validateEventContract` — NOT run here;
 *               the pipeline's validate step is separate.
 *
 * Pure: no network, no clock (the caller supplies `fetchedAt`), no store.
 * It never matches a venue: the page's venue is carried as a `links.venue`
 * hint (name + GIGS venue slug + city text), never a canonical venue id.
 */

import { parseGigstixEvent } from "../../events/adapters/gigstix-parse.ts";
import { DEFAULT_COUNTRIES, DEFAULT_TIME_ZONE } from "../../events/config.ts";
import type { NormalizedEvent as ParsedGigstixEvent } from "../../events/types.ts";
import type { NormalizedEvent } from "../event-contract.ts";
import type { JsonValue } from "../types.ts";

/** Same key as the GIGS TIX event adapter (`../../events/adapters/gigstix.ts`). */
export const GIGSTIX_SOURCE_KEY = "gigstix";

export interface GigstixEventContext {
  /** ISO-8601 — when the page was fetched. */
  fetchedAt: string;
  /**
   * IANA zone of the page's local times. GIGS TIX is a single-zone Serbian
   * platform, so this defaults to the GIGS configuration's zone
   * (`DEFAULT_TIME_ZONE`, Europe/Belgrade) — the same zone the GIGS adapter
   * stamps in the dry-run pipeline.
   */
  timeZone?: string;
  /** Defaults to the GIGS configuration's country (`DEFAULT_COUNTRIES[0]`). */
  countryCode?: string;
}

export type GigstixEventParse =
  | { ok: true; record: NormalizedEvent }
  | { ok: false; reason: string; detail?: string };

/**
 * Parse one GIGS TIX event page. A failure is the existing parser's reason
 * code (`missing-title`, `missing-external-id`, `unparseable-date`,
 * `not-found-page`, `missing-details`, `missing-location`) — never a
 * manufactured event.
 */
export function parseGigstixEventRecord(
  html: string,
  url: string,
  ctx: GigstixEventContext,
): GigstixEventParse {
  const parsed = parseGigstixEvent(html, url);
  if (!parsed.ok) {
    return parsed.detail === undefined
      ? { ok: false, reason: parsed.reason }
      : { ok: false, reason: parsed.reason, detail: parsed.detail };
  }
  return { ok: true, record: toGigstixEventRecord(parsed.event, ctx) };
}

/** Map a parsed GIGS TIX event onto the sync event contract. Absent stays absent (`null`). */
export function toGigstixEventRecord(event: ParsedGigstixEvent, ctx: GigstixEventContext): NormalizedEvent {
  const city = event.venue.city?.trim() || null;
  const coordinates =
    event.venue.lat !== undefined && event.venue.lon !== undefined
      ? { latitude: event.venue.lat, longitude: event.venue.lon }
      : null;

  return {
    kind: "event",
    provenance: {
      sourceKey: GIGSTIX_SOURCE_KEY,
      externalId: event.externalId,
      sourceUrl: event.sourceUrl,
      // Stable theme markup, not free text; parser doubt stays in `reported`.
      confidence: 1,
      fetchedAt: ctx.fetchedAt,
      // The parser's verbatim fields — all JSON values; a round trip drops undefined.
      reported: JSON.parse(JSON.stringify(event.reported)) as Record<string, JsonValue>,
    },
    scope: {
      countryCode: ctx.countryCode ?? DEFAULT_COUNTRIES[0],
      cityText: city,
      coordinates: null,
    },
    fields: {
      title: event.title,
      description: event.description ?? null,
      startLocal: event.startLocal,
      endLocal: event.endLocal ?? null,
      doorsLocal: event.doorsLocal ?? null,
      timeZone: event.timeZone ?? ctx.timeZone ?? DEFAULT_TIME_ZONE,
      startPrecision: event.startPrecision,
      // unset = the source said nothing, which the sync layer records as "scheduled"
      status: event.status ?? "scheduled",
      promoter: event.promoter ?? null,
      ticketUrl: event.ticketUrl ?? null,
      coverImageUrl: event.coverImageUrl ?? null,
      lineup: (event.lineup ?? []).map((p) => p.name),
    },
    links: {
      venue: {
        name: event.venue.name,
        sourceVenueId: event.venue.sourceVenueId ?? null,
        address: event.venue.address ?? null,
        coordinates,
        cityText: city,
      },
    },
  };
}
