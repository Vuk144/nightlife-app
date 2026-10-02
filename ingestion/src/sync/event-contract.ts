/**
 * The normalized EVENT contract — what any event source's adapter hands the
 * generic engine, before venue matching and before persistence.
 *
 * It is the existing `NormalizedRecord` of kind `"event"` (`./types.ts`); this
 * module adds no parallel model, only the contract's time semantics and its
 * pure validation:
 *
 *   source identity   `provenance.sourceKey` + `provenance.externalId`
 *                     (+ optional `provenance.sourceUrl`)
 *   content           `fields.title`, optional `description`,
 *                     `coverImageUrl`, `ticketUrl`, `status`
 *   time              `fields.startLocal` / optional `endLocal`: the SOURCE's
 *                     local wall-clock ("2026-10-30T23:00" or date-only
 *                     "2026-10-30"), or an already-absolute ISO instant with
 *                     an offset; `fields.timeZone` is the IANA zone the local
 *                     times are in, when the source establishes it
 *   venue hint        `links.venue` — the source's venue name and/or its own
 *                     venue id (+ address / coordinates / city text). NOT a
 *                     canonical venue id: matching is a later, separate step.
 *   geography         `scope` (country / city text) for venue matching
 *
 * The canonical UTC instants (`startAt` / `endAt`) are DERIVED, never stored
 * in the record: local wall-clock + zone → instant, via `./time-zone.ts`. The
 * zone is the record's own `timeZone`, else the zone the engine resolved from
 * config for the record's city/country (`ResolvedScope.timeZone`). It is never
 * guessed: with no zone, a local time has no instant (`null`).
 */

import { instantToLocal, localToInstant } from "./time-zone.ts";
import type { EventFields, NormalizedRecord, ValidationResult } from "./types.ts";

export type NormalizedEvent = Extract<NormalizedRecord, { kind: "event" }>;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

type TimeValue =
  | { kind: "absolute"; instant: string }
  | { kind: "local"; wallClock: string; dateOnly: boolean };

function isRealDateTime(y: string, mo: string, d: string, h = "0", mi = "0", s = "0"): boolean {
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  const t = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    t.getUTCFullYear() === year &&
    t.getUTCMonth() === month - 1 &&
    t.getUTCDate() === day &&
    t.getUTCHours() === hour &&
    t.getUTCMinutes() === minute &&
    t.getUTCSeconds() === second
  );
}

/** The accepted shapes; `null` for anything else or a calendar-impossible value. */
function parseTimeValue(value: string): TimeValue | null {
  let m = LOCAL_DATE.exec(value);
  if (m) return isRealDateTime(m[1], m[2], m[3]) ? { kind: "local", wallClock: `${value}T00:00`, dateOnly: true } : null;
  m = LOCAL_DATE_TIME.exec(value);
  if (m) return isRealDateTime(m[1], m[2], m[3], m[4], m[5]) ? { kind: "local", wallClock: value, dateOnly: false } : null;
  m = ABSOLUTE.exec(value);
  if (m && isRealDateTime(m[1], m[2], m[3], m[4], m[5], m[6])) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : { kind: "absolute", instant: new Date(ms).toISOString() };
  }
  return null;
}

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export type EventInstants =
  | { ok: true; startAt: string | null; endAt: string | null }
  | { ok: false; reasonCode: "invalid-start" | "invalid-end" | "invalid-time-zone" | "end-before-start" };

/**
 * The canonical UTC instants for an event's start / end.
 *
 * `startAt` / `endAt` are ISO-8601 UTC strings, or `null` when a LOCAL time
 * has no zone to be interpreted in (valid, but not yet resolvable). Rejects
 * an unparseable or impossible value, an unknown zone, a local time that does
 * not exist in the zone (DST spring-forward gap), and an end before the
 * start. A DST fall-back time that occurs twice resolves as `localToInstant`
 * does — the same instant the store writes.
 */
export function eventInstants(
  fields: Pick<EventFields, "startLocal" | "endLocal" | "timeZone">,
  fallbackTimeZone: string | null,
): EventInstants {
  const timeZone = fields.timeZone ?? fallbackTimeZone;
  if (timeZone !== null && !isKnownTimeZone(timeZone)) return { ok: false, reasonCode: "invalid-time-zone" };

  const start = parseTimeValue(fields.startLocal.trim());
  if (!start) return { ok: false, reasonCode: "invalid-start" };
  const endRaw = fields.endLocal?.trim() || null;
  const end = endRaw === null ? null : parseTimeValue(endRaw);
  if (endRaw !== null && !end) return { ok: false, reasonCode: "invalid-end" };

  const instantOf = (v: TimeValue): string | null | false => {
    if (v.kind === "absolute") return v.instant;
    if (timeZone === null) return null;
    const iso = localToInstant(v.wallClock, timeZone);
    // round trip: a wall-clock inside a DST gap comes back as a different time
    if (!iso || instantToLocal(Date.parse(iso), timeZone) !== v.wallClock) return false;
    return iso;
  };
  const startAt = instantOf(start);
  if (startAt === false) return { ok: false, reasonCode: "invalid-start" };
  const endAt = end ? instantOf(end) : null;
  if (endAt === false) return { ok: false, reasonCode: "invalid-end" };

  if (end && endBeforeStart(start, startAt, end, endAt)) return { ok: false, reasonCode: "end-before-start" };
  return { ok: true, startAt, endAt };
}

function endBeforeStart(start: TimeValue, startAt: string | null, end: TimeValue, endAt: string | null): boolean {
  // A date-only end means "ends that day": compare calendar dates only.
  if (start.kind === "local" && end.kind === "local" && (start.dateOnly || end.dateOnly)) {
    return end.wallClock.slice(0, 10) < start.wallClock.slice(0, 10);
  }
  if (startAt !== null && endAt !== null) return Date.parse(endAt) < Date.parse(startAt);
  // Both local with no zone: the same (unknown) zone, so wall-clocks order the
  // same way as instants (outside a DST fall-back hour).
  if (start.kind === "local" && end.kind === "local") return end.wallClock < start.wallClock;
  return false; // absolute vs zone-less local: not comparable without guessing
}

const reject = (code: string): ValidationResult => ({ outcome: "rejected", reasonCode: code, reasons: [code] });

/**
 * Structural admissibility of a normalized event: the contract rules only
 * (no config, no placeholder vocabulary, no city resolution — see
 * `./validation.ts#validateRecord`, which runs this first). Returns the
 * rejection, or `null` when the event satisfies the contract. Absent
 * OPTIONAL fields never reject.
 */
export function validateEventContract(event: NormalizedEvent, fallbackTimeZone: string | null): ValidationResult | null {
  if (!event.provenance.sourceKey?.trim()) return reject("missing-source");
  if (!event.provenance.externalId?.trim()) return reject("missing-external-id");
  if (!event.fields.title?.trim()) return reject("missing-title");
  if (!event.fields.startLocal?.trim()) return reject("missing-start");

  const times = eventInstants(event.fields, fallbackTimeZone);
  if (!times.ok) return reject(times.reasonCode);

  const venue = event.links.venue;
  if (!venue || (!venue.name?.trim() && !venue.sourceVenueId?.trim())) return reject("missing-venue-identity");
  return null;
}
