/**
 * `../../src/sync/adapters/gigstix-event.ts` — one GIGS TIX event page → the
 * sync engine's normalized event record, validated by the event contract.
 *
 * Fixture-driven (the real pages under `../events/fixtures/`), with small,
 * deterministic HTML edits for the failure / missing-field cases. No network,
 * no store, no wall clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GIGSTIX_SOURCE_KEY,
  parseGigstixEventRecord,
  type GigstixEventParse,
} from "../../src/sync/adapters/gigstix-event.ts";
import { eventInstants, validateEventContract, type NormalizedEvent } from "../../src/sync/event-contract.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../events/fixtures/gigstix-event-${name}.html`, import.meta.url), "utf8");
const INTERCELL = fixture("intercell");
const INTERCELL_URL = "https://new.gigstix.com/event/intercell-with-dvs1/";
const CTX = { fetchedAt: "2026-09-27T08:00:00.000Z" };

function record(result: GigstixEventParse): NormalizedEvent {
  assert.ok(result.ok, JSON.stringify(result));
  return result.record;
}
const intercell = () => record(parseGigstixEventRecord(INTERCELL, INTERCELL_URL, CTX));

// ── a representative valid page ─────────────────────────────────────────
test("a valid GIGS TIX event page becomes a normalized event record", () => {
  const r = intercell();
  assert.equal(r.kind, "event");
  assert.equal(r.provenance.sourceKey, GIGSTIX_SOURCE_KEY);
  assert.equal(r.provenance.fetchedAt, CTX.fetchedAt);
  assert.equal(r.scope.countryCode, "RS");
});

test("external event id is the WordPress post id", () => {
  assert.equal(intercell().provenance.externalId, "25772");
});

test("title", () => {
  assert.equal(intercell().fields.title, "Intercell with DVS1");
});

test("date/time: the page's local wall-clock, in Europe/Belgrade from the GIGS configuration", () => {
  const { fields } = intercell();
  assert.equal(fields.startLocal, "2026-10-30T23:00");
  assert.equal(fields.startPrecision, "datetime");
  assert.equal(fields.endLocal, null);
  assert.equal(fields.timeZone, "Europe/Belgrade");
  assert.deepEqual(eventInstants(fields, null), { ok: true, startAt: "2026-10-30T22:00:00.000Z", endAt: null });
});

test("an end time on the page is carried as endLocal (Supercar: 'Traje do')", () => {
  const r = record(parseGigstixEventRecord(fixture("supercar"), "https://new.gigstix.com/event/gt-serbia/", CTX));
  assert.equal(r.fields.startLocal, "2026-05-09T10:00");
  assert.equal(r.fields.endLocal, "2026-05-10T19:00");
});

test("venue name and city", () => {
  const r = intercell();
  assert.equal(r.links.venue?.name, "Drugstore");
  assert.equal(r.links.venue?.cityText, "Beograd");
  assert.equal(r.scope.cityText, "Beograd");
});

test("source URL is the page URL", () => {
  assert.equal(intercell().provenance.sourceUrl, INTERCELL_URL);
});

test("ticket URL when present", () => {
  assert.equal(intercell().fields.ticketUrl, "https://bilet.gigstix.com/rs/store/gigstix_v2/sectionGroup/index/9369");
});

test("description and cover image when present", () => {
  const { fields } = intercell();
  assert.match(fields.description ?? "", /^Our first swing at Belgrade hits inside Club Drugstore\./);
  assert.equal(fields.coverImageUrl, "https://new.gigstix.com/wp-content/uploads/2026/08/intercell_baner800.jpg");
});

test("venue is only a hint: name + GIGS venue slug + city — never a canonical venue id", () => {
  const venue = intercell().links.venue!;
  assert.deepEqual(venue, {
    name: "Drugstore",
    sourceVenueId: "drugstore",
    address: null,
    coordinates: null,
    cityText: "Beograd",
  });
  for (const key of ["canonicalId", "venueId", "id"]) assert.equal(key in venue, false, key);
});

test("the resulting record passes the normalized event contract (every fixture)", () => {
  for (const [name, url] of [
    ["intercell", INTERCELL_URL],
    ["kamelot", "https://new.gigstix.com/event/kamelot/"],
    ["standup", "https://new.gigstix.com/event/standup/"],
    ["supercar", "https://new.gigstix.com/event/gt-serbia/"],
  ]) {
    const r = record(parseGigstixEventRecord(fixture(name), url, CTX));
    assert.equal(validateEventContract(r, null), null, name);
  }
});

// ── optional fields ─────────────────────────────────────────────────────
test("missing optional fields (ticket, image, description, end) do not fail — they stay absent", () => {
  const stripped = INTERCELL
    .replace(/href=["']https?:\/\/bilet\.gigstix\.com[^"']*["']/g, 'href="#"')
    .replace(/<meta[^>]*og:(image|description)[^>]*>/g, "")
    .replace(/gt-section-title">O događaju/, 'gt-section-title">Galerija');
  const r = record(parseGigstixEventRecord(stripped, INTERCELL_URL, CTX));
  assert.equal(r.fields.ticketUrl, null);
  assert.equal(r.fields.coverImageUrl, null);
  assert.equal(r.fields.description, null);
  assert.equal(r.fields.endLocal, null);
  assert.equal(validateEventContract(r, null), null);
});

// ── parse failures (never a manufactured event) ─────────────────────────
test("missing title → parse failure", () => {
  const html = INTERCELL.replace(/<title[^>]*>[\s\S]*?<\/title>/i, "<title></title>").replace(/<meta[^>]*og:title[^>]*>/g, "");
  assert.deepEqual(parseGigstixEventRecord(html, INTERCELL_URL, CTX), { ok: false, reason: "missing-title" });
});

test("missing event id → parse failure (no post id anywhere, no /event/<slug>/ URL)", () => {
  const html = INTERCELL.replace(/postid-\d+/g, "").replace(/wp-json\/wp\/v2\/event\/\d+/g, "").replace(/[?&]p=\d+/g, "");
  assert.deepEqual(parseGigstixEventRecord(html, "https://new.gigstix.com/", CTX), { ok: false, reason: "missing-external-id" });
});

test("invalid or missing date/time → parse failure", () => {
  for (const [bad, detail] of [
    ["uskoro", "uskoro"],
    ["petak 31. februara 2026. 23.00", "petak 31. februara 2026. 23.00"],
    ["petak 30. oktobra 2026. 23.75", "petak 30. oktobra 2026. 23.75"], // a stated but impossible time
  ]) {
    const html = INTERCELL.replace("petak 30. oktobra 2026. 23.00", bad);
    assert.deepEqual(parseGigstixEventRecord(html, INTERCELL_URL, CTX), { ok: false, reason: "unparseable-date", detail }, bad);
  }
});

test("a GIGS 'page not found' page → parse failure", () => {
  const result = parseGigstixEventRecord(fixture("notfound"), "https://new.gigstix.com/event/gone/", CTX);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not-found-page");
});

// ── the contract, not the parser, is the final gate ─────────────────────
test("a city-only listing parses, but the contract rejects it: no venue identity to match", () => {
  // GIGS TIX sometimes names only a city ("Mesto") — a real listing, not a
  // parse error — but the sync contract needs a venue name or venue id.
  const cityOnly = INTERCELL.replace(/<li[^>]*class=["']gt-venue["'][\s\S]*?<\/li>/i, "");
  const r = record(parseGigstixEventRecord(cityOnly, INTERCELL_URL, CTX));
  assert.equal(r.links.venue?.name, "");
  assert.equal(r.links.venue?.sourceVenueId, null);
  assert.equal(r.links.venue?.cityText, "Beograd");
  assert.equal(validateEventContract(r, null)?.reasonCode, "missing-venue-identity");
});

test("the zone and country come from the context when given (no silent override)", () => {
  const r = record(parseGigstixEventRecord(INTERCELL, INTERCELL_URL, { ...CTX, timeZone: "Europe/Zagreb", countryCode: "HR" }));
  assert.equal(r.fields.timeZone, "Europe/Zagreb");
  assert.equal(r.scope.countryCode, "HR");
});
