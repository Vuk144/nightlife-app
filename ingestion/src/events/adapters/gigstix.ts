/**
 * GIGS TIX event source adapter (`new.gigstix.com`).
 *
 * Discovery is sitemap-driven:
 *   sitemap_index.xml  ->  every `event-sitemap*.xml`  ->  `/event/<slug>/` URLs.
 *
 * `robots.txt` (checked 2026-09-08) is `User-agent: * / Disallow:` — nothing is
 * disallowed — and points at `sitemap_index.xml`. Access is a plain HTTP GET
 * with a descriptive User-Agent; no automation, no auth, no bot-wall bypass.
 *
 * `fetch()` is network + retry only. `parse()` delegates to the pure
 * `parseGigstixEvent` and just stamps the region time zone the adapter knows.
 */

import { httpGetText } from "../http.ts";
import type {
  EventRef,
  EventSourceAdapter,
  ParseResult,
  RawEvent,
  SourceContext,
  SourceVenue,
} from "../types.ts";
import { parseGigstixEvent } from "./gigstix-parse.ts";
import { parseGigstixVenue } from "./gigstix-venue-parse.ts";
import {
  isEventSitemapUrl,
  orderEventRefs,
  parseSitemapEntries,
  type SitemapEntry,
} from "./gigstix-sitemap.ts";

const SITEMAP_INDEX_PATH = "/sitemap_index.xml";
const XML_ACCEPT = "application/xml,text/xml;q=0.9,*/*;q=0.8";

export const gigstixAdapter: EventSourceAdapter = {
  key: "gigstix",
  capabilities: {
    discovery: "sitemap",
    givesVenueId: true, // `/venue/<slug>/`
    givesLineup: false, // lineup is only inline prose in the description
    givesPromoter: true, // the "Organizator" detail row
    givesVenuePages: true, // `/venue/<slug>/` carries address + coordinates
  },

  async *discover(ctx: SourceContext): AsyncIterable<EventRef> {
    const base = ctx.baseUrl.replace(/\/+$/, "");

    const index = await httpGetText(`${base}${SITEMAP_INDEX_PATH}`, {
      userAgent: ctx.userAgent,
      accept: XML_ACCEPT,
      timeoutMs: 30_000,
    });
    if (index.status !== 200) {
      throw new Error(`sitemap index returned HTTP ${index.status}`);
    }

    const eventSitemaps = parseSitemapEntries(index.body)
      .map((e) => e.url)
      .filter(isEventSitemapUrl);
    if (eventSitemaps.length === 0) {
      throw new Error("sitemap index contained no event-sitemap*.xml entries");
    }

    const entries: SitemapEntry[] = [];
    for (const sitemapUrl of eventSitemaps) {
      const res = await httpGetText(sitemapUrl, {
        userAgent: ctx.userAgent,
        accept: XML_ACCEPT,
        timeoutMs: 30_000,
        politenessMs: 400,
      });
      if (res.status !== 200) {
        console.warn(`  ${sitemapUrl} returned HTTP ${res.status}; skipping`);
        continue;
      }
      entries.push(...parseSitemapEntries(res.body));
    }

    for (const ref of orderEventRefs(entries, ctx.limit)) {
      yield ref;
    }
  },

  async fetch(ref: EventRef, ctx: SourceContext): Promise<RawEvent> {
    const res = await httpGetText(ref.url, {
      userAgent: ctx.userAgent,
      timeoutMs: 30_000,
      attempts: 3,
      politenessMs: 500,
    });
    return {
      ref,
      url: res.url,
      status: res.status,
      body: res.body,
      contentType: res.contentType,
      fetchedAt: new Date().toISOString(),
    };
  },

  parse(raw: RawEvent, ctx: SourceContext): ParseResult {
    const result = parseGigstixEvent(raw.body, raw.url);
    if (result.ok && !result.event.timeZone) {
      // GIGS TIX is a Serbian platform; all listed times are local wall-clock.
      result.event.timeZone = ctx.defaultTimeZone;
    }
    return result;
  },

  async fetchSourceVenue(
    sourceVenueId: string,
    ctx: SourceContext,
  ): Promise<SourceVenue | null> {
    const slug = sourceVenueId.trim().replace(/^\/+|\/+$/g, "");
    if (!/^[a-z0-9-]+$/i.test(slug)) return null;
    const base = ctx.baseUrl.replace(/\/+$/, "");
    const url = `${base}/venue/${slug}/`;
    let res;
    try {
      res = await httpGetText(url, {
        userAgent: ctx.userAgent,
        timeoutMs: 30_000,
        attempts: 2,
        politenessMs: 500,
      });
    } catch {
      return null; // enrichment is best-effort
    }
    if (res.status !== 200) return null;
    const parsed = parseGigstixVenue(res.body, res.url);
    return parsed.ok ? parsed.venue : null;
  },
};
