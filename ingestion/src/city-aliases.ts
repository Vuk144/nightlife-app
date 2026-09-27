/**
 * Source city text → our canonical `cities.name`, for Serbia (RS).
 *
 * Keys are FOLDED city text: lower-cased, de-accented, whitespace-collapsed —
 * `./name.ts#computeNameNormalized` and `./sync/config.ts#cityKey` agree on
 * every key here. Values must equal a `cities.name` row.
 *
 * Shared by the legacy event venue resolver (`./events/venue-resolve.ts`) and
 * the sync-engine GIGS TIX config (`./sync/adapters/gigstix-config.ts`) — one
 * table, not two copies. City identity only; nothing about venues.
 */
export const CITY_ALIASES: Record<string, string> = {
  beograd: "Belgrade",
  belgrade: "Belgrade",
  "novi sad": "Novi Sad",
  nis: "Niš",
  "nis srbija": "Niš",
};
