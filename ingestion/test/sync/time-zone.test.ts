/**
 * `../../src/sync/time-zone.ts` — local wall-clock ↔ absolute instant.
 *
 * Focused unit coverage: the datetime regex, calendar validity, DST spring /
 * fall behaviour, process-timezone independence, explicit offsets, the
 * `eventInstantForComparison` ↔ `localToInstant` persistence parity, and
 * `normalizeTimeOfDay`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventInstantForComparison,
  localToInstant,
  normalizeTimeOfDay,
  toComparableInstant,
  toInstantMs,
} from "../../src/sync/time-zone.ts";

/** Run `fn` once per representative process timezone; restore TZ afterwards. */
function underEachProcessTz(fn: (tz: string) => void): void {
  const saved = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Tokyo", "America/New_York", "Pacific/Kiritimati", "Europe/Zagreb"]) {
      process.env.TZ = tz;
      fn(tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  1. THE DATETIME REGEX — normal inputs parse (regression for a stray "(")
// ════════════════════════════════════════════════════════════════════════

test("[regex] a plain local datetime + IANA zone resolves to the correct absolute instant", () => {
  assert.equal(localToInstant("2026-07-01T22:00", "Europe/Zagreb"), "2026-07-01T20:00:00.000Z");
});

test("[regex] the space separator ('YYYY-MM-DD HH:MM') is equivalent to 'T'", () => {
  assert.equal(
    localToInstant("2026-07-01 22:00", "Europe/Zagreb"),
    localToInstant("2026-07-01T22:00", "Europe/Zagreb"),
  );
  assert.equal(localToInstant("2026-07-01 22:00", "Europe/Zagreb"), "2026-07-01T20:00:00.000Z");
});

test("[regex] a bare date is LOCAL midnight for localToInstant()", () => {
  // 2026-07-01 00:00 in Europe/Zagreb (summer, UTC+2) == 2026-06-30T22:00Z
  assert.equal(localToInstant("2026-07-01", "Europe/Zagreb"), "2026-06-30T22:00:00.000Z");
  assert.equal(localToInstant("2026-01-01", "Europe/Zagreb"), "2025-12-31T23:00:00.000Z"); // winter, UTC+1
});

test("[regex] a bare date is UTC midnight for toInstantMs() (reconciliation's absolute-clock view)", () => {
  assert.equal(toInstantMs("2026-07-01", null), Date.UTC(2026, 6, 1, 0, 0, 0));
  assert.equal(toInstantMs("2026-07-01", "Europe/Zagreb"), Date.UTC(2026, 6, 1, 0, 0, 0));
});

test("[regex] date-only localToInstant vs toInstantMs is the documented distinction (local vs UTC midnight)", () => {
  assert.notEqual(
    localToInstant("2026-07-01", "Europe/Zagreb"),
    new Date(toInstantMs("2026-07-01", "Europe/Zagreb")!).toISOString(),
  );
});

test("[regex] seconds are parsed by toInstantMs()", () => {
  assert.equal(toInstantMs("2026-07-01T22:00:30", null), Date.UTC(2026, 6, 1, 22, 0, 30));
  assert.equal(toInstantMs("2026-12-31T23:59:59", null), Date.UTC(2026, 11, 31, 23, 59, 59));
});

test("[regex] explicit Z / ±HH:MM offsets resolve to their absolute instant", () => {
  const twentyZ = Date.UTC(2026, 6, 1, 20, 0, 0);
  assert.equal(toInstantMs("2026-07-01T20:00:00.000Z", null), twentyZ);
  assert.equal(toInstantMs("2026-07-01T20:00:00Z", null), twentyZ);
  assert.equal(toInstantMs("2026-07-01T22:00:00+02:00", null), twentyZ);
  assert.equal(toInstantMs("2026-07-01T15:00:00-05:00", null), twentyZ);
  assert.equal(toComparableInstant("2026-07-01T22:00:00+02:00", null), "2026-07-01T20:00:00.000Z");
});

test("[regex] unparseable input returns null (localToInstant / toInstantMs) or the raw string (toComparableInstant)", () => {
  assert.equal(localToInstant("not a date", "Europe/Zagreb"), null);
  assert.equal(localToInstant("", "Europe/Zagreb"), null);
  assert.equal(toInstantMs("garbage", null), null);
  assert.equal(toInstantMs(null, null), null);
  assert.equal(toInstantMs(undefined, null), null);
  assert.equal(toInstantMs("2026-07-01T20:00:00+99:99", null), null); // malformed offset
  assert.equal(toInstantMs("2026-07-01T20:00:00+25:00", null), null); // out-of-range offset
  assert.equal(toComparableInstant("total garbage", null), "total garbage");
  assert.equal(toComparableInstant("", null), null);
});

// ════════════════════════════════════════════════════════════════════════
//  2. CALENDAR VALIDITY — an impossible date must NOT roll into a real one
// ════════════════════════════════════════════════════════════════════════

const IMPOSSIBLE = [
  "2026-02-30", // Feb 30
  "2026-02-29", // 2026 is not a leap year
  "2026-13-01", // month 13
  "2026-00-15", // month 0
  "2026-07-32", // day 32
  "2026-07-00", // day 0
  "2026-04-31", // April has 30 days
];
const IMPOSSIBLE_DATETIME = [
  "2026-07-01T25:00", // hour 25
  "2026-07-01T22:99", // minute 99
  "2026-07-01T22:00:70", // second 70 (toInstantMs only — localToInstant has no seconds group)
];

for (const raw of IMPOSSIBLE) {
  test(`[calendar] localToInstant("${raw}") -> null (no silent roll to another real date)`, () => {
    assert.equal(localToInstant(raw, "Europe/Zagreb"), null);
  });
  test(`[calendar] toInstantMs("${raw}") -> null`, () => {
    assert.equal(toInstantMs(raw, null), null);
    assert.equal(toInstantMs(raw, "Europe/Zagreb"), null);
  });
}

for (const raw of IMPOSSIBLE_DATETIME) {
  test(`[calendar] toInstantMs("${raw}") -> null`, () => {
    assert.equal(toInstantMs(raw, null), null);
  });
}
test('[calendar] localToInstant rejects an impossible time-of-day ("25:00", "22:99")', () => {
  assert.equal(localToInstant("2026-07-01T25:00", "Europe/Zagreb"), null);
  assert.equal(localToInstant("2026-07-01T22:99", "Europe/Zagreb"), null);
});

test("[calendar] toInstantMs with an impossible date + a zone also returns null (delegates to localToInstant)", () => {
  assert.equal(toInstantMs("2026-02-30T12:00", "Europe/Zagreb"), null);
});

test("[calendar] genuinely valid calendar boundaries still resolve", () => {
  assert.ok(localToInstant("2026-02-28", "Europe/Zagreb"));
  assert.ok(localToInstant("2028-02-29", "Europe/Zagreb")); // 2028 IS a leap year
  assert.ok(localToInstant("2026-12-31T23:59", "UTC"));
  assert.ok(localToInstant("2026-01-01T00:00", "UTC"));
  assert.equal(toInstantMs("2028-02-29", null), Date.UTC(2028, 1, 29, 0, 0, 0));
});

test("[calendar] an impossible date flows through the comparable helpers as its RAW string (stable, not a wrong instant)", () => {
  assert.equal(toComparableInstant("2026-02-30", null), "2026-02-30");
  assert.equal(eventInstantForComparison("2026-02-30", "Europe/Zagreb"), "2026-02-30");
  // stability: re-deriving the same impossible value yields the same output
  assert.equal(
    eventInstantForComparison("2026-02-30", "Europe/Zagreb"),
    eventInstantForComparison("2026-02-30", "Europe/Zagreb"),
  );
});

// ════════════════════════════════════════════════════════════════════════
//  3. DST SPRING-FORWARD — nonexistent local wall-clock (characterization)
// ════════════════════════════════════════════════════════════════════════

test("[dst:spring] a nonexistent local time (EU clocks 02:00->03:00) resolves DETERMINISTICALLY", () => {
  // 2026-03-29: Europe/Zagreb springs forward at 02:00 local; 02:30 does not exist.
  const a = localToInstant("2026-03-29T02:30", "Europe/Zagreb");
  const b = localToInstant("2026-03-29T02:30", "Europe/Zagreb");
  assert.equal(a, b, "deterministic across calls");
  assert.equal(a, "2026-03-29T00:30:00.000Z", "current contract: the iterative resolver's fixed output");
  // a time safely before / after the gap is unaffected
  assert.equal(localToInstant("2026-03-29T01:30", "Europe/Zagreb"), "2026-03-29T00:30:00.000Z");
  assert.equal(localToInstant("2026-03-29T03:30", "Europe/Zagreb"), "2026-03-29T01:30:00.000Z");
});

// ════════════════════════════════════════════════════════════════════════
//  4. DST FALL-BACK — ambiguous local wall-clock (characterization)
// ════════════════════════════════════════════════════════════════════════

test("[dst:fall] an ambiguous local time (EU clocks 03:00->02:00) resolves DETERMINISTICALLY", () => {
  // 2026-10-25: Europe/Zagreb falls back at 03:00 local; 02:30 happens twice.
  const a = localToInstant("2026-10-25T02:30", "Europe/Zagreb");
  const b = localToInstant("2026-10-25T02:30", "Europe/Zagreb");
  assert.equal(a, b, "deterministic across calls");
  assert.equal(a, "2026-10-25T01:30:00.000Z", "current contract: the resolver settles on the later (post-transition) instant");
});

// ════════════════════════════════════════════════════════════════════════
//  5. PROCESS-TIMEZONE INDEPENDENCE
// ════════════════════════════════════════════════════════════════════════

test("[tz-independence] every function is identical regardless of process TZ", () => {
  const cases = [
    ["2026-07-01T22:00", "Europe/Zagreb"],
    ["2026-01-15T22:00", "Europe/Zagreb"],
    ["2026-07-01T22:00", "Pacific/Honolulu"],
    ["2026-07-01", "Europe/Zagreb"],
    ["2026-07-01T20:00:00+00:00", null],
    ["2026-07-01T20:00:00Z", null],
  ] as const;
  const baseline = cases.map(([l, z]) => ({
    lti: z ? localToInstant(l, z) : null,
    tim: toInstantMs(l, z),
    tci: toComparableInstant(l, z),
    eifc: eventInstantForComparison(l, z),
  }));
  underEachProcessTz((tz) => {
    cases.forEach(([l, z], i) => {
      assert.deepEqual(
        {
          lti: z ? localToInstant(l, z) : null,
          tim: toInstantMs(l, z),
          tci: toComparableInstant(l, z),
          eifc: eventInstantForComparison(l, z),
        },
        baseline[i],
        `TZ=${tz} :: ${l} / ${z}`,
      );
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
//  6. EXPLICIT-OFFSET TIMESTAMPS
// ════════════════════════════════════════════════════════════════════════

test("[offset] Z / +02:00 / -05:00 all resolve; malformed offsets do not silently become local", () => {
  const want = Date.UTC(2026, 6, 1, 20, 0, 0);
  assert.equal(toInstantMs("2026-07-01T20:00:00Z", null), want);
  assert.equal(toInstantMs("2026-07-01T22:00:00+02:00", null), want);
  assert.equal(toInstantMs("2026-07-01T15:00:00-05:00", null), want);
  assert.equal(toInstantMs("2026-07-01T20:00:00+00:00", null), want);
  assert.equal(toInstantMs("2026-07-01T20:00:00+0000", null), want); // colon-less
  assert.equal(toInstantMs("2026-07-01T20:00:00+99:99", null), null);
  assert.equal(toInstantMs("2026-07-01T20:00:00+25:00", null), null);
});

test("[offset] an offset-bearing string is NOT re-converted through a supplied zone", () => {
  assert.equal(
    eventInstantForComparison("2026-07-01T20:00:00+00:00", "Europe/Zagreb"),
    "2026-07-01T20:00:00.000Z",
  );
  assert.equal(toComparableInstant("2026-07-01T20:00:00Z", "Europe/Zagreb"), "2026-07-01T20:00:00.000Z");
});

// ════════════════════════════════════════════════════════════════════════
//  7. eventInstantForComparison() — persistence parity + absolute pass-through
// ════════════════════════════════════════════════════════════════════════

test("[parity] eventInstantForComparison(local, zone) === localToInstant(local, zone) for every zone-bearing local", () => {
  const cases: Array<[string, string]> = [
    ["2026-07-01T22:00", "Europe/Zagreb"], // summer
    ["2026-01-15T22:00", "Europe/Zagreb"], // winter
    ["2026-07-01T22:00", "Pacific/Honolulu"], // no-DST, UTC-10
    ["2026-07-01T22:00", "Asia/Kathmandu"], // +05:45
    ["2026-07-01", "Europe/Zagreb"], // bare date -> local midnight, both paths
    ["2026-03-29T02:30", "Europe/Zagreb"], // spring gap — still must agree
    ["2026-10-25T02:30", "Europe/Zagreb"], // fall ambiguity — still must agree
  ];
  for (const [l, z] of cases) {
    assert.equal(eventInstantForComparison(l, z), localToInstant(l, z), `${l} / ${z}`);
  }
});

test("[parity] an already-absolute timestamp stays absolute (localToInstant is NOT consulted)", () => {
  assert.equal(eventInstantForComparison("2026-07-01T20:00:00Z", null), "2026-07-01T20:00:00.000Z");
  assert.equal(eventInstantForComparison("2026-07-01T20:00:00+00:00", null), "2026-07-01T20:00:00.000Z");
  assert.equal(eventInstantForComparison("2026-07-01T15:00:00-05:00", null), "2026-07-01T20:00:00.000Z");
});

test("[parity] eventInstantForComparison keeps its documented split from toInstantMs for a bare date", () => {
  // change-detection / persistence view: LOCAL midnight
  assert.equal(eventInstantForComparison("2026-07-01", "Europe/Zagreb"), "2026-06-30T22:00:00.000Z");
  // reconciliation's absolute-clock view: UTC midnight
  assert.equal(toInstantMs("2026-07-01", "Europe/Zagreb"), Date.UTC(2026, 6, 1, 0, 0, 0));
});

test("[parity] a zone-less local with no zone is UTC for both eventInstantForComparison and toComparableInstant", () => {
  assert.equal(eventInstantForComparison("2026-07-01T22:00", null), "2026-07-01T22:00:00.000Z");
  assert.equal(toComparableInstant("2026-07-01T22:00", null), "2026-07-01T22:00:00.000Z");
});

// ════════════════════════════════════════════════════════════════════════
//  8. normalizeTimeOfDay()
// ════════════════════════════════════════════════════════════════════════

test("[time-of-day] valid HH:MM and HH:MM:SS normalise to zero-padded HH:MM", () => {
  assert.equal(normalizeTimeOfDay("04:00"), "04:00");
  assert.equal(normalizeTimeOfDay("4:00"), "04:00");
  assert.equal(normalizeTimeOfDay("04:00:00"), "04:00");
  assert.equal(normalizeTimeOfDay("23:59:59"), "23:59");
  assert.equal(normalizeTimeOfDay("09:30"), "09:30");
});

test("[time-of-day] null / undefined / empty / non-time strings -> null", () => {
  assert.equal(normalizeTimeOfDay(null), null);
  assert.equal(normalizeTimeOfDay(undefined), null);
  assert.equal(normalizeTimeOfDay(""), null);
  assert.equal(normalizeTimeOfDay("noon"), null);
  assert.equal(normalizeTimeOfDay("4:5"), null); // single-digit minute is not HH:MM
});

test("[time-of-day][characterization] it normalises FORMAT only — it does not range-check the clock", () => {
  // Deliberately unchanged: `normalizeTimeOfDay` is a format normaliser, not a
  // validator. A genuinely out-of-range value is caught downstream (Postgres
  // `time` rejects it and `apply` halts loudly).
  assert.equal(normalizeTimeOfDay("25:99"), "25:99");
});
