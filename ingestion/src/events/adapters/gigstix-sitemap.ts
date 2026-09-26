/**
 * Pure sitemap helpers for GIGS TIX discovery.
 *
 * GIGS TIX serves a Yoast SEO sitemap: `sitemap_index.xml` lists child
 * sitemaps; the event pages live across several `event-sitemap*.xml` files
 * (`event-sitemap.xml`, `event-sitemap2.xml`, …), each a standard
 * `<urlset>` of `<url><loc>…</loc><lastmod>…</lastmod></url>`.
 *
 * No I/O here — the adapter wires these to `httpGetText`.
 */

import type { EventRef } from "../types.ts";

export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

/** Parse both `<sitemap>` (index) and `<url>` (urlset) entries. */
export function parseSitemapEntries(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const re = /<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const url = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
    if (!url) continue;
    const lastmod = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1];
    out.push({ url: decodeXmlEntities(url.trim()), lastmod: lastmod?.trim() });
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  // `&amp;` MUST decode LAST. Decoding it first can cascade: a literal
  // "&amp;lt;" (a real XML-escaped "&lt;" text, not markup) would decode to
  // "&lt;" after the &amp; step, and the SAME pass's later &lt; replacement
  // would then wrongly decode that into "<" — producing a URL character that
  // was never actually present. Doing the narrower entities first means none
  // of them can ever match text that only exists because of an &amp; decode.
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A child sitemap that holds event-detail URLs. */
export function isEventSitemapUrl(url: string): boolean {
  return /\/event-sitemap\d*\.xml$/i.test(url);
}

/** `<base>/event/<slug>/` — an event-detail page, not the `/event/` archive. */
export function isEventDetailUrl(url: string): boolean {
  return /\/event\/[^/?#]+\/?(?:[?#]|$)/i.test(url);
}

/** The `<slug>` from a `/event/<slug>/` URL. */
export function eventSlug(url: string): string | undefined {
  return url.match(/\/event\/([^/?#]+)/i)?.[1];
}

/**
 * Dedupe event URLs, order newest-first by `lastmod` (so a `--limit` run looks
 * at the most recently changed — i.e. live — events), and cap at `limit`
 * (0 = no cap).
 */
export function orderEventRefs(
  entries: SitemapEntry[],
  limit: number,
): EventRef[] {
  const byUrl = new Map<string, string | undefined>();
  for (const { url, lastmod } of entries) {
    if (!isEventDetailUrl(url)) continue;
    const existing = byUrl.get(url);
    if (existing === undefined || (lastmod ?? "") > (existing ?? "")) {
      byUrl.set(url, lastmod);
    }
  }
  // Code-unit comparison, not `localeCompare`: this order must depend only on
  // the (url, lastmod) data, never on locale collation rules that can rank
  // two DISTINCT strings as equal and make the result depend on input order.
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...byUrl.entries()].sort((a, b) => {
    const cmp = byCodeUnit(b[1] ?? "", a[1] ?? "");
    return cmp !== 0 ? cmp : byCodeUnit(a[0], b[0]);
  });
  const capped = limit > 0 ? ordered.slice(0, limit) : ordered;
  return capped.map(([url, lastmod]) => ({ url, ref: eventSlug(url), lastmod }));
}
