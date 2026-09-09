/**
 * Serbian-language local date/time parsing for GIGS TIX / Event Champ pages.
 *
 * This is source-specific parser knowledge (the field strings GIGS TIX renders
 * in "Datum i vreme održavanja" / "Traje do"), so it lives next to the adapter,
 * not in the generic `../time.ts`. It is pure: no network, no clock, only local
 * strings out. The engine — not this module — owns converting a
 * (local string + IANA zone) pair into a canonical UTC instant.
 */

import type { StartPrecision } from "../types.ts";

/** Serbian month names, genitive case ("30. oktobra 2026"). */
const SR_MONTHS_GENITIVE: Record<string, number> = {
  januara: 1,
  februara: 2,
  marta: 3,
  aprila: 4,
  maja: 5,
  juna: 6,
  jula: 7,
  avgusta: 8,
  septembra: 9,
  oktobra: 10,
  novembra: 11,
  decembra: 12,
};

/** Serbian month names, nominative case — occasionally used in listings. */
const SR_MONTHS_NOMINATIVE: Record<string, number> = {
  januar: 1,
  februar: 2,
  mart: 3,
  april: 4,
  maj: 5,
  jun: 6,
  jul: 7,
  avgust: 8,
  septembar: 9,
  oktobar: 10,
  novembar: 11,
  decembar: 12,
};

export interface ParsedLocalDateTime {
  /** `"2026-10-30T23:00"` (datetime) or `"2026-10-30"` (date). */
  local: string;
  precision: StartPrecision;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Parse a GIGS TIX / Event Champ Serbian date string:
 *
 *   "petak 30. oktobra 2026. 23.00"   -> { local: "2026-10-30T23:00", "datetime" }
 *   "subota 9. maja 2026. 10.00"      -> { local: "2026-05-09T10:00", "datetime" }
 *   "petak 30. oktobra 2026."         -> { local: "2026-10-30",       "date" }
 *
 * The leading day-of-week word is ignored. Time separators `.`, `:` and `h` are
 * accepted. Returns `null` when no day / month / year can be recognised — the
 * caller must treat that as a parse failure and never guess a date.
 */
export function parseSerbianDateTime(raw: string): ParsedLocalDateTime | null {
  const text = raw
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();

  const match = text.match(
    /(\d{1,2})\.\s*([a-zčćžšđ]+)\.?\s+(\d{4})\.?(?:\s*(?:u\s*)?(\d{1,2})[.:h](\d{2}))?/,
  );
  if (!match) return null;

  const day = Number(match[1]);
  const month = SR_MONTHS_GENITIVE[match[2]] ?? SR_MONTHS_NOMINATIVE[match[2]];
  const year = Number(match[3]);
  if (!month || !isRealDate(year, month, day)) return null;

  const date = `${year}-${pad2(month)}-${pad2(day)}`;

  if (match[4] != null && match[5] != null) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (hour <= 23 && minute <= 59) {
      return {
        local: `${date}T${pad2(hour)}:${pad2(minute)}`,
        precision: "datetime",
      };
    }
  }
  return { local: date, precision: "date" };
}
