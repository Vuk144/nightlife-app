/**
 * Characterization of how the sole `EventSourceAdapter` (GIGS TIX) fulfils the
 * `../../src/events/types.ts` contract.
 *
 * The pure parsers themselves are covered by `gigstix-parse.test.ts` /
 * `gigstix-venue-parse.test.ts` / `sitemap.test.ts`; the gap THIS file closes
 * is everything specific to the adapter object itself: the `parse()` wrapper's
 * time-zone stamp (`NormalizedEvent.timeZone`: "authoritative when set; a
 * genuinely single-zone source may stamp the region fallback"), the
 * `ParseResult` pass-through, `capabilities` honesty, and — via a mocked
 * `globalThis.fetch` — `discover()`'s own HTTP-orchestration logic
 * (multi-sitemap merge, index/child fetch failure handling) and
 * `fetchSourceVenue()`'s slug validation. `pipeline-e2e.test.ts` additionally
 * exercises the whole adapter as part of the full engine pipeline; the tests
 * here are narrower and adapter-specific.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gigstixAdapter } from "../../src/events/adapters/gigstix.ts";
import type { RawEvent, SourceContext } from "../../src/events/types.ts";

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const BASE = "https://new.gigstix.com";

interface RouteResult {
  status?: number;
  body: string;
}

/** Mocks `globalThis.fetch` (the primitive `httpGetText` calls) for exactly
 * the routes given; anything else resolves as an unrouted 599, so a stray
 * request is loud, not silently ignored. Collapses EVERY `setTimeout` delay
 * (politeness pauses, retry backoff, the abort-timeout timer) to immediate —
 * safe here because the mocked fetch always resolves synchronously, so no
 * real timing/abort race is ever actually exercised. */
function installMockFetch(routes: Map<string, RouteResult>) {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const fetchCalls: string[] = [];

  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ...rest: unknown[]) =>
    realSetTimeout(fn, 0, ...rest)) as typeof setTimeout;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);
    const route = routes.get(url);
    if (!route) return new Response(`unrouted: ${url}`, { status: 599 });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/xml" },
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

const KAMELOT_URL = "https://new.gigstix.com/event/kamelot-beograd-15-novembar-2026/";

function ctx(defaultTimeZone = "Europe/Belgrade"): SourceContext {
  return {
    countries: ["RS"],
    cities: [],
    defaultTimeZone,
    userAgent: "nightlife-test",
    baseUrl: "https://new.gigstix.com",
    limit: 0,
    verbose: false,
  };
}

function raw(body: string, url: string): RawEvent {
  return { ref: { url }, url, status: 200, body, fetchedAt: "2026-06-01T00:00:00.000Z" };
}

test("adapter.parse: stamps ctx.defaultTimeZone (GIGS TIX is genuinely single-zone) when the parser leaves it unset", () => {
  const r = gigstixAdapter.parse(raw(read("gigstix-event-kamelot.html"), KAMELOT_URL), ctx("Europe/Belgrade"));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.event.timeZone, "Europe/Belgrade");
    // the local times themselves stay offset-free wall-clock strings
    assert.equal(r.event.startLocal, "2026-11-15T18:00");
    assert.equal(r.event.startPrecision, "datetime");
  }
});

test("adapter.parse: the stamped zone follows ctx, it is not hard-coded", () => {
  const r = gigstixAdapter.parse(raw(read("gigstix-event-kamelot.html"), KAMELOT_URL), ctx("UTC"));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.event.timeZone, "UTC");
});

