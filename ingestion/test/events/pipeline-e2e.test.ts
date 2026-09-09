/**
 * END-TO-END functional test of the production event-ingestion pipeline.
 *
 * Unlike `engine.test.ts` (scripted adapter + scripted resolver), this wires the
 * REAL pieces together:
 *
 *   real gigstixAdapter  (discover + fetch + parse, over a mocked globalThis.fetch
 *                          that serves the checked-in fixtures)
 *   real createVenueResolver  (Tiers 0-4 matching, over a READ-ONLY fake Supabase)
 *   real runEventDryRun  (relevance -> venue resolution -> identity -> event-first)
 *
 * It proves the connected system produces the right per-event outcomes for a
 * realistic mixture, performs ZERO Supabase writes, and is deterministic
 * regardless of discovery order.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gigstixAdapter } from "../../src/events/adapters/gigstix.ts";
import { runEventDryRun } from "../../src/events/engine.ts";
import { formatReport } from "../../src/events/report.ts";
import { createVenueResolver } from "../../src/events/venue-resolve.ts";
import type { SourceContext } from "../../src/events/types.ts";

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// ── fixture-derived event bodies ────────────────────────────────────
const KAMELOT = read("gigstix-event-kamelot.html");

// A distinct, explicitly CANCELLED event at the same (new) venue as Kamelot.
const KAMELOT_CANCELLED = KAMELOT
  .replace("postid-23274", "postid-23281")
  .replace("wp/v2/event/23274", "wp/v2/event/23281")
  .replace("<title>Kamelot", "<title>Kamelot – OTKAZANO");

// A recognizable event whose date row is pure garbage -> ParseFailure.
const KAMELOT_NO_DATE = KAMELOT
  .replace("postid-23274", "postid-23282")
  .replace("wp/v2/event/23274", "wp/v2/event/23282")
  .replace("nedelja 15. novembra 2026. 18.00", "uskoro — datum se objavljuje");

const BASE = "https://new.gigstix.com";

const U = {
  intercell: `${BASE}/event/intercell-with-dvs1-beograd-30-oktobar-2026/`,
  kamelot: `${BASE}/event/kamelot-beograd-15-novembar-2026/`,
  supercar: `${BASE}/event/gt-serbia-medjunarodni-supercar-show-beograd-maj-2026/`,
  standup: `${BASE}/event/standupfest-premijera-katran-i-perje-srdjana-dincica-novi-sad-19-oktobar-2026/`,
  cancelled: `${BASE}/event/kamelot-otkazano-beograd-2026/`,
  noDate: `${BASE}/event/koncert-bez-datuma-beograd-2026/`,
  gone: `${BASE}/event/obrisani-dogadjaj-2026/`,
};

// newest lastmod first is the discovery order the adapter imposes
const SITEMAP_ENTRIES: { loc: string; lastmod: string }[] = [
  { loc: U.standup, lastmod: "2026-09-05T10:00:00+00:00" },
  { loc: U.cancelled, lastmod: "2026-09-04T10:00:00+00:00" },
  { loc: U.noDate, lastmod: "2026-09-03T10:00:00+00:00" },
  { loc: U.gone, lastmod: "2026-09-02T10:00:00+00:00" },
  { loc: U.intercell, lastmod: "2026-08-05T16:30:09+00:00" },
  { loc: U.supercar, lastmod: "2026-04-11T09:20:00+00:00" },
  { loc: U.kamelot, lastmod: "2026-03-04T14:56:31+00:00" },
];

function sitemapIndex(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${BASE}/page-sitemap.xml</loc><lastmod>2026-08-20T08:51:34+00:00</lastmod></sitemap>
  <sitemap><loc>${BASE}/event-sitemap.xml</loc><lastmod>2026-09-08T06:09:15+00:00</lastmod></sitemap>
  <sitemap><loc>${BASE}/venue-sitemap.xml</loc><lastmod>2026-08-28T17:31:41+00:00</lastmod></sitemap>
</sitemapindex>`;
}

function eventSitemap(entries: { loc: string; lastmod: string }[]): string {
  const urls = entries
    .map((e) => `  <url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod></url>`)
    .join("\n");
  // includes the /event/ archive URL, which the adapter must drop
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE}/event/</loc><lastmod>2026-09-08T06:09:15+00:00</lastmod></url>
${urls}
</urlset>`;
}

// ── mocked network ─────────────────────────────────────────────────
interface RouteResult {
  status?: number;
  body: string;
  contentType?: string;
}

function buildRoutes(entries: { loc: string; lastmod: string }[]): Map<string, RouteResult> {
  return new Map<string, RouteResult>([
    [`${BASE}/sitemap_index.xml`, { body: sitemapIndex(), contentType: "application/xml" }],
    [`${BASE}/event-sitemap.xml`, { body: eventSitemap(entries), contentType: "application/xml" }],

    [U.intercell, { body: read("gigstix-event-intercell.html"), contentType: "text/html" }],
    [U.kamelot, { body: KAMELOT, contentType: "text/html" }],
    [U.supercar, { body: read("gigstix-event-supercar.html"), contentType: "text/html" }],
    [U.standup, { body: read("gigstix-event-standup.html"), contentType: "text/html" }],
    [U.cancelled, { body: KAMELOT_CANCELLED, contentType: "text/html" }],
    [U.noDate, { body: KAMELOT_NO_DATE, contentType: "text/html" }],
    [U.gone, { status: 404, body: read("gigstix-event-notfound.html"), contentType: "text/html" }],

    // venue enrichment pages
    [`${BASE}/venue/hangar-luka-beograd/`, { body: read("gigstix-venue-luka-beograd.html"), contentType: "text/html" }],
    [`${BASE}/venue/drugstore/`, { body: read("gigstix-venue-barutana.html"), contentType: "text/html" }],
    [`${BASE}/venue/radnicki-dom-novi-sad/`, { status: 404, body: "not found", contentType: "text/html" }],
    [`${BASE}/venue/beogradski-sajam/`, { status: 404, body: "not found", contentType: "text/html" }],
  ]);
}

interface MockNet {
  fetchCalls: string[];
  restore: () => void;
}

function installMockNet(routes: Map<string, RouteResult>): MockNet {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const fetchCalls: string[] = [];

  // Collapse the adapter's politeness / back-off pauses (<=1s) to immediate so
  // the test is fast; leave the 30s abort-timeout timer real.
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, delay != null && delay <= 1000 ? 0 : delay, ...rest)) as typeof setTimeout;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);
    const route = routes.get(url);
    if (!route) {
      return new Response(`unrouted: ${url}`, { status: 599 });
    }
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: route.contentType ? { "content-type": route.contentType } : undefined,
    });
  }) as typeof fetch;

  return {
    fetchCalls,
    restore: () => {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

// ── READ-ONLY fake Supabase (throws on any write) ──────────────────
function readOnlySupabase(tables: Record<string, unknown[]>): {
  client: SupabaseClient;
  writeAttempts: string[];
} {
  const writeAttempts: string[] = [];
  const guard = (name: string) => () => {
    writeAttempts.push(name);
    throw new Error(`WRITE ATTEMPTED: ${name}`);
  };
  const client = {
    rpc: guard("rpc"),
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        then: (resolve: (r: { data: unknown[]; error: null }) => void) =>
          resolve({ data: tables[table] ?? [], error: null }),
        insert: guard("insert"),
        update: guard("update"),
        upsert: guard("upsert"),
        delete: guard("delete"),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, writeAttempts };
}

const BELGRADE = { id: "city-bg", name: "Belgrade", country_id: "RS" };
const DRUGSTORE_ROW = {
  id: "v-drugstore",
  name: "Drugstore",
  name_normalized: "drugstore",
  source_id: null,
  external_id: null,
  source_url: null,
  latitude: 44.8185264,
  longitude: 20.488357,
  coordinates_source: "manual",
  address: null,
  website: null,
  opening_hours: null,
  wikidata: null,
  city_id: "city-bg",
};

function ctx(over: Partial<SourceContext> = {}): SourceContext {
  return {
    countries: ["RS"],
    cities: [],
    defaultTimeZone: "Europe/Belgrade",
    userAgent: "nightlife-e2e-test",
    baseUrl: BASE,
    limit: 0,
    verbose: false,
    ...over,
  };
}

async function runPipeline(entries: { loc: string; lastmod: string }[]) {
  const net = installMockNet(buildRoutes(entries));
  const { client, writeAttempts } = readOnlySupabase({
    cities: [BELGRADE],
    venues: [DRUGSTORE_ROW],
  });
  try {
    const c = ctx();
    const resolver = await createVenueResolver(client, {
      countryIds: ["RS"],
      sourceKey: gigstixAdapter.key,
      sourceTrusted: true,
      enabledCities: ["Belgrade"],
      fetchSourceVenue: gigstixAdapter.fetchSourceVenue
        ? (id) => gigstixAdapter.fetchSourceVenue!(id, c)
        : undefined,
    });
    const report = await runEventDryRun({
      adapter: gigstixAdapter,
      ctx: c,
      resolver,
      eventFirstMaxNewVenues: 50,
    });
    return { report, writeAttempts, fetchCalls: net.fetchCalls };
  } finally {
    net.restore();
  }
}

// ════════════════════════════════════════════════════════════════════

test("[e2e] the connected pipeline produces the right outcome for every event", async () => {
  const { report, writeAttempts } = await runPipeline(SITEMAP_ENTRIES);
  const s = report.stats;

  // ---- discovery: 7 detail URLs, /event/ archive dropped -------------
  assert.equal(s.discovered, 7);

  // ---- fetch: the 404 is the only fetch failure --------------------
  assert.equal(s.fetchFailed, 1);
  assert.equal(report.items.find((i) => i.stage === "fetch-failed")!.url, U.gone);
  assert.equal(s.fetched, 6);

  // ---- parse: the garbage-date event is the only parse failure -----
  assert.equal(s.parseFailed, 1);
  const pf = report.items.find((i) => i.stage === "parse-failed")!;
  assert.equal(pf.url, U.noDate);
  assert.match(pf.reason!, /unparseable-date/);
  assert.equal(s.parsed, 5);

  // ---- relevance: supercar rejected, the rest accepted -------------
  assert.equal(s.rejected, 1);
  const rej = report.items.find((i) => i.stage === "rejected")!;
  assert.equal(rej.url, U.supercar);
  assert.match(rej.reason!, /supercar/);

  assert.equal(s.accepted, 4);
  assert.equal(s.acceptedPrimary, 3); // intercell, kamelot, kamelot-cancelled
  assert.equal(s.acceptedSecondary, 1); // standup

  // ---- per-event resolution --------------------------------------
  const byUrl = (u: string) => report.items.find((i) => i.url === u)!;

  const intercell = byUrl(U.intercell);
  assert.equal(intercell.stage, "accepted");
  assert.equal(intercell.venue!.status, "matched_existing");
  assert.equal(intercell.venue!.matchedVenueId, "v-drugstore");
  assert.equal(intercell.identity!.venueKey, "venue:v-drugstore");
  assert.equal(intercell.identity!.sourceKey, "gigstix:25772");
  assert.equal(intercell.identity!.localDate, "2026-10-30");

  const kamelot = byUrl(U.kamelot);
  assert.equal(kamelot.stage, "accepted");
  assert.equal(kamelot.venue!.status, "safe_new_venue");
  assert.equal(kamelot.venue!.locationConfidence, "coordinates");
  assert.equal(kamelot.venue!.city, "Belgrade");
  assert.match(kamelot.identity!.venueKey, /^name:/);

  const cancelled = byUrl(U.cancelled);
  assert.equal(cancelled.stage, "accepted");
  assert.equal(cancelled.event!.status, "cancelled");
  assert.equal(cancelled.venue!.status, "safe_new_venue");
  assert.equal(cancelled.identity!.sourceKey, "gigstix:23281");

  const standup = byUrl(U.standup);
  assert.equal(standup.stage, "accepted");
  assert.equal(standup.relevance!.accepted && standup.relevance!.tier, "secondary");
  assert.equal(standup.venue!.status, "needs_review");
  assert.ok(standup.venue!.reasonCodes.includes("city-unknown"));

  // ---- event-first: only unresolved venues become candidates.
  //      Drugstore (matched_existing) is NOT one. Kamelot + its cancelled
  //      twin fold into a SINGLE safe candidate; Radnički dom is a separate
  //      needs_review candidate. ----------------------------------------
  const candByKey = new Map(report.eventFirst.candidates.map((c) => [c.candidateKey, c]));
  assert.equal(report.eventFirst.candidates.length, 2);
  assert.ok(
    !report.eventFirst.candidates.some((c) => c.candidateKey.includes("drugstore")),
    "a matched existing venue never becomes an event-first candidate",
  );

  const hangar = candByKey.get("svid:gigstix:hangar-luka-beograd")!;
  assert.equal(hangar.status, "safe_new_venue");
  assert.equal(hangar.eventCount, 2);
  assert.equal(hangar.locationConfidence, "coordinates");
  assert.deepEqual(
    hangar.exampleEvents.map((e) => e.url).sort(),
    [U.cancelled, U.kamelot].sort(),
  );

  const radnicki = candByKey.get("svid:gigstix:radnicki-dom-novi-sad")!;
  assert.equal(radnicki.status, "needs_review");
  assert.equal(radnicki.eventCount, 1);
  assert.deepEqual(radnicki.reasonCodes, ["city-unknown"]);

  assert.equal(report.eventFirst.safeCount, 1);
  assert.equal(report.eventFirst.needsReviewCount, 1);
  assert.equal(report.eventFirst.capExceeded, false);

  // ---- run health: 1/7 fetch + 1/5 parse failure -> still ok -------
  assert.equal(s.status, "ok");

  // ---- planned canonical inserts: 4 distinct source keys ----------
  assert.equal(s.plannedCanonicalInserts, 4);

  // ---- ZERO Supabase writes -------------------------------------
  assert.deepEqual(writeAttempts, []);

  // report renders without throwing
  assert.ok(formatReport(report, { verbose: true }).length > 0);
});

test("[e2e] discovery order does not change the result (determinism)", async () => {
  const forward = await runPipeline(SITEMAP_ENTRIES);
  const reversed = await runPipeline([...SITEMAP_ENTRIES].reverse());

  const norm = (r: Awaited<ReturnType<typeof runPipeline>>) => ({
    stats: { ...r.report.stats, durationMs: 0 },
    items: r.report.items
      .map((i) => ({
        url: i.url,
        stage: i.stage,
        venueStatus: i.venue?.status ?? null,
        venueKey: i.identity?.venueKey ?? null,
        sourceKey: i.identity?.sourceKey ?? null,
      }))
      .sort((a, b) => (a.url < b.url ? -1 : 1)),
    eventFirst: r.report.eventFirst,
  });

  assert.deepEqual(norm(forward), norm(reversed));
  assert.deepEqual(forward.writeAttempts, []);
  assert.deepEqual(reversed.writeAttempts, []);
});

test("[e2e] a second identical run is byte-for-byte identical (report determinism)", async () => {
  const a = await runPipeline(SITEMAP_ENTRIES);
  const b = await runPipeline(SITEMAP_ENTRIES);

  // `stats.durationMs` is a wall-clock measurement and is the one field in the
  // report that legitimately differs between two runs (it renders as `(0.0s)` /
  // `(0.1s)`). Normalize it — as the discovery-order determinism test above
  // already does — so this stays a report-*content* determinism check.
  const stripDuration = (r: Awaited<ReturnType<typeof runPipeline>>["report"]) => ({
    ...r,
    stats: { ...r.stats, durationMs: 0 },
  });

  assert.equal(
    formatReport(stripDuration(a.report), { verbose: true }),
    formatReport(stripDuration(b.report), { verbose: true }),
  );
});
