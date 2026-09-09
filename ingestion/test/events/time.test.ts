import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localDatePart,
  localMinutesBetween,
  parseSerbianDateTime,
} from "../../src/events/time.ts";

test("parseSerbianDateTime: date + time, genitive month", () => {
  assert.deepEqual(parseSerbianDateTime("petak 30. oktobra 2026. 23.00"), {
    local: "2026-10-30T23:00",
    precision: "datetime",
  });
  assert.deepEqual(parseSerbianDateTime("subota 9. maja 2026. 10.00"), {
    local: "2026-05-09T10:00",
    precision: "datetime",
  });
  assert.deepEqual(parseSerbianDateTime("četvrtak 8. oktobra 2026. 20.00"), {
    local: "2026-10-08T20:00",
    precision: "datetime",
  });
});

test("parseSerbianDateTime: date only -> date precision, no invented time", () => {
  assert.deepEqual(parseSerbianDateTime("petak 30. oktobra 2026."), {
    local: "2026-10-30",
    precision: "date",
  });
  assert.deepEqual(parseSerbianDateTime("30. oktobra 2026"), {
    local: "2026-10-30",
    precision: "date",
  });
});

test("parseSerbianDateTime: accepts ':' separator and nominative months", () => {
  assert.deepEqual(parseSerbianDateTime("30. oktobar 2026. 21:30"), {
    local: "2026-10-30T21:30",
    precision: "datetime",
  });
  assert.equal(parseSerbianDateTime("1. mart 2027. 20.15")?.local, "2027-03-01T20:15");
});

test("parseSerbianDateTime: rejects nonsense / unknown month / impossible day", () => {
  assert.equal(parseSerbianDateTime(""), null);
  assert.equal(parseSerbianDateTime("uskoro"), null);
  assert.equal(parseSerbianDateTime("32. oktobra 2026."), null);
  assert.equal(parseSerbianDateTime("10. brumaire 2026."), null);
  assert.equal(parseSerbianDateTime("29. februara 2027."), null); // 2027 not a leap year
});

test("parseSerbianDateTime: out-of-range time falls back to date precision", () => {
  assert.deepEqual(parseSerbianDateTime("5. juna 2026. 25.00"), {
    local: "2026-06-05",
    precision: "date",
  });
});

test("localMinutesBetween: same-zone naive delta, null without a time", () => {
  assert.equal(localMinutesBetween("2026-10-30T23:00", "2026-10-31T00:30"), 90);
  assert.equal(localMinutesBetween("2026-10-30T23:00", "2026-10-30T23:00"), 0);
  assert.equal(localMinutesBetween("2026-10-30", "2026-10-30T23:00"), null);
});

// ── contract characterization (audit) ──────────────────────────────

test("parseSerbianDateTime: every real GIGS TIX 'Datum i vreme' / 'Traje do' string", () => {
  const cases: [string, string, "datetime" | "date"][] = [
    ["petak 30. oktobra 2026. 23.00", "2026-10-30T23:00", "datetime"],
    ["nedelja 15. novembra 2026. 18.00", "2026-11-15T18:00", "datetime"],
    ["ponedeljak 19. oktobra 2026. 20.00", "2026-10-19T20:00", "datetime"],
    ["subota 9. maja 2026. 10.00", "2026-05-09T10:00", "datetime"], // "Datum i vreme"
    ["nedelja 10. maja 2026. 19.00", "2026-05-10T19:00", "datetime"], // "Traje do"
  ];
  for (const [input, local, precision] of cases) {
    assert.deepEqual(parseSerbianDateTime(input), { local, precision }, input);
  }
});

test("parseSerbianDateTime: a recognizable date with an explicitly INVALID time -> date precision, never a failure", () => {
  // The docstring: null is ONLY for an unrecognizable day/month/year. A garbage
  // time must not poison a valid date — the event stays ingestible as a
  // date-precision event (locked so a future change can't silently drop it).
  for (const bad of ["25.00", "24.00", "23.99", "23.60", "00.99"]) {
    assert.deepEqual(
      parseSerbianDateTime(`petak 30. oktobra 2026. ${bad}`),
      { local: "2026-10-30", precision: "date" },
      bad,
    );
  }
});

test("parseSerbianDateTime: hour/minute boundaries that ARE valid", () => {
  assert.equal(parseSerbianDateTime("30. oktobra 2026. 00.00")?.local, "2026-10-30T00:00");
  assert.equal(parseSerbianDateTime("30. oktobra 2026. 23.59")?.local, "2026-10-30T23:59");
  assert.equal(parseSerbianDateTime("30. oktobra 2026. 9.05")?.local, "2026-10-30T09:05"); // 1-digit hour
});

test("parseSerbianDateTime: 'h' separator and optional 'u' before the time", () => {
  assert.equal(parseSerbianDateTime("30. oktobra 2026. 20h30")?.local, "2026-10-30T20:30");
  assert.equal(parseSerbianDateTime("30. oktobra 2026. u 20.00")?.local, "2026-10-30T20:00");
  assert.equal(parseSerbianDateTime("30. oktobra 2026. u20.00")?.local, "2026-10-30T20:00");
});

test("parseSerbianDateTime: leap-year Feb 29 succeeds; non-leap Feb 29 and Apr 31 are rejected", () => {
  assert.deepEqual(parseSerbianDateTime("29. februara 2028."), {
    local: "2028-02-29",
    precision: "date",
  });
  assert.equal(parseSerbianDateTime("29. februara 2029."), null);
  assert.equal(parseSerbianDateTime("31. aprila 2026."), null); // April has 30 days
});

test("parseSerbianDateTime: extra whitespace, no space after the day-dot, still parses", () => {
  assert.deepEqual(parseSerbianDateTime("  petak   30.oktobra   2026.   23.00  "), {
    local: "2026-10-30T23:00",
    precision: "datetime",
  });
});

test("parseSerbianDateTime: deterministic, no host-clock dependency, no input mutation", () => {
  const input = "petak 30. oktobra 2026. 23.00";
  assert.deepEqual(parseSerbianDateTime(input), parseSerbianDateTime(input));
  assert.equal(input, "petak 30. oktobra 2026. 23.00");
});

test("localDatePart: takes the YYYY-MM-DD prefix of every string parseSerbianDateTime produces", () => {
  assert.equal(localDatePart("2026-10-30T23:00"), "2026-10-30");
  assert.equal(localDatePart("2026-10-30"), "2026-10-30");
  assert.equal(localDatePart("2028-02-29"), "2028-02-29");
});

test("localMinutesBetween: date-only on either side -> null; crosses midnight correctly", () => {
  assert.equal(localMinutesBetween("2026-10-30T23:00", "2026-10-30"), null);
  assert.equal(localMinutesBetween("2026-10-30", "2026-10-31"), null);
  assert.equal(localMinutesBetween("2026-12-31T23:30", "2027-01-01T00:15"), 45);
});
