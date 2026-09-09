import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  eventSlug,
  isEventDetailUrl,
  isEventSitemapUrl,
  orderEventRefs,
  parseSitemapEntries,
} from "../../src/events/adapters/gigstix-sitemap.ts";

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("parseSitemapEntries: reads <sitemap> index entries + lastmod", () => {
  const entries = parseSitemapEntries(read("gigstix-sitemap-index.xml"));
  const urls = entries.map((e) => e.url);
  assert.ok(urls.includes("https://new.gigstix.com/event-sitemap.xml"));
  assert.ok(urls.includes("https://new.gigstix.com/event-sitemap2.xml"));
  assert.equal(
    entries.find((e) => e.url.endsWith("event-sitemap.xml"))?.lastmod,
    "2026-09-08T06:09:15+00:00",
  );
});

test("isEventSitemapUrl: only event-sitemap*.xml children", () => {
  const children = parseSitemapEntries(read("gigstix-sitemap-index.xml")).map(
    (e) => e.url,
  );
  const eventSitemaps = children.filter(isEventSitemapUrl);
  assert.deepEqual(eventSitemaps, [
    "https://new.gigstix.com/event-sitemap.xml",
    "https://new.gigstix.com/event-sitemap2.xml",
  ]);
  assert.equal(isEventSitemapUrl("https://new.gigstix.com/venue-sitemap.xml"), false);
  assert.equal(isEventSitemapUrl("https://new.gigstix.com/page-sitemap.xml"), false);
});

test("parseSitemapEntries + isEventDetailUrl: event-detail URLs only, archive excluded", () => {
  const entries = parseSitemapEntries(read("gigstix-event-sitemap.xml"));
  const detail = entries.filter((e) => isEventDetailUrl(e.url));
  assert.ok(entries.some((e) => e.url === "https://new.gigstix.com/event/"));
  assert.ok(!detail.some((e) => e.url === "https://new.gigstix.com/event/"));
  assert.equal(detail.length, 3);
});

test("eventSlug: extracts the /event/<slug>/ segment", () => {
  assert.equal(
    eventSlug("https://new.gigstix.com/event/intercell-with-dvs1-beograd-30-oktobar-2026/"),
    "intercell-with-dvs1-beograd-30-oktobar-2026",
  );
  assert.equal(eventSlug("https://new.gigstix.com/koncerti/"), undefined);
});

test("orderEventRefs: nested sitemaps merged, deduped, newest-first, capped", () => {
  const all = [
    ...parseSitemapEntries(read("gigstix-event-sitemap.xml")),
    ...parseSitemapEntries(read("gigstix-event-sitemap2.xml")),
  ];
  const refs = orderEventRefs(all, 0);

  // "/event/" archive dropped; intercell appears in both sitemaps -> once.
  assert.ok(!refs.some((r) => r.url === "https://new.gigstix.com/event/"));
  assert.equal(
    refs.filter((r) => r.url.includes("intercell-with-dvs1")).length,
    1,
  );

  // newest lastmod first
  assert.equal(
    refs[0].url,
    "https://new.gigstix.com/event/standupfest-premijera-katran-i-perje-srdjana-dincica-novi-sad-19-oktobar-2026/",
  );
  assert.equal(refs[0].lastmod, "2026-09-01T10:00:00+00:00");
  assert.equal(refs[0].ref, "standupfest-premijera-katran-i-perje-srdjana-dincica-novi-sad-19-oktobar-2026");

  // limit caps the list
  assert.equal(orderEventRefs(all, 2).length, 2);
});

test("parseSitemapEntries: tolerates empty / malformed XML", () => {
  assert.deepEqual(parseSitemapEntries(""), []);
  assert.deepEqual(parseSitemapEntries("<urlset><url><lastmod>x</lastmod></url></urlset>"), []);
});
