/**
 * Characterization of how the sole `EventSourceAdapter` (GIGS TIX) fulfils the
 * `../../src/events/types.ts` contract for the parts that do NOT touch the
 * network — the `parse()` wrapper and `capabilities`. The pure parser itself is
 * covered by `gigstix-parse.test.ts`; the gap this file closes is the adapter's
 * time-zone stamp (`NormalizedEvent.timeZone`: "authoritative when set; a
 * genuinely single-zone source may stamp the region fallback") and the
 * `ParseResult` pass-through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gigstixAdapter } from "../../src/events/adapters/gigstix.ts";
import type { RawEvent, SourceContext } from "../../src/events/types.ts";

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

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
  }
  // givesVenuePages:true <=> fetchSourceVenue is implemented
  assert.equal(typeof gigstixAdapter.fetchSourceVenue, "function");
});
