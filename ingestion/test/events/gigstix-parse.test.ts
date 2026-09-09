import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGigstixEvent } from "../../src/events/adapters/gigstix-parse.ts";
import type { NormalizedEvent } from "../../src/events/types.ts";

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function parseOk(fixture: string, url: string): NormalizedEvent {
  const result = parseGigstixEvent(read(fixture), url);
  assert.equal(result.ok, true, `expected ${fixture} to parse`);
  if (!result.ok) throw new Error("unreachable");
  return result.event;
}

const INTERCELL_URL =
  "https://new.gigstix.com/event/intercell-with-dvs1-beograd-30-oktobar-2026/";
const KAMELOT_URL =
  "https://new.gigstix.com/event/kamelot-beograd-15-novembar-2026/";
const SUPERCAR_URL =
  "https://new.gigstix.com/event/gt-serbia-medjunarodni-supercar-show-beograd-maj-2026/";
const STANDUP_URL =
  "https://new.gigstix.com/event/standupfest-premijera-katran-i-perje-srdjana-dincica-novi-sad-19-oktobar-2026/";

test("gigstix parse: numeric WordPress post id is the externalId", () => {
  assert.equal(parseOk("gigstix-event-intercell.html", INTERCELL_URL).externalId, "25772");
  assert.equal(parseOk("gigstix-event-kamelot.html", KAMELOT_URL).externalId, "23274");
  assert.equal(parseOk("gigstix-event-standup.html", STANDUP_URL).externalId, "26200");
});

test("gigstix parse: title stripped of the site suffix", () => {
  assert.equal(
    parseOk("gigstix-event-intercell.html", INTERCELL_URL).title,
    "Intercell with DVS1",
  );
  assert.equal(parseOk("gigstix-event-kamelot.html", KAMELOT_URL).title, "Kamelot");
});

test("gigstix parse: local start date/time + precision, no time zone conversion", () => {
  const e = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  assert.equal(e.startLocal, "2026-10-30T23:00");
  assert.equal(e.startPrecision, "datetime");
  assert.equal(e.timeZone, undefined); // the adapter stamps the zone, not the parser
  assert.equal(e.endLocal, undefined);
});

test("gigstix parse: 'Traje do' becomes endLocal", () => {
  const e = parseOk("gigstix-event-supercar.html", SUPERCAR_URL);
  assert.equal(e.startLocal, "2026-05-09T10:00");
  assert.equal(e.endLocal, "2026-05-10T19:00");
});

test("gigstix parse: venue name, source venue slug and city", () => {
  const e = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  assert.equal(e.venue.name, "Drugstore");
  assert.equal(e.venue.sourceVenueId, "drugstore");
  assert.equal(e.venue.city, "Beograd");

  const k = parseOk("gigstix-event-kamelot.html", KAMELOT_URL);
  assert.equal(k.venue.name, "Hangar");
  assert.equal(k.venue.sourceVenueId, "hangar-luka-beograd");

  const s = parseOk("gigstix-event-standup.html", STANDUP_URL);
  assert.equal(s.venue.city, "Novi Sad");
});

test("gigstix parse: promoter name kept, legal address dropped to reported", () => {
  const e = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  assert.equal(e.promoter, "UR BIVŠI BEOGRAD PR N.R.");

  const s = parseOk("gigstix-event-standup.html", STANDUP_URL);
  assert.equal(s.promoter, "UDUŽENJE ZA RAZVOJ KULTURE FREE SPACE");
  assert.match(String(s.reported.promoterText), /Žarka Zrenjanina/); // full text retained
});

test("gigstix parse: ticket URL + numeric ticketing id", () => {
  const e = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  assert.equal(
    e.ticketUrl,
    "https://bilet.gigstix.com/rs/store/gigstix_v2/sectionGroup/index/9369",
  );
  assert.equal(e.reported.ticketingId, "9369");
});

test("gigstix parse: description from the 'O događaju' section, tickets text excluded", () => {
  const e = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  assert.match(e.description ?? "", /former slaughterhouse/);
  assert.doesNotMatch(e.description ?? "", /EARLY BIRD/);
  assert.doesNotMatch(e.description ?? "", /CENA/);
});

test("gigstix parse: category slugs captured for the relevance filter", () => {
  assert.deepEqual(parseOk("gigstix-event-kamelot.html", KAMELOT_URL).reported.categories, [
    "koncert",
  ]);
  assert.deepEqual(
    parseOk("gigstix-event-supercar.html", SUPERCAR_URL).reported.categories,
    ["dogadjaj"],
  );
  assert.deepEqual(
    parseOk("gigstix-event-standup.html", STANDUP_URL).reported.categories,
    ["stand-up"],
  );
});

