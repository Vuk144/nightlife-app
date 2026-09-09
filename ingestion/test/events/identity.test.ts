import { test } from "node:test";
import assert from "node:assert/strict";
import { compareEvents, computeIdentity } from "../../src/events/identity.ts";
import type { NormalizedEvent } from "../../src/events/types.ts";

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

test("compareEvents: different resolved venue -> separate (venue is a precondition)", () => {
  const cmp = compareEvents(ev(), "v1", ev({ title: "Some Night" }), "v2");
  assert.equal(cmp.band, "separate");
});

test("compareEvents: same venue + shared ticket id -> automatic", () => {
  const a = ev({ ticketUrl: "https://bilet.gigstix.com/rs/store/gigstix_v2/sectionGroup/index/9369" });
  const b = ev({
    externalId: "2",
    title: "DVS1 @ Drugstore",
    ticketUrl: "https://bilet.gigstix.com/rs/store/gigstix_v2/sectionGroup/index/9369",
  });
  assert.equal(compareEvents(a, "v1", b, "v1").band, "automatic");
});

test("compareEvents: same venue + same night + strong title overlap -> automatic", () => {
  const a = ev({ title: "Intercell with DVS1" });
  const b = ev({ externalId: "2", title: "Intercell with DVS1 (Belgrade)", startLocal: "2026-10-30T23:30" });
  assert.equal(compareEvents(a, "v1", b, "v1").band, "automatic");
});

test("compareEvents: same venue + same date but only weak title overlap -> probable (held, not merged)", () => {
  const a = ev({ title: "Kokorico Label Night", promoter: "Promoter A" });
  const b = ev({
    externalId: "2",
    title: "Kokorico Label Showcase",
    promoter: "Promoter B",
    startLocal: "2026-10-30",
  });
  const cmp = compareEvents(a, "v1", b, "v1");
  assert.equal(cmp.band, "probable");
});

test("compareEvents: same venue, clearly different nights -> separate", () => {
  const a = ev({ startLocal: "2026-10-30T23:00" });
  const b = ev({ externalId: "2", title: "Totally Different", startLocal: "2026-12-05T23:00" });
  assert.equal(compareEvents(a, "v1", b, "v1").band, "separate");
});

test("compareEvents: same venue + same night, no corroboration -> ambiguous (never auto-merged)", () => {
  const a = ev({ title: "Room One Opening" });
  const b = ev({ externalId: "2", title: "Basement Session", startLocal: "2026-10-30T23:45" });
  const cmp = compareEvents(a, "v1", b, "v1");
  assert.equal(cmp.band, "ambiguous");
});
