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

/**
 * Minutes between two local datetime strings, or `null` when either lacks a
 * time component. Naive difference — both are assumed to be in the same zone,
 * which is the only case the caller uses it for.
 */
export function localMinutesBetween(a: string, b: string): number | null {
  if (a.length < 16 || b.length < 16) return null;
  const ta = Date.parse(`${a}:00Z`);
  const tb = Date.parse(`${b}:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 60000);
}
