/**
 * Tests for the event-ingestion dry-run report formatter
 * (`../../src/events/report.ts#formatReport`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport } from "../../src/events/report.ts";
import type { DryRunItem, DryRunReport, DryRunStats } from "../../src/events/engine.ts";
import type { EventFirstAggregate } from "../../src/events/event-first.ts";
import { computeIdentity } from "../../src/events/identity.ts";
import type { NormalizedEvent } from "../../src/events/types.ts";

// ── fixture builders ────────────────────────────────────────────────
function stats(over: Partial<DryRunStats> = {}): DryRunStats {
  return {
    source: "gigstix",
    scope: { countries: ["RS"], cities: [] },
    discovered: 0,
    fetched: 0,
    fetchFailed: 0,
    parsed: 0,
    parseFailed: 0,
    accepted: 0,
    acceptedPrimary: 0,
    acceptedSecondary: 0,
    rejected: 0,
    processFailed: 0,
    rejectionReasons: {},
    parseFailureReasons: {},
    fetchFailureReasons: {},
    processFailureReasons: {},
    venuesNamed: 0,
    noVenueInSource: 0,
    venueResolution: {
      matchedExisting: 0,
      safeNewVenue: 0,
      needsReview: 0,
      rejected: 0,
      byTier: {},
      reasonCodes: {},
    },
    venueResolutionSkipped: false,
    plannedCanonicalInserts: 0,
    durationMs: 1234,
    status: "ok",
    notes: [],
    ...over,
  };
}

const emptyAggregate: EventFirstAggregate = {
  candidates: [],
  safeCount: 0,
  needsReviewCount: 0,
  capLimit: 10,
  capExceeded: false,
  demotedByCap: 0,
};

function event(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    externalId: "E1",
    sourceUrl: "https://new.gigstix.com/event/e1/",
    title: "Night",
    startLocal: "2026-07-01T22:00",
    startPrecision: "datetime",
    venue: { name: "Klub Foo", city: "Beograd" },
    reported: {},
    ...over,
  };
}

/** An `accepted` item that names ONLY a city — no resolved venue. */
function acceptedCityOnly(id: string, title: string): DryRunItem {
  const e = event({
    externalId: id,
    title,
    sourceUrl: `https://new.gigstix.com/event/${id}/`,
    venue: { name: "", city: "Beograd" },
  });
  return {
    url: e.sourceUrl,
    stage: "accepted",
    event: e,
    relevance: { accepted: true, tier: "primary", reason: 'category "koncert"' },
    identity: computeIdentity("gigstix", e, null),
  };
}

function report(over: Partial<DryRunReport> = {}): DryRunReport {
  return { stats: stats(), items: [], eventFirst: emptyAggregate, ...over };
}

// ── tests ──────────────────────────────────────────────────────────

test("[regression] the collision header does not claim 'same venue' for city-only events", () => {
  const items = [acceptedCityOnly("A", "Festival Alfa"), acceptedCityOnly("B", "Događaj Beta")];
  const out = formatReport(
    report({ items, stats: stats({ accepted: 2, acceptedPrimary: 2, noVenueInSource: 2, venueResolutionSkipped: true }) }),
    { verbose: false },
  );

  // the two city-only events DID land in one identity bucket
  assert.match(out, /city:beograd @ 2026-07-01/);
  assert.match(out, /- Festival Alfa/);
  assert.match(out, /- Događaj Beta/);

  // ...but they are NOT known to be at the same venue — the header must not say so
  assert.doesNotMatch(
    out,
    /Same venue \+ same date/,
    "header falsely asserts a shared venue for events that named only a city",
  );
  assert.match(out, /Same venue key \+ same date/);
});

test("collision section is omitted entirely when there are no buckets with >1 accepted event", () => {
  const out = formatReport(
    report({ items: [acceptedCityOnly("A", "Solo")], stats: stats({ accepted: 1, acceptedPrimary: 1 }) }),
    { verbose: true },
  );
  assert.doesNotMatch(out, /same date \(/);
});

test("skipped venue resolution prints SKIPPED and no resolution stats/candidates", () => {
  const out = formatReport(
    report({ stats: stats({ venueResolutionSkipped: true }) }),
    { verbose: true },
  );
  assert.match(out, /Event-first venue resolution: SKIPPED/);
  assert.doesNotMatch(out, /matched_existing:/);
  assert.doesNotMatch(out, /Event-first venue candidates/);
});

test("formatReport is deterministic — repeated calls with the same report are byte-identical", () => {
  const rep = report({
    items: [acceptedCityOnly("A", "One"), acceptedCityOnly("B", "Two")],
    stats: stats({
      accepted: 2,
      acceptedPrimary: 2,
      rejected: 3,
      rejectionReasons: { "no music or nightlife signal found": 2, 'category "sport"': 1 },
      fetchFailed: 2,
      fetchFailureReasons: { "HTTP 500": 1, "network/timeout": 1 },
    }),
  });
  const a = formatReport(rep, { verbose: true });
  const b = formatReport(rep, { verbose: true });
  assert.equal(a, b);
});

test("formatReport does not mutate the report (deep-frozen input)", () => {
  const items = [acceptedCityOnly("A", "One")];
  const rep = report({ items, stats: stats({ accepted: 1, acceptedPrimary: 1, notes: ["read-only run"] }) });
  const snapshot = JSON.stringify(rep);

  const freeze = (o: unknown): void => {
    if (o && typeof o === "object") {
      Object.freeze(o);
      for (const v of Object.values(o)) freeze(v);
    }
  };
  freeze(rep);

  assert.doesNotThrow(() => formatReport(rep, { verbose: true }));
  assert.doesNotThrow(() => formatReport(rep, { verbose: false }));
  assert.equal(JSON.stringify(rep), snapshot);
});

test("verbose vs non-verbose: the header counts are identical (only the detail differs)", () => {
  const rep = report({
    items: [
      { url: "u1", stage: "rejected", reason: "no signal", event: event({ externalId: "R1", title: "Rejected 1" }) },
      { url: "u2", stage: "fetch-failed", reason: "HTTP 500" },
      { url: "u3", stage: "parse-failed", reason: "missing-title" },
    ],
    stats: stats({
      discovered: 3,
      fetched: 2,
      fetchFailed: 1,
      fetchFailureReasons: { "HTTP 500": 1 },
      parsed: 1,
      parseFailed: 1,
      parseFailureReasons: { "missing-title": 1 },
      rejected: 1,
      rejectionReasons: { "no signal": 1 },
    }),
  });
  const quiet = formatReport(rep, { verbose: false });
  const loud = formatReport(rep, { verbose: true });

  for (const line of [
    "  Fetch failed: ",
    "  Parse failed: ",
    "  Rejected:     ",
  ]) {
    const q = quiet.split("\n").find((l) => l.startsWith(line));
    const v = loud.split("\n").find((l) => l.startsWith(line));
    assert.equal(q, v, `summary line "${line.trim()}" must be identical in both modes`);
  }
  // detail sections appear only in verbose
  assert.doesNotMatch(quiet, /Rejected events \(/);
  assert.match(loud, /Rejected events \(1\)/);
});
