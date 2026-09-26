/**
 * Generic record validation — pure, deterministic.
 *
 * Universal checks only. Locale-specific placeholder vocabulary comes from
 * `CountryConfig.extraPlaceholderPatterns` (data). Source-specific junk
 * detection belongs in the adapter, which may itself hand the engine a
 * `needs_review` record.
 *
 * `rejected`  — the record is structurally not admissible (missing a required
 *               field, a placeholder name, physically-impossible coordinates).
 * `needs_review` — plausibly a real record, but a human should look (city could
 *               not be resolved, coordinates fall outside the configured region).
 *
 * The regex strings in `CountryConfig.extraPlaceholderPatterns` are guaranteed
 * compilable by `./config.ts#assertValidPlaceholderPatterns` (run when a
 * `ConfigProvider` is constructed), so compiling them here cannot throw for any
 * config that reached the engine.
 */

import { PLACEHOLDER_REGEX_FLAGS } from "./config.ts";
import type { CountryConfig } from "./config.ts";
import type { GeoBounds, NormalizedRecord, ResolvedScope, ValidationResult } from "./types.ts";

/** Truly universal placeholder / non-venue name patterns. */
const UNIVERSAL_PLACEHOLDERS: RegExp[] = [
  /^(unknown|n\/?a|none|null|tbd|tba|tbc)$/i,
  /^(to be (announced|confirmed|determined))$/i,
  /^(location (tba|tbd|tbc|unknown|to be announced))$/i,
  /^(various( locations?)?|multiple locations?|different venues?)$/i,
  /^(online( event)?|virtual( event)?|live ?stream(ing)?|webinar|zoom|youtube|twitch)$/i,
  // Whitespace + punctuation only (ASCII symbols, e.g. `$ + = ^ ~`, UNION
  // Unicode punctuation, e.g. em/en dash, ellipsis, curly quotes), plus
  // characters that are never content on their own: combining marks with no
  // base letter (`\p{M}`, incl. emoji variation selectors), control chars
  // (`\p{Cc}`) and lone surrogates (`\p{Cs}`). Invisible format chars
  // (`\p{Cf}`) are stripped by `isPlaceholder` before any pattern runs. No
  // letter or digit anywhere. This is the ONLY defense against a symbol-only name for
  // a profile whose `normalizeName` never returns "" (e.g. `sr`, via
  // `../name.ts`'s documented non-empty fallback — see `./normalization.ts`):
  // `empty-normalized-name` cannot fire for such a profile, so this must catch
  // it directly on `name`, independent of any normalization profile. It is
  // ALSO the event path's only such defense, full stop — `VenueLinkHint` (the
  // event's venue name hint) has no `normalizedName` field at all, so this is
  // the sole net for a symbol-only event venue name, for every profile.
  //
  // Deliberately excludes `\p{S}` (Unicode Symbol) — unlike a "no letter or
  // digit" test, this does NOT flag an emoji-only name (e.g. "🎵") or a
  // standalone "★"/"©"/"®", which are real, intentional content, not
  // placeholder filler (see validation.test.ts's astral-plane characterization).
  /^[\s\p{P}\p{M}\p{Cc}\p{Cs}\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+$/u,
];

/**
 * Invisible format characters (zero-width space/joiners, soft hyphen, word
 * joiner, BOM, bidi marks). `String#trim` does not remove them, so without
 * this a scraped "​TBA" would slip past every anchored pattern, and a
 * name made only of them would look non-empty.
 */
const INVISIBLE_FORMAT_CHARS = /\p{Cf}/gu;

function isPlaceholder(name: string, extra: RegExp[]): boolean {
  const trimmed = name.replace(INVISIBLE_FORMAT_CHARS, "").trim();
  if (!trimmed) return true;
  return (
    UNIVERSAL_PLACEHOLDERS.some((re) => re.test(trimmed)) ||
    extra.some((re) => re.test(trimmed))
  );
}

/**
 * A physically-possible point on Earth: both components finite, latitude in
 * [-90, 90], longitude in [-180, 180]. Anything else (NaN, ±Infinity, a
 * latitude of 999) is malformed data — not a borderline location a human could
 * adjudicate — so the caller `reject`s it. This is distinct from `withinBounds`,
 * which asks the softer question "is this valid point inside the configured
 * region" and answers with `needs_review`.
 */
function coordinatesArePhysical(c: { latitude: number; longitude: number }): boolean {
  return (
    Number.isFinite(c.latitude) &&
    Number.isFinite(c.longitude) &&
    c.latitude >= -90 &&
    c.latitude <= 90 &&
    c.longitude >= -180 &&
    c.longitude <= 180
  );
}

function withinBounds(
  coordinates: { latitude: number; longitude: number } | null,
  bounds: GeoBounds | null,
): boolean {
  if (!coordinates || !bounds) return true;
  return (
    coordinates.latitude >= bounds.minLat &&
    coordinates.latitude <= bounds.maxLat &&
    coordinates.longitude >= bounds.minLon &&
    coordinates.longitude <= bounds.maxLon
  );
}

const ok: ValidationResult = { outcome: "ok", reasonCode: null, reasons: [] };
const reject = (code: string): ValidationResult => ({
  outcome: "rejected",
  reasonCode: code,
  reasons: [code],
});
const review = (code: string): ValidationResult => ({
  outcome: "needs_review",
  reasonCode: code,
  reasons: [code],
});

export function validateRecord(input: {
  record: NormalizedRecord;
  scope: ResolvedScope;
  country: CountryConfig | null;
}): ValidationResult {
  const { record, scope, country } = input;
  const extra = (country?.extraPlaceholderPatterns ?? []).map(
    (src) => new RegExp(src, PLACEHOLDER_REGEX_FLAGS),
  );

  if (!record.provenance.externalId) return reject("missing-external-id");

  if (record.kind === "venue") {
    const name = record.fields.name?.trim() ?? "";
    if (!name) return reject("missing-name");
    if (name.length < 2) return reject("name-too-short");
    if (!record.fields.normalizedName?.trim()) return reject("empty-normalized-name");
    if (isPlaceholder(name, extra)) return reject("placeholder-venue-name");

    const coordinates = record.fields.coordinates;
    if (coordinates && !coordinatesArePhysical(coordinates)) {
      return reject("invalid-coordinates");
    }
    if (!withinBounds(coordinates, scope.bounds ?? country?.bounds ?? null)) {
      return review("coordinates-out-of-region");
    }
    // A city that resolved but is disabled is distinct from one that never
    // resolved: `resolveCity` (config.ts) has no `enabled` filter of its own,
    // so a source whose discovery scope leaks past `citiesInScope` — that
    // filter is a best-effort adapter hint, not a guarantee (see
    // `AdapterContext.cities`'s "for adapters that can target" wording) — can
    // still resolve to a city the operator has explicitly turned off. Held for
    // review rather than silently becoming a live upsert.
    if (scope.cityName && !scope.cityEnabled) return review("city-disabled");
    if (!scope.cityName) return review("city-unresolved");
    return ok;
  }

  // event
  const title = record.fields.title?.trim() ?? "";
  if (!title) return reject("missing-title");
  if (!record.fields.startLocal) return reject("missing-start");
  const venueHint = record.links.venue;
  if (!venueHint || !venueHint.name?.trim()) return review("event-no-venue-named");
  if (isPlaceholder(venueHint.name, extra)) return reject("placeholder-venue-name");
  if (venueHint.coordinates && !coordinatesArePhysical(venueHint.coordinates)) {
    return reject("invalid-coordinates");
  }
  if (scope.cityName && !scope.cityEnabled) return review("city-disabled");
  if (!scope.cityName) return review("city-unresolved");
  return ok;
}
