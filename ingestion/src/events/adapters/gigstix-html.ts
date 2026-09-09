/**
 * Shared pure HTML helpers for the GIGS TIX parsers (event page + venue page).
 * No I/O, no clock.
 */

import { decodeEntities } from "../text.ts";

/** Drop `<script>`, `<style>`, `<svg>` and comments so regexes stay sane. */
export function stripNoise(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** First capture group of `re` in `source`, or null. */
export function firstMatch(re: RegExp, source: string): string | null {
  const m = source.match(re);
  return m ? m[1] : null;
}

/** `content` of a `<meta property|name="…">` tag, entity-decoded, or null. */
export function metaContent(html: string, property: string): string | null {
  const direct = firstMatch(
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
      "i",
    ),
    html,
  );
  if (direct != null) return decodeEntities(direct);
  const reversed = firstMatch(
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
      "i",
    ),
    html,
  );
  return reversed != null ? decodeEntities(reversed) : null;
}

const GIGSTIX_TITLE_SUFFIXES = [
  " - GIGS TIX Srbija - gigstix.com",
  " – GIGS TIX Srbija - gigstix.com",
  " - GIGS TIX Srbija – gigstix.com",
  " – GIGS TIX Srbija – gigstix.com",
  " - gigstix.com",
  " – gigstix.com",
];

/** `<title>`/`og:title` text with the site-name suffix removed. */
export function cleanGigstixTitle(raw: string): string {
  let value = decodeEntities(raw).trim();
  for (const suffix of GIGSTIX_TITLE_SUFFIXES) {
    if (value.toLowerCase().endsWith(suffix.toLowerCase())) {
      value = value.slice(0, -suffix.length).trim();
      break;
    }
  }
  return value;
}
