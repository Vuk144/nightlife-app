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
