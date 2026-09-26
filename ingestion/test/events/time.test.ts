/**
 * Source-agnostic local wall-clock helpers (`../../src/events/time.ts`).
 *
 * Serbian date PARSING moved to `gigstix-datetime.test.ts` when the parser was
 * relocated next to its adapter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { localDatePart, localMinutesBetween } from "../../src/events/time.ts";

test("localMinutesBetween: same-zone naive delta, null without a time", () => {
  assert.equal(localMinutesBetween("2026-10-30T23:00", "2026-10-31T00:30"), 90);
  assert.equal(localMinutesBetween("2026-10-30T23:00", "2026-10-30T23:00"), 0);
  assert.equal(localMinutesBetween("2026-10-30", "2026-10-30T23:00"), null);
});

test("localDatePart: takes the YYYY-MM-DD prefix of a local wall-clock string", () => {
  assert.equal(localDatePart("2026-10-30T23:00"), "2026-10-30");
  assert.equal(localDatePart("2026-10-30"), "2026-10-30");
  assert.equal(localDatePart("2028-02-29"), "2028-02-29");
});

test("localMinutesBetween: date-only on either side -> null; crosses midnight correctly", () => {
  assert.equal(localMinutesBetween("2026-10-30T23:00", "2026-10-30"), null);
  assert.equal(localMinutesBetween("2026-10-30", "2026-10-31"), null);
  assert.equal(localMinutesBetween("2026-12-31T23:30", "2027-01-01T00:15"), 45);
});

test("[regression] localMinutesBetween: a calendar date/time that does not exist is rejected, never silently rolled into a real one", () => {
  // Feb 30 does not exist. `Date.parse` silently normalizes it to March 2nd,
  // which would otherwise make it compare as numerically IDENTICAL to a real
  // March 2nd event (delta 0) instead of being rejected as malformed.
  assert.equal(localMinutesBetween("2026-02-30T10:00", "2026-03-02T10:00"), null);
  // 2027 is not a leap year -> Feb 29 does not exist that year.
  assert.equal(localMinutesBetween("2027-02-29T10:00", "2027-02-29T10:00"), null);
  // 2028 IS a leap year -> Feb 29 is real and comparable normally.
  assert.equal(localMinutesBetween("2028-02-29T10:00", "2028-02-29T10:30"), 30);
  // hour 24 / minute 60 do not exist; `Date.parse` rolls them into the next
  // day/hour instead of rejecting them.
  assert.equal(localMinutesBetween("2026-10-30T24:00", "2026-10-31T00:00"), null);
  assert.equal(localMinutesBetween("2026-10-30T23:60", "2026-10-31T00:00"), null);
});

test("[regression] localMinutesBetween: only the exact 'YYYY-MM-DDTHH:MM' shape is accepted", () => {
  // Seconds are outside the documented `startLocal` contract; must not be
  // silently truncated/accepted rather than rejected.
  assert.equal(localMinutesBetween("2026-10-30T23:00:15", "2026-10-30T23:00"), null);
  assert.equal(localMinutesBetween("2026-10-30T23:00", "not-a-date-at-all!!"), null);
});