test("gigstix parse: cover image from og:image; lineup is never guessed", () => {
  const e = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  assert.match(e.coverImageUrl ?? "", /intercell_baner800\.jpg$/);
  assert.equal(e.lineup, undefined);
  assert.equal(e.reported.lineupAvailable, false);
});

test("gigstix parse: pure/deterministic, and a content change shows in the parsed event", () => {
  // The adapter does NOT compute a change-detection hash — that is the generic
  // sync engine's job (`hashComparable` over the comparable projection). What
  // the adapter must guarantee is determinism + that content changes surface.
  const a = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  const b = parseOk("gigstix-event-intercell.html", INTERCELL_URL);
  assert.deepEqual(a, b);

  const mutated = read("gigstix-event-intercell.html").replace(
    "petak 30. oktobra 2026. 23.00",
    "petak 30. oktobra 2026. 22.00",
  );
  const c = parseGigstixEvent(mutated, INTERCELL_URL);
  assert.equal(c.ok, true);
  if (c.ok) {
    assert.notEqual(c.event.startLocal, a.startLocal);
    assert.notDeepEqual(c.event, a);
  }
});

test("gigstix parse: no explicit signal -> status undefined (omission is never cancellation)", () => {
  const e = parseOk("gigstix-event-kamelot.html", KAMELOT_URL);
  assert.equal(e.status, undefined);
});

test("gigstix parse: the adapter does not emit a contentHash field", () => {
  const e = parseOk("gigstix-event-kamelot.html", KAMELOT_URL);
  assert.equal(Object.hasOwn(e, "contentHash"), false);
});

test("gigstix parse: an explicit marker sets a single status (cancelled | postponed)", () => {
  const base = read("gigstix-event-kamelot.html");

  const cancelled = parseGigstixEvent(
    base.replace("<title>Kamelot", "<title>Kamelot – OTKAZANO"),
    KAMELOT_URL,
  );
  assert.equal(cancelled.ok, true);
  if (cancelled.ok) assert.equal(cancelled.event.status, "cancelled");

  const postponed = parseGigstixEvent(
    base.replace("eventcat-koncert", "eventcat-koncert eventcat-odlozeno-otkazano"),
    KAMELOT_URL,
  );
  assert.equal(postponed.ok, true);
  if (postponed.ok) assert.equal(postponed.event.status, "postponed");
});

test("gigstix parse: date-only detail row -> date precision, no invented time", () => {
  const dateOnly = read("gigstix-event-kamelot.html").replace(
    "nedelja 15. novembra 2026. 18.00",
    "nedelja 15. novembra 2026.",
  );
  const result = parseGigstixEvent(dateOnly, KAMELOT_URL);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.startLocal, "2026-11-15");
    assert.equal(result.event.startPrecision, "date");
  }
});

test("gigstix parse: 404 page -> ParseFailure, not a bogus event", () => {
  const result = parseGigstixEvent(
    read("gigstix-event-notfound.html"),
    "https://new.gigstix.com/event/exit-festival-2026-novi-sad/",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not-found-page");
});

test("gigstix parse: unparseable date -> ParseFailure with the raw text", () => {
  const broken = read("gigstix-event-kamelot.html").replace(
    "nedelja 15. novembra 2026. 18.00",
    "uskoro — datum se objavljuje",
  );
  const result = parseGigstixEvent(broken, KAMELOT_URL);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unparseable-date");
    assert.match(result.detail ?? "", /uskoro/);
  }
});

test("gigstix parse: city named but no venue -> ok, venue.name empty (not a failure)", () => {
  const cityOnly = read("gigstix-event-kamelot.html").replace(
    /<li class="gt-venue">[\s\S]*?<\/li>/,
    "",
  );
  const result = parseGigstixEvent(cityOnly, KAMELOT_URL);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.venue.name, "");
    assert.equal(result.event.venue.city, "Beograd");
    assert.equal(result.event.reported.venueNamedInSource, false);
  }
});

test("gigstix parse: no venue AND no city -> ParseFailure", () => {
  let html = read("gigstix-event-kamelot.html")
    .replace(/<li class="gt-venue">[\s\S]*?<\/li>/, "")
    .replace(/<li class="gt-locations">[\s\S]*?<\/li>\s*<\/ul>/, "</ul>");
  const result = parseGigstixEvent(html, KAMELOT_URL);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-location");
});

test("gigstix parse: missing detail box -> ParseFailure", () => {
  const result = parseGigstixEvent(
    "<!doctype html><html><head><title>Foo - gigstix.com</title></head><body class='postid-1'>x</body></html>",
    "https://new.gigstix.com/event/foo/",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-details");
});
