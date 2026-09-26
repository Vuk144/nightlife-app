/**
 * Cross-source event comparison (`../../src/events/dedup.ts#compareEvents`).
 *
 * These `compareEvents` band tests moved here from `identity.test.ts` when the
 * two-event comparison was split out of the one-event identity module.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareEvents } from "../../src/events/dedup.ts";
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

// ---- REGRESSIONS -----------------------------------------------------

test("[regression] a club night crossing midnight with weak title overlap is 'probable', not wrongly 'separate'", () => {
  // 23:50 -> 00:15 the next calendar date is 25 minutes apart in real time —
  // `sameLocalDate` alone would call this a "different night".
  const a = ev({ title: "Kokorico Label Night", startLocal: "2026-10-30T23:50" });
  const b = ev({ externalId: "2", title: "Kokorico Label Showcase", startLocal: "2026-10-31T00:15" });
  const cmp = compareEvents(a, "v1", b, "v1");
  assert.equal(cmp.signals.sameLocalDate, false, "sanity: this pair DOES cross a calendar date");
  assert.equal(cmp.band, "probable");
});

test("[regression] a club night crossing midnight with no corroboration is 'ambiguous', not wrongly 'separate'", () => {
  const a = ev({ title: "Room One Opening", startLocal: "2026-10-30T23:50" });
  const b = ev({ externalId: "2", title: "Basement Session", startLocal: "2026-10-31T00:15" });
  const cmp = compareEvents(a, "v1", b, "v1");
  assert.equal(cmp.band, "ambiguous");
});

test("[regression] same calendar date but hours apart still counts as 'same night' for a weak signal (sameNight adds midnight tolerance, never narrows same-date)", () => {
  // Locks in that the midnight-crossing fix above is ADDITIVE: any pair on
  // the same calendar date must still qualify, however far apart in the day
  // — this exact scenario broke once during development of that fix, when
  // `sameLocalDate` was replaced by a 240-minute cutoff instead of widened by one.
  const a = ev({ title: "Alpha", startLocal: "2026-07-01T18:00", promoter: "Kokorico" });
  const b = ev({
    externalId: "2",
    title: "Totally Different",
    startLocal: "2026-07-01T23:30",
    promoter: "Kokorico",
  });
  const cmp = compareEvents(a, "v1", b, "v1");
  assert.equal(cmp.signals.sameLocalDate, true);
  assert.equal(cmp.band, "probable");
});

test("[regression] with unresolved venue ids, the SAME venue name in DIFFERENT cities is never sameVenue", () => {
  const a = ev({ title: "Friday Night", venue: { name: "Caffe Bar Corner", city: "Belgrade" } });
  const b = ev({
    externalId: "2",
    title: "Friday Night",
    venue: { name: "Caffe Bar Corner", city: "Novi Sad" },
  });
  const cmp = compareEvents(a, null, b, null);
  assert.equal(cmp.signals.sameVenue, false);
  assert.equal(cmp.band, "separate");
});

test("[regression] with unresolved venue ids, the same name in the SAME city still matches (no regression)", () => {
  const a = ev({ title: "Friday Night", venue: { name: "Caffe Bar Corner", city: "Belgrade" } });
  const b = ev({
    externalId: "2",
    title: "Friday Night",
    venue: { name: "Caffe Bar Corner", city: "Belgrade" },
  });
  const cmp = compareEvents(a, null, b, null);
  assert.equal(cmp.signals.sameVenue, true);
  assert.equal(cmp.band, "automatic");
});

test("[regression] with unresolved venue ids, a matching name but unstated city on either side is inconclusive, not a match", () => {
  const a = ev({ title: "Friday Night", venue: { name: "Caffe Bar Corner" } });
  const b = ev({
    externalId: "2",
    title: "Friday Night",
    venue: { name: "Caffe Bar Corner", city: "Belgrade" },
  });
  const cmp = compareEvents(a, null, b, null);
  assert.equal(cmp.signals.sameVenue, false);
});

test("[determinism] compareEvents is symmetric — swapping which event is 'a' and which is 'b' does not change the result", () => {
  const a = ev({ title: "Intercell with DVS1" });
  const b = ev({ externalId: "2", title: "Intercell with DVS1 (Belgrade)", startLocal: "2026-10-30T23:30" });
  const forward = compareEvents(a, "v1", b, "v1");
  const reverse = compareEvents(b, "v1", a, "v1");
  assert.deepEqual(forward, reverse);
});