test("adapter.parse: a ParseFailure is passed straight through — no fabricated event, no stamping", () => {
  const r = gigstixAdapter.parse(
    raw(read("gigstix-event-notfound.html"), "https://new.gigstix.com/event/x/"),
    ctx(),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not-found-page");
});

test("adapter.parse: pure — same (raw, ctx) => deep-equal result, RawEvent not mutated", () => {
  const rw = raw(read("gigstix-event-kamelot.html"), KAMELOT_URL);
  const before = JSON.stringify({ url: rw.url, status: rw.status, ref: rw.ref, fetchedAt: rw.fetchedAt });
  const a = gigstixAdapter.parse(rw, ctx());
  const b = gigstixAdapter.parse(rw, ctx());
  assert.deepEqual(a, b);
  assert.equal(
    JSON.stringify({ url: rw.url, status: rw.status, ref: rw.ref, fetchedAt: rw.fetchedAt }),
    before,
    "adapter.parse must not mutate its RawEvent input",
  );
});

test("adapter.capabilities: match the adapter's real behavior", () => {
  assert.deepEqual(gigstixAdapter.capabilities, {
    discovery: "sitemap",
    givesVenueId: true,
    givesLineup: false,
    givesPromoter: true,
    givesVenuePages: true,
  });

  const r = gigstixAdapter.parse(raw(read("gigstix-event-kamelot.html"), KAMELOT_URL), ctx());
  assert.equal(r.ok, true);
  if (r.ok) {
    // givesLineup:false  <=> parse never emits a lineup
    assert.equal(r.event.lineup, undefined);
    // givesVenueId:true  <=> parse emits a source venue id when the source names a venue
    assert.equal(typeof r.event.venue.sourceVenueId, "string");
    // givesPromoter:true <=> parse emits a promoter when the source has an Organizator row
    assert.equal(typeof r.event.promoter, "string");
  }
  // givesVenuePages:true <=> fetchSourceVenue is implemented
  assert.equal(typeof gigstixAdapter.fetchSourceVenue, "function");
});

// ---- discover() / fetchSourceVenue(): HTTP orchestration, over a mocked fetch ----

test("discover: merges + dedupes + orders events across MULTIPLE event-sitemap*.xml files", async () => {
  // gigstix-sitemap-index.xml lists both event-sitemap.xml AND
  // event-sitemap2.xml — the multi-sitemap merge this proves is otherwise
  // only exercised at the unit level (sitemap.test.ts), never through the
  // adapter's own discover() loop that fetches and combines them for real.
  const net = installMockFetch(
    new Map([
      [`${BASE}/sitemap_index.xml`, { body: read("gigstix-sitemap-index.xml") }],
      [`${BASE}/event-sitemap.xml`, { body: read("gigstix-event-sitemap.xml") }],
      [`${BASE}/event-sitemap2.xml`, { body: read("gigstix-event-sitemap2.xml") }],
    ]),
  );
  try {
    const refs = [];
    for await (const ref of gigstixAdapter.discover(ctx())) refs.push(ref);

    assert.ok(!refs.some((r) => r.url === `${BASE}/event/`), "archive URL dropped");
    assert.equal(
      refs.filter((r) => r.url.includes("intercell-with-dvs1")).length,
      1,
      "the event present in both sitemaps is merged into one ref",
    );
    assert.equal(refs[0].url.includes("standupfest"), true, "newest lastmod first");
  } finally {
    net.restore();
  }
});

test("discover: a failing CHILD sitemap is skipped, not fatal — the remaining sitemap's events still come through", async () => {
  const net = installMockFetch(
    new Map([
      [`${BASE}/sitemap_index.xml`, { body: read("gigstix-sitemap-index.xml") }],
      [`${BASE}/event-sitemap.xml`, { body: read("gigstix-event-sitemap.xml") }],
      [`${BASE}/event-sitemap2.xml`, { status: 500, body: "server error" }],
    ]),
  );
  try {
    const refs = [];
    for await (const ref of gigstixAdapter.discover(ctx())) refs.push(ref);
    // event-sitemap.xml's 3 detail URLs still come through despite sitemap2 failing
    assert.equal(refs.length, 3);
  } finally {
    net.restore();
  }
});

test("discover: sitemap index returning non-200 fails discovery with a clear error", async () => {
  const net = installMockFetch(
    new Map([[`${BASE}/sitemap_index.xml`, { status: 503, body: "unavailable" }]]),
  );
  try {
    await assert.rejects(async () => {
      const refs = [];
      for await (const ref of gigstixAdapter.discover(ctx())) refs.push(ref);
    }, /sitemap index returned HTTP 503/);
  } finally {
    net.restore();
  }
});

test("discover: an index with no event-sitemap*.xml entries fails discovery with a clear error", async () => {
  const noEventSitemaps =
    '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    `<sitemap><loc>${BASE}/page-sitemap.xml</loc></sitemap></sitemapindex>`;
  const net = installMockFetch(
    new Map([[`${BASE}/sitemap_index.xml`, { body: noEventSitemaps }]]),
  );
  try {
    await assert.rejects(async () => {
      const refs = [];
      for await (const ref of gigstixAdapter.discover(ctx())) refs.push(ref);
    }, /no event-sitemap\*\.xml entries/);
  } finally {
    net.restore();
  }
});

test("fetchSourceVenue: rejects a malicious/malformed sourceVenueId WITHOUT attempting any network request", async () => {
  // The slug is used to build an outbound URL (`${base}/venue/${slug}/`) —
  // this is the SSRF-relevant boundary: sourceVenueId ultimately comes from
  // parsing third-party HTML, so anything outside [a-z0-9-] must be rejected
  // before it ever reaches a fetch call, not just produce a failed request.
  const net = installMockFetch(new Map()); // any fetch call is an unrouted 599
  try {
    for (const malicious of [
      "../../../etc/passwd",
      "x/../../evil",
      "//evil.com/x",
      "x?redirect=evil.com",
      "x#fragment",
      "x y", // whitespace mid-string (not just leading/trailing)
    ]) {
      const result = await gigstixAdapter.fetchSourceVenue!(malicious, ctx());
      assert.equal(result, null, malicious);
    }
    assert.deepEqual(net.fetchCalls, [], "no network request was ever attempted");
  } finally {
    net.restore();
  }
});
