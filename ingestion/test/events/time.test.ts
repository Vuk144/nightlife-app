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
