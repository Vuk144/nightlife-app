/**
 * Source-agnostic helpers for the offset-free local wall-clock strings that
 * adapters emit (`"2026-10-30T23:00"` or `"2026-10-30"`).
 *
 * The engine — not this module and not the adapters — owns the conversion of a
 * (local string + IANA zone) pair into a canonical UTC instant. Everything here
 * is pure and works only with local strings.
 *
 * Source-specific date PARSING (e.g. Serbian month names for GIGS TIX) lives
 * next to its adapter — see `adapters/gigstix-datetime.ts`.
 */

/** The `YYYY-MM-DD` portion of a local string. */
export function localDatePart(local: string): string {
  return local.slice(0, 10);
}

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Parse a `"YYYY-MM-DDTHH:MM"` local wall-clock string as if it were UTC (both
 * sides of a `localMinutesBetween` comparison are assumed to be in the same
 * zone), or `null` when the string isn't exactly that shape OR names a
 * calendar date/time that doesn't exist (Feb 30, hour 24, Feb 29 outside a
 * leap year, ...). `Date.parse`/`Date.UTC` silently ROLL some out-of-range
 * components into the next day/month instead of rejecting them — e.g.
 * `"2026-02-30T10:00"` normalizes to March 2nd — which would otherwise let a
 * malformed timestamp compare as numerically identical to a real, different
 * event's time (a false "close in time" signal into `dedup.ts`'s merge
 * decision). Same round-trip-through-`Date.UTC` technique already used by
 * `adapters/gigstix-datetime.ts#isRealDate` for the same reason.
 */
function parseLocalDateTimeUtc(local: string): number | null {
  const m = LOCAL_DATETIME_RE.exec(local);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const ts = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(ts);
  const roundTrips =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute;
  return roundTrips ? ts : null;
}

/**
 * Minutes between two local datetime strings, or `null` when either lacks a
 * time component or names an invalid calendar date/time. Naive difference —
 * both are assumed to be in the same zone, which is the only case the caller
 * uses it for.
 */
export function localMinutesBetween(a: string, b: string): number | null {
  const ta = parseLocalDateTimeUtc(a);
  const tb = parseLocalDateTimeUtc(b);
  if (ta == null || tb == null) return null;
  return Math.round(Math.abs(ta - tb) / 60000);
}
