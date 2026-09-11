/**
 * Deterministic venue-name normalization. Pure, no dependencies — shared by the
 * classifier, the matcher, the rescue list and the normalizer, so it lives in
 * its own leaf module to avoid an import cycle.
 */

/**
 * Non-decomposable Latin letters NFKD will not split into base + mark.
 * Applied BEFORE lower-casing, so every entry needs BOTH cases — a missing
 * upper-case form is silently deleted at the `[^a-z0-9]` step instead of
 * mapped (e.g. Icelandic `Ð` U+00D0, visually identical to Serbian `Đ`).
 */
const LATIN_SPECIAL: Record<string, string> = {
  "đ": "d", "Đ": "d", "ð": "d", "Ð": "d",
  "ø": "o", "Ø": "o",
  "ł": "l", "Ł": "l",
  "ß": "ss", "ẞ": "ss",
  "æ": "ae", "Æ": "ae",
  "œ": "oe", "Œ": "oe",
};

/** Serbian Cyrillic -> Latin, lower-case only (applied after lower-casing). */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d",
  "ђ": "dj", "е": "e", "ж": "z", "з": "z", "и": "i",
  "ј": "j", "к": "k", "л": "l", "љ": "lj", "м": "m",
  "н": "n", "њ": "nj", "о": "o", "п": "p", "р": "r",
  "с": "s", "т": "t", "ћ": "c", "у": "u", "ф": "f",
  "х": "h", "ц": "c", "ч": "c", "џ": "dz", "ш": "s",
};

/** Generic venue words dropped as *whole tokens* only (never as substrings). */
const STOPWORDS = new Set(["the", "club", "klub", "bar"]);

/** City words stripped from the start/end of a normalized name. */
const CITY_WORDS = new Set(["beograd", "belgrade"]);

/**
 * Steps, in order:
 *   1. map non-decomposable Latin letters (d-stroke, o-slash, ss, ...)
 *   2. Unicode NFKD, then strip combining marks (accents)
 *   3. lower-case (locale-independent)
 *   4. transliterate Serbian Cyrillic to Latin
 *   5. every run of non-alphanumerics -> a single space; trim; collapse
 *   6. drop leading/trailing city words (beograd / belgrade)
 *   7. drop generic venue stopwords as whole tokens — only if a token survives
 *
 * May return "" for a name with no Latin/Cyrillic letters or digits; callers
 * must not match on an empty normalized name.
 */
export function normalizeName(raw: string): string {
  let s = raw ?? "";

  s = Array.from(s, (ch) => LATIN_SPECIAL[ch] ?? ch).join("");
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[Ѐ-ӿ]/g, (ch) => CYRILLIC_TO_LATIN[ch] ?? "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

  let tokens = s.length > 0 ? s.split(" ") : [];

  while (tokens.length > 1 && CITY_WORDS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && CITY_WORDS.has(tokens[tokens.length - 1])) tokens.pop();

  const kept = tokens.filter((token) => !STOPWORDS.has(token));
  if (kept.length > 0) tokens = kept;

  return tokens.join(" ");
}

/**
 * The value stored in `venues.name_normalized`: `normalizeName`, or, when that
 * comes back empty, a plain lower-cased/whitespace-collapsed fallback so the
 * key is never "".
 */
export function computeNameNormalized(name: string): string {
  return normalizeName(name) || name.toLowerCase().replace(/\s+/g, " ").trim();
}
