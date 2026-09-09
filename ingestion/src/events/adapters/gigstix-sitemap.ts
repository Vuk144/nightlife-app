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
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'");
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
  const ordered = [...byUrl.entries()].sort((a, b) => {
    const cmp = (b[1] ?? "").localeCompare(a[1] ?? "");
    return cmp !== 0 ? cmp : a[0].localeCompare(b[0]);
  });
  const capped = limit > 0 ? ordered.slice(0, limit) : ordered;
  return capped.map(([url, lastmod]) => ({ url, ref: eventSlug(url), lastmod }));
}
