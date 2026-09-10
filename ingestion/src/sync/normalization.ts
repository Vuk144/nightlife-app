/**
 * Per-country name normalization.
 *
 * Normalization is a country-scoped PROFILE, not a single global function. The
 * default profile is script-neutral (Latin + diacritic folding). Serbia keeps
 * its existing curated profile (Cyrillic transliteration, local stop-words) by
 * delegating to the venue pipeline's `../name.ts` — so RS behaviour is
 * unchanged. Adding Croatia / Hungary / Germany just uses the default profile;
 * no new code.
 *
 * KNOWN LIMITATION (see the architecture report, section J): `../name.ts` also
 * strips the tokens "beograd"/"belgrade" and a few Serbian venue words. That is
 * correct for the "sr" profile and inert elsewhere, but a future refactor
 * should move those into the profile data rather than the shared module.
 */

import { computeNameNormalized as serbianComputeNameNormalized } from "../name.ts";
import type { CountryConfig } from "./config.ts";

export interface NormalizationProfile {
  key: string;
  /**
   * Deterministic, pure, source-agnostic. Null-safe (a nullish `raw` → `""`).
   * MAY return `""` for a name with no letters/digits — callers must never use
   * an empty normalized name as a match key (see `./validation.ts`).
   */
  normalizeName(raw: string): string;
}

/** Script-neutral default: fold diacritics, lower-case, punctuation → space. */
export const latinProfile: NormalizationProfile = {
  key: "latin",
  normalizeName(raw: string): string {
    const folded = (raw ?? "")
      .toLowerCase()
      .replace(/đ/g, "dj")
      .replace(/ø/g, "o")
      .replace(/ł/g, "l")
      .replace(/ß/g, "ss")
      .replace(/æ/g, "ae")
      .replace(/œ/g, "oe")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
    return folded;
  },
};

/**
 * Serbia: the venue pipeline's existing normalizer. Wrapped only to match
 * `latinProfile`'s null-safety — `profileFor()` hands a caller one profile or
 * the other and they must be interchangeable. For every real string the result
 * is byte-for-byte `../name.ts#computeNameNormalized`.
 */
export const serbianProfile: NormalizationProfile = {
  key: "sr",
  normalizeName: (raw: string): string => serbianComputeNameNormalized(raw ?? ""),
};

const PROFILES: Record<string, NormalizationProfile> = {
  latin: latinProfile,
  sr: serbianProfile,
};

/** The profile for a country, from `CountryConfig.normalizationProfile` (data). */
export function profileFor(country: CountryConfig | null): NormalizationProfile {
  if (!country) return latinProfile;
  const key = country.normalizationProfile;
  // Own-property check only: a `key` that happens to name an `Object.prototype`
  // member ("constructor", "toString", "__proto__", …) must still fall through
  // to the default — a bare `PROFILES[key]` would resolve it to an inherited
  // value that is not a `NormalizationProfile`.
  return Object.prototype.hasOwnProperty.call(PROFILES, key)
    ? PROFILES[key]
    : latinProfile;
}
