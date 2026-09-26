import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIdentity } from "../../src/events/identity.ts";
import type { NormalizedEvent } from "../../src/events/types.ts";

// `compareEvents` band tests moved to `dedup.test.ts` with the module split.

function ev(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    externalId: "1",
    sourceUrl: "https://new.gigstix.com/event/x/",
    title: "Some Night",
    startLocal: "2026-10-30T23:00",
    startPrecision: "datetime",
    venue: { name: "Drugstore" },
    reported: {},
    ...overrides,
  };
}

test("computeIdentity: sourceKey is source + externalId", () => {
  const id = computeIdentity("gigstix", ev({ externalId: "25772" }), null);
  assert.equal(id.sourceKey, "gigstix:25772");
});

test("computeIdentity: venueKey uses the resolved id when available, else the name", () => {
  assert.equal(computeIdentity("gigstix", ev(), null).venueKey, "name:drugstore");
  assert.equal(
    computeIdentity("gigstix", ev(), "1f0e-uuid").venueKey,
    "venue:1f0e-uuid",
  );
});

test("computeIdentity: venueKey falls back to city when no venue name is given", () => {
  const noVenue = ev({ venue: { name: "", city: "Beograd" } });
  assert.equal(computeIdentity("gigstix", noVenue, null).venueKey, "city:beograd");

  const noVenueNoCity = ev({ venue: { name: "" } });
  assert.equal(computeIdentity("gigstix", noVenueNoCity, null).venueKey, "city:unknown");
});

test("[regression] computeIdentity: a whitespace-only venue name falls back to city, not an empty name bucket", () => {
  // "   " is truthy, so a naive `event.venue.name ? ... : ...` check takes the
  // "name:" branch — but it normalizes to "", collapsing EVERY whitespace-only-
  // named event (regardless of real city) into one shared `venueKey: "name:"`.
  const whitespaceVenue = ev({ venue: { name: "   ", city: "Beograd" } });
  assert.equal(computeIdentity("gigstix", whitespaceVenue, null).venueKey, "city:beograd");

  const whitespaceVenueNoCity = ev({ venue: { name: "\t\n" } });
  assert.equal(computeIdentity("gigstix", whitespaceVenueNoCity, null).venueKey, "city:unknown");
});

test("computeIdentity: identityKey is deterministic and bucketed by venue+date", () => {
  const a = computeIdentity("gigstix", ev({ externalId: "1" }), "v1");
  const b = computeIdentity("gigstix", ev({ externalId: "2", title: "Other" }), "v1");
  const c = computeIdentity("gigstix", ev({ externalId: "3", startLocal: "2026-11-01T22:00" }), "v1");
  assert.equal(a.identityKey, b.identityKey); // same venue + same date -> same bucket
  assert.notEqual(a.identityKey, c.identityKey); // different date -> different bucket
  assert.equal(a.localDate, "2026-10-30");
});

test("[regression] identityKey never collides across genuinely different (venueKey, localDate) pairs", () => {
  // computeNameNormalized's fallback (for a name with NO Latin/Cyrillic/digit
  // characters at all) leaves the raw string untouched, so venueKey CAN
  // contain "|". computeIdentity never validates startLocal's shape either,
  // so localDate (its first 10 characters) can be shorter than 10 chars for
  // a malformed startLocal. Combined, a naive "venueKey|localDate" join lets
  // two DIFFERENT events collide: venueKey="name:@|#"+localDate="Z" joins to
  // the SAME string as venueKey="name:@"+localDate="#|Z" ("name:@|#|Z").
  // identityKey must distinguish them regardless.
  const a = computeIdentity(
    "gigstix",
    ev({ externalId: "1", startLocal: "Z", venue: { name: "@|#" } }),
    null,
  );
  const b = computeIdentity(
    "gigstix",
    ev({ externalId: "2", startLocal: "#|Z", venue: { name: "@" } }),
    null,
  );
  // sanity: this pair really does produce the old collision's exact inputs
  assert.equal(a.venueKey, "name:@|#");
  assert.equal(b.venueKey, "name:@");
  assert.equal(a.localDate, "Z");
  assert.equal(b.localDate, "#|Z");
  assert.notEqual(a.identityKey, b.identityKey, "genuinely different events must not share an identityKey");
});
