/**
 * Time-zone math. Local wall-clock → UTC instant, for both change detection
 * (a stable, comparable representation of an event's start) and for writing
 * `events.start_at` (a `timestamptz`) from `startLocal` + IANA `timeZone`.
 *
 * Pure, zero-dependency, DST-aware (uses `Intl`). Not Supabase-specific.
 */

function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(instant)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - instant) / 60000);
}

/**
 * `"2026-07-01T22:00"` + `"Europe/Zagreb"` → `"2026-07-01T20:00:00.000Z"`.
 * A bare `"2026-07-01"` is treated as local midnight.
 * Returns `null` when the input is unparseable.
 */
export function localToInstant(local: string, timeZone: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh, mi] = m;
  const wall = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? 0),
    Number(mi ?? 0),
    0,
  );
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const corrected = wall - zoneOffsetMinutes(guess, timeZone) * 60000;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess).toISOString();
}

/** `"04:00"` / `"04:00:00"` → `"04:00"`. Null-safe. */
export function normalizeTimeOfDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** A timestamp string that already carries an absolute offset (`Z` or `±HH:MM`). */
function hasExplicitOffset(value: string): boolean {
  return /\d(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

/**
 * Resolve a timestamp to an absolute UTC instant (milliseconds since epoch).
 *
 * TIMEZONE-INDEPENDENT: never consults the host process's zone. Used for every
 * lifecycle / reconciliation decision (see `../engine.ts#buildSnapshots`) and,
 * via `toComparableInstant`, for change detection.
 *
 *  - a string with an explicit offset (`"…Z"`, `"…+02:00"`)  → that instant
 *  - a bare `"YYYY-MM-DD"`                                    → UTC midnight
 *  - `"YYYY-MM-DDTHH:MM[:SS]"` + an IANA `timeZone`           → from that zone
 *  - `"YYYY-MM-DDTHH:MM[:SS]"` with NO zone                   → interpreted as
 *    UTC — the "UTC fallback", the only zone-safe choice when nothing better
 *    exists (`Date.parse` would treat it as *process-local*, which is the bug
 *    this function exists to avoid).
 *
 * Returns `null` when no date can be recognised.
 */
export function toInstantMs(
  local: string | null | undefined,
  timeZone: string | null | undefined,
): number | null {
  if (!local) return null;
  const trimmed = local.trim();

  if (hasExplicitOffset(trimmed)) {
    const t = Date.parse(trimmed);
    return Number.isNaN(t) ? null : t;
  }

  const m = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;

  if (timeZone && hh != null) {
    const iso = localToInstant(trimmed, timeZone);
    return iso ? Date.parse(iso) : null;
  }

  // No zone (or date-only): interpret the wall-clock as UTC.
  return Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? 0),
    Number(mi ?? 0),
    Number(ss ?? 0),
  );
}

/**
 * A stable ISO-8601 UTC instant string for change-detection comparison.
 * `local` + a zone → the instant; a bare ISO instant → itself, canonicalized;
 * a zone-less wall-clock → interpreted as UTC (never process-local).
 * Returns the input unchanged when it cannot be interpreted.
 */
export function toComparableInstant(
  local: string | null,
  timeZone: string | null,
): string | null {
  if (!local) return null;
  const ms = toInstantMs(local, timeZone);
  return ms == null ? local : new Date(ms).toISOString();
}

/**
 * The canonical change-detection instant for an event's start / end.
 *
 * It MUST equal what the persistence layer writes to `events.start_at` /
 * `events.end_at` and then reconstructs on read — otherwise a freshly-written
 * event is detected as UPDATED on every subsequent run. So a zone-bearing LOCAL
 * wall-clock is resolved through its zone by the SAME `localToInstant` the write
 * path (`SupabaseCanonicalStore.applyEvent`) uses — including a bare
 * `YYYY-MM-DD`, which `localToInstant` treats as LOCAL midnight. An
 * already-absolute string (`…Z`, `…+02:00`) or a zone-less local is handled by
 * `toComparableInstant` unchanged.
 *
 * This deliberately differs from `toInstantMs("YYYY-MM-DD", zone)` — which is
 * UTC midnight, timezone-independent, for reconciliation's "is this in the
 * past?" test. Change detection mirrors PERSISTENCE; reconciliation mirrors the
 * absolute clock.
 */
export function eventInstantForComparison(
  local: string | null,
  timeZone: string | null,
): string | null {
  if (!local) return null;
  const trimmed = local.trim();
  if (timeZone && !hasExplicitOffset(trimmed)) {
    return localToInstant(trimmed, timeZone) ?? toComparableInstant(local, timeZone);
  }
  return toComparableInstant(local, timeZone);
}
