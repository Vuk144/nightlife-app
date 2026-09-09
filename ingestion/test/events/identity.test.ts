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

test("computeIdentity: identityKey is deterministic and bucketed by venue+date", () => {
  const a = computeIdentity("gigstix", ev({ externalId: "1" }), "v1");
  const b = computeIdentity("gigstix", ev({ externalId: "2", title: "Other" }), "v1");
  const c = computeIdentity("gigstix", ev({ externalId: "3", startLocal: "2026-11-01T22:00" }), "v1");
  assert.equal(a.identityKey, b.identityKey); // same venue + same date -> same bucket
  assert.notEqual(a.identityKey, c.identityKey); // different date -> different bucket
  assert.equal(a.localDate, "2026-10-30");
});
