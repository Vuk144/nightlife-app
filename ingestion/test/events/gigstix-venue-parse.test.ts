import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGigstixVenue } from "../../src/events/adapters/gigstix-venue-parse.ts";

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("venue parse: name, WordPress post id, address, coordinates, city", () => {
  const r = parseGigstixVenue(
    read("gigstix-venue-barutana.html"),
    "https://new.gigstix.com/venue/barutana-bg/",
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.venue.name, "Barutana BG");
  assert.equal(r.venue.externalId, "4710");
  assert.equal(r.venue.address, "Beogradska tvrđava, Kalemegdan");
  assert.equal(r.venue.latitude, 44.8238974);
  assert.equal(r.venue.longitude, 20.4474708);
  assert.equal(r.venue.city, "Beograd");
});

test("venue parse: diacritics preserved (Dorćol Platz)", () => {
  const r = parseGigstixVenue(
    read("gigstix-venue-dorcol-platz.html"),
    "https://new.gigstix.com/venue/dorcol-platz/",
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.venue.name, "Dorćol Platz");
    assert.equal(r.venue.address, "Dobračina 59");
  }
});

test("venue parse: a 0/0 map placeholder becomes null coordinates, address kept", () => {
  const r = parseGigstixVenue(
    read("gigstix-venue-no-coords.html"),
    "https://new.gigstix.com/venue/dorcol-platz/",
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.venue.latitude, null);
    assert.equal(r.venue.longitude, null);
    assert.equal(r.venue.address, "Dobračina 59");
  }
});

test("venue parse: not-a-venue page -> failure", () => {
  const r = parseGigstixVenue(
    "<!doctype html><html><head><title>Intercell - gigstix.com</title></head>" +
      "<body class='single single-event postid-1'>x</body></html>",
    "https://new.gigstix.com/event/intercell/",
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not-a-venue-page");
});

test("venue parse: 404 page -> failure", () => {
  const r = parseGigstixVenue(
    "<!doctype html><html><head><title>Stranica nije pronađena - gigstix.com</title></head>" +
      "<body class='single-venue'>x</body></html>",
    "https://new.gigstix.com/venue/nope/",
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not-found-page");
});

test("venue parse: no title and no og:title -> missing-name failure", () => {
  const r = parseGigstixVenue(
    "<!doctype html><html><head></head><body class='single-venue'>x</body></html>",
    "https://new.gigstix.com/venue/nope/",
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing-name");
});

test("venue parse: no postid, no ?p= shortlink, and a URL with no slug -> missing-external-id failure", () => {
  const r = parseGigstixVenue(
    "<!doctype html><html><head><title>Some Venue - gigstix.com</title></head>" +
      "<body class='single-venue'>x</body></html>",
    "https://new.gigstix.com/venue/",
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing-external-id");
});

test("venue parse: city falls back to og:description when the Mesto row itself is absent", () => {
  const base = read("gigstix-venue-barutana.html");
  const noMestoRow = base.replace(
    '<li class="gt-locations"><div class="gt-icon"><svg></svg></div><div class="gt-content"><div class="gt-title">Mesto</div><div class="gt-inner"><ul><li><a href="https://new.gigstix.com/location/beograd/?post_type=venue">Beograd</a></li></ul></div></div></li>',
    "",
  );
  assert.ok(!noMestoRow.includes("gt-locations"), "fixture shape assumed by this test has not changed");
  const r = parseGigstixVenue(noMestoRow, "https://new.gigstix.com/venue/barutana-bg/");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.venue.city, "Beograd"); // from og:description "Beograd, Srbija"
});

// ---- REGRESSIONS -------------------------------------------------------

test("[regression] a leading empty wrapper div inside gt-inner (common Visual Composer pattern) does not truncate the value to nothing", () => {
  // Previously detailInner's capture stopped at the FIRST </div> after
  // gt-inner's own opening tag. A common WordPress/VC pattern — an empty
  // decorative/icon div preceding the real content — made that first </div>
  // belong to the WRAPPER, not gt-inner itself, silently losing the value.
  const base = read("gigstix-venue-barutana.html");
  const mutated = base.replace(
    '<div class="gt-inner">Beogradska tvrđava, Kalemegdan</div>',
    '<div class="gt-inner"><div class="vc_icon"></div>Beogradska tvrđava, Kalemegdan</div>',
  );
  assert.ok(mutated.includes("vc_icon"), "mutation was applied");
  const r = parseGigstixVenue(mutated, "https://new.gigstix.com/venue/barutana-bg/");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.venue.address, "Beogradska tvrđava, Kalemegdan");
});
