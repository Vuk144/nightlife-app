import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateEventFirstCandidates } from "../../src/events/event-first.ts";
import type { EventVenueResolution } from "../../src/events/venue-resolve.ts";

function resolution(o: Partial<EventVenueResolution>): EventVenueResolution {
  return {
    status: "safe_new_venue",
    reasonCode: "safe-new-venue",
    reason: "ok",
    reasonCodes: ["safe-new-venue"],
    proposedName: "Barutana BG",
    normalizedName: "barutana bg",
    city: "Belgrade",
    cityKnown: true,
    cityEnabled: true,
    address: "Beogradska tvrđava",
    latitude: 44.8238974,
    longitude: 20.4474708,
    coordinatesSource: "source",
    sourceVenueId: "barutana-bg",
    locationConfidence: "coordinates",
    matchedVenueId: null,
    matchTier: null,
    matchNote: null,
    eventRelevanceTier: "primary",
    provenance: {
      dataSource: "gigstix",
      externalVenueId: "4710",
      sourceUrl: "https://new.gigstix.com/event/a/",
      venuePageUrl: "https://new.gigstix.com/venue/barutana-bg/",
    },
    candidateKey: "svid:gigstix:barutana-bg",
    event: { title: "Event A", url: "https://new.gigstix.com/event/a/" },
    ...o,
  };
}

// ---- 10. duplicate event-first references to the same venue -------------
test("duplicate references to one venue collapse into a single candidate", () => {
  const agg = aggregateEventFirstCandidates(
    [
      resolution({ event: { title: "Party 1", url: "u1" } }),
      resolution({ event: { title: "Party 2", url: "u2" } }),
      resolution({ event: { title: "Party 3", url: "u3" } }),
    ],
    { maxNewVenues: 50 },
  );
  assert.equal(agg.candidates.length, 1);
  assert.equal(agg.candidates[0].eventCount, 3);
  assert.equal(agg.candidates[0].status, "safe_new_venue");
  assert.equal(agg.candidates[0].exampleEvents.length, 3);
});

test("different venue keys stay separate; never merged on coordinates alone", () => {
  const agg = aggregateEventFirstCandidates(
    [
      resolution({ candidateKey: "nc:Belgrade:club a", normalizedName: "club a", sourceVenueId: null }),
      resolution({
        candidateKey: "nc:Belgrade:club b",
        normalizedName: "club b",
        sourceVenueId: null,
        // identical coordinates — must NOT cause a merge
        latitude: 44.8238974,
        longitude: 20.4474708,
      }),
    ],
    { maxNewVenues: 50 },
  );
  assert.equal(agg.candidates.length, 2);
});

test("a needs_review contribution makes the whole candidate needs_review", () => {
  const agg = aggregateEventFirstCandidates(
    [
      resolution({ event: { title: "A", url: "u1" } }),
      resolution({
        status: "needs_review",
        reasonCodes: ["secondary-relevance-only"],
        event: { title: "B", url: "u2" },
      }),
    ],
    { maxNewVenues: 50 },
  );
  assert.equal(agg.candidates.length, 1);
  assert.equal(agg.candidates[0].status, "needs_review");
  assert.ok(agg.candidates[0].reasonCodes.includes("secondary-relevance-only"));
});

test("coordinate/address enrichment merges across contributions, never downgrades", () => {
  const agg = aggregateEventFirstCandidates(
    [
      resolution({
        latitude: null,
        longitude: null,
        coordinatesSource: null,
        locationConfidence: "address",
        event: { title: "A", url: "u1" },
      }),
      resolution({ event: { title: "B", url: "u2" } }), // has coordinates
    ],
    { maxNewVenues: 50 },
  );
  assert.equal(agg.candidates[0].locationConfidence, "coordinates");
  assert.equal(agg.candidates[0].latitude, 44.8238974);
});

// ---- 14. per-run safety cap ------------------------------------------
test("per-run cap: excess safe candidates are demoted to needs_review, not dropped", () => {
  const agg = aggregateEventFirstCandidates(
    [
      resolution({ candidateKey: "svid:gigstix:a", normalizedName: "a", sourceVenueId: "a" }),
      resolution({ candidateKey: "svid:gigstix:b", normalizedName: "b", sourceVenueId: "b" }),
      resolution({ candidateKey: "svid:gigstix:c", normalizedName: "c", sourceVenueId: "c" }),
      resolution({ candidateKey: "svid:gigstix:d", normalizedName: "d", sourceVenueId: "d" }),
    ],
    { maxNewVenues: 2 },
  );
  assert.equal(agg.candidates.length, 4, "no candidate is dropped");
  assert.equal(agg.safeCount, 2);
  assert.equal(agg.needsReviewCount, 2);
  assert.equal(agg.capExceeded, true);
  assert.equal(agg.demotedByCap, 2);
  const demoted = agg.candidates.filter((c) => c.reasonCodes.includes("over-per-run-cap"));
  assert.equal(demoted.length, 2);
  for (const c of demoted) assert.equal(c.status, "needs_review");
});

test("cap not exceeded when safe count is within the limit", () => {
  const agg = aggregateEventFirstCandidates(
    [
      resolution({ candidateKey: "svid:gigstix:a", sourceVenueId: "a" }),
      resolution({ candidateKey: "svid:gigstix:b", sourceVenueId: "b" }),
    ],
    { maxNewVenues: 5 },
  );
  assert.equal(agg.capExceeded, false);
  assert.equal(agg.safeCount, 2);
});

// ---- 15 & 16. no event-frequency requirement -----------------------
test("a candidate backed by a single event is still safe (frequency never filters)", () => {
  const agg = aggregateEventFirstCandidates(
    [resolution({ candidateKey: "svid:gigstix:solo", sourceVenueId: "solo" })],
    { maxNewVenues: 50 },
  );
  assert.equal(agg.candidates[0].eventCount, 1);
  assert.equal(agg.candidates[0].status, "safe_new_venue");
});

test("cap demotion is ordered by event count (busiest venues keep the safe slots)", () => {
  const agg = aggregateEventFirstCandidates(
    [
      // "busy" appears 3×, "quiet" once
      resolution({ candidateKey: "svid:gigstix:busy", sourceVenueId: "busy", event: { title: "b1", url: "u" } }),
      resolution({ candidateKey: "svid:gigstix:busy", sourceVenueId: "busy", event: { title: "b2", url: "u" } }),
      resolution({ candidateKey: "svid:gigstix:busy", sourceVenueId: "busy", event: { title: "b3", url: "u" } }),
      resolution({ candidateKey: "svid:gigstix:quiet", sourceVenueId: "quiet", normalizedName: "quiet" }),
    ],
    { maxNewVenues: 1 },
  );
  const safe = agg.candidates.filter((c) => c.status === "safe_new_venue");
  assert.equal(safe.length, 1);
  assert.equal(safe[0].sourceVenueId, "busy");
});

// ---- REGRESSIONS ---------------------------------------------------------

test("[determinism] full sort tie: candidate order + cap selection independent of input order", () => {
  // two DISTINCT venues (distinct source venue ids) that happen to share
  // eventCount (1), city and normalizedName — only candidateKey separates them.
  const a = resolution({ candidateKey: "svid:gigstix:aaa", sourceVenueId: "aaa", event: { title: "A", url: "ua" } });
  const b = resolution({ candidateKey: "svid:gigstix:bbb", sourceVenueId: "bbb", event: { title: "B", url: "ub" } });

  const forward = aggregateEventFirstCandidates([a, b], { maxNewVenues: 1 });
  const reverse = aggregateEventFirstCandidates([b, a], { maxNewVenues: 1 });

  assert.deepEqual(
    forward.candidates.map((c) => c.candidateKey),
    reverse.candidates.map((c) => c.candidateKey),
    "candidate ordering must not depend on input order",
  );
  assert.equal(
    forward.candidates.find((c) => c.status === "safe_new_venue")!.candidateKey,
    reverse.candidates.find((c) => c.status === "safe_new_venue")!.candidateKey,
    "the cap must keep the SAME candidate safe regardless of input order",
  );
  assert.equal(forward.candidates[0].candidateKey, "svid:gigstix:aaa");
});

test("[coords] a half-populated lat/lon pair never becomes candidate coordinates (init)", () => {
  const agg = aggregateEventFirstCandidates(
    [resolution({ latitude: 44.8, longitude: null, coordinatesSource: null, locationConfidence: "address" })],
    { maxNewVenues: 50 },
  );
  const c = agg.candidates[0];
  assert.equal(c.latitude, null);
  assert.equal(c.longitude, null);
  assert.equal(c.coordinatesSource, null);
});

test("[coords] a later half-pair is not adopted via merge", () => {
  const agg = aggregateEventFirstCandidates(
    [
      resolution({ latitude: null, longitude: null, coordinatesSource: null, locationConfidence: "address", event: { title: "A", url: "u1" } }),
      resolution({ latitude: 45.1, longitude: null, coordinatesSource: null, locationConfidence: "address", event: { title: "B", url: "u2" } }),
    ],
    { maxNewVenues: 50 },
  );
  assert.equal(agg.candidates[0].latitude, null);
  assert.equal(agg.candidates[0].longitude, null);
});

test("[provenance] nested provenance stays consistent with merged fields and is not aliased to input", () => {
  const first = resolution({
    provenance: { dataSource: "gigstix", externalVenueId: null, sourceUrl: "https://g/e1/", venuePageUrl: null },
    event: { title: "A", url: "u1" },
  });
  const later = resolution({
    provenance: { dataSource: "gigstix", externalVenueId: "4710", sourceUrl: "https://g/e2/", venuePageUrl: "https://g/venue/x/" },
    event: { title: "B", url: "u2" },
  });
  const c = aggregateEventFirstCandidates([first, later], { maxNewVenues: 50 }).candidates[0];

  assert.equal(c.venuePageUrl, "https://g/venue/x/");
  assert.equal(c.provenance.venuePageUrl, "https://g/venue/x/", "nested provenance must match the merged top-level field");
  assert.equal(c.provenance.externalVenueId, "4710", "a later non-null externalVenueId is merged conservatively");

  assert.notEqual(c.provenance, first.provenance, "output must not alias the caller's provenance object");
  c.provenance.dataSource = "MUTATED";
  assert.equal(first.provenance.dataSource, "gigstix");
});

test("[mutation-safety] frozen input resolutions (nested provenance/event/reasonCodes) are never mutated", () => {
  const mk = (o: Partial<EventVenueResolution>) => {
    const r = resolution(o);
    Object.freeze(r.provenance);
    Object.freeze(r.event);
    Object.freeze(r.reasonCodes);
    return Object.freeze(r);
  };
  const input = [
    mk({ candidateKey: "svid:gigstix:a", sourceVenueId: "a", event: { title: "A", url: "u1" } }),
    mk({
      candidateKey: "svid:gigstix:a",
      sourceVenueId: "a",
      status: "needs_review",
      reasonCodes: ["secondary-relevance-only"],
      event: { title: "B", url: "u2" },
    }),
  ];
  const snapshot = JSON.stringify(input);

  assert.doesNotThrow(() => aggregateEventFirstCandidates(input, { maxNewVenues: 0 }));
  const agg = aggregateEventFirstCandidates(input, { maxNewVenues: 0 });

  assert.equal(JSON.stringify(input), snapshot, "caller-owned resolutions are untouched");
  assert.notEqual(agg.candidates[0].provenance, input[0].provenance);
  assert.notEqual(agg.candidates[0].exampleEvents[0], input[0].event);
});

// ---- REGRESSIONS: order-independence of the merged aggregate -------------

test("[determinism] reasonCodes is a canonically-sorted union regardless of input order", () => {
  const rs = [
    resolution({ reasonCodes: ["safe-new-venue"], event: { title: "A", url: "u1" } }),
    resolution({
      status: "needs_review",
      reasonCodes: ["secondary-relevance-only", "generic-venue-name"],
      event: { title: "B", url: "u2" },
    }),
    resolution({ status: "needs_review", reasonCodes: ["city-not-enabled"], event: { title: "C", url: "u3" } }),
  ];
  const fwd = aggregateEventFirstCandidates(rs, { maxNewVenues: 50 }).candidates[0].reasonCodes;
  const rev = aggregateEventFirstCandidates([...rs].reverse(), { maxNewVenues: 50 }).candidates[0].reasonCodes;

  assert.deepEqual(fwd, rev);
  assert.deepEqual(fwd, [...fwd].sort(), "reasonCodes must be canonically sorted");
  assert.deepEqual(fwd, [
    "city-not-enabled",
    "generic-venue-name",
    "safe-new-venue",
    "secondary-relevance-only",
  ]);
});

test("[determinism] exampleEvents selects the SAME <=5 examples for forward/reverse input", () => {
  const rs = Array.from({ length: 7 }, (_, i) =>
    resolution({ event: { title: `E${i}`, url: `https://x/${i}` } }),
  );
  const fwd = aggregateEventFirstCandidates(rs, { maxNewVenues: 50 }).candidates[0];
  const rev = aggregateEventFirstCandidates([...rs].reverse(), { maxNewVenues: 50 }).candidates[0];

  assert.equal(fwd.eventCount, 7);
  assert.equal(fwd.exampleEvents.length, 5, "still capped at 5");
  assert.deepEqual(fwd.exampleEvents, rev.exampleEvents);
  assert.deepEqual(
    fwd.exampleEvents.map((e) => e.url),
    ["https://x/0", "https://x/1", "https://x/2", "https://x/3", "https://x/4"],
  );
});

test("[determinism] the whole aggregate is identical for forward vs reverse input", () => {
  const key = { candidateKey: "svid:gigstix:x", sourceVenueId: "x", normalizedName: "klub x", proposedName: "Klub X" };
  const x1 = resolution({
    ...key,
    address: "Addr One", latitude: null, longitude: null, coordinatesSource: null, locationConfidence: "address",
    reasonCodes: ["safe-new-venue"], event: { title: "x1", url: "u3" },
    provenance: { dataSource: "gigstix", externalVenueId: "x", sourceUrl: "u3", venuePageUrl: null },
  });
  const x2 = resolution({
    ...key,
    address: null, latitude: 44.8, longitude: 20.4, coordinatesSource: "source", locationConfidence: "coordinates",
    reasonCodes: ["safe-new-venue"], event: { title: "x2", url: "u1" },
    provenance: { dataSource: "gigstix", externalVenueId: "x", sourceUrl: "u1", venuePageUrl: "https://v/x/" },
  });
  const x3 = resolution({
    ...key, status: "needs_review",
    address: "Addr Two", latitude: 44.9, longitude: 20.5, coordinatesSource: "source", locationConfidence: "coordinates",
    reasonCodes: ["secondary-relevance-only"], event: { title: "x3", url: "u2" },
    provenance: { dataSource: "gigstix", externalVenueId: "x", sourceUrl: "u2", venuePageUrl: "https://v/x/" },
  });
  const y = resolution({
    candidateKey: "svid:gigstix:y", sourceVenueId: "y", normalizedName: "venue y", proposedName: "Venue Y",
    event: { title: "y1", url: "u0" },
  });

  const forward = aggregateEventFirstCandidates([x1, x2, x3, y], { maxNewVenues: 50 });
  const reverse = aggregateEventFirstCandidates([y, x3, x2, x1], { maxNewVenues: 50 });

  assert.deepEqual(forward, reverse);

  const cx = forward.candidates.find((c) => c.candidateKey === "svid:gigstix:x")!;
  assert.equal(forward.candidates[0].candidateKey, "svid:gigstix:x", "more events -> sorted first");
  assert.equal(cx.status, "needs_review");
  assert.equal(cx.eventCount, 3);
  assert.equal(cx.address, "Addr Two", "first non-null address in (url,title) order");
  assert.equal(cx.latitude, 44.8, "first complete coordinate pair in (url,title) order");
  assert.equal(cx.provenance.sourceUrl, "u1");
  assert.deepEqual(cx.exampleEvents.map((e) => e.url), ["u1", "u2", "u3"]);
  assert.deepEqual(cx.reasonCodes, ["safe-new-venue", "secondary-relevance-only"]);
});

test("[conflict] differing venue name for one source venue id -> needs_review (order-independent)", () => {
  const a = resolution({ candidateKey: "svid:gigstix:z", sourceVenueId: "z", normalizedName: "barutana", proposedName: "Barutana", event: { title: "A", url: "u1" } });
  const b = resolution({ candidateKey: "svid:gigstix:z", sourceVenueId: "z", normalizedName: "barutana bg", proposedName: "Barutana BG", event: { title: "B", url: "u2" } });

  for (const input of [[a, b], [b, a]]) {
    const c = aggregateEventFirstCandidates(input, { maxNewVenues: 50 }).candidates[0];
    assert.equal(c.status, "needs_review", "a substantive name disagreement is never auto-safe");
    assert.ok(c.reasonCodes.includes("conflicting-venue-name-across-events"));
    assert.equal(c.normalizedName, "barutana", "deterministic-first name kept, conflict surfaced");
  }
});

test("[conflict] differing city for one source venue id -> needs_review (order-independent)", () => {
  const a = resolution({ candidateKey: "svid:gigstix:w", sourceVenueId: "w", city: "Belgrade", cityEnabled: true, event: { title: "A", url: "u1" } });
  const b = resolution({ candidateKey: "svid:gigstix:w", sourceVenueId: "w", city: "Novi Sad", cityEnabled: false, event: { title: "B", url: "u2" } });

  for (const input of [[a, b], [b, a]]) {
    const c = aggregateEventFirstCandidates(input, { maxNewVenues: 50 }).candidates[0];
    assert.equal(c.status, "needs_review");
    assert.ok(c.reasonCodes.includes("conflicting-city-across-events"));
    assert.equal(c.city, "Belgrade");
  }
});

test("[merge] a null city is backfilled from a later contribution (never keep null over a real value)", () => {
  const noCity = resolution({
    candidateKey: "svid:gigstix:q", sourceVenueId: "q", city: null, cityEnabled: false,
    status: "needs_review", reasonCodes: ["city-unknown"], event: { title: "A", url: "u1" },
  });
  const withCity = resolution({
    candidateKey: "svid:gigstix:q", sourceVenueId: "q", city: "Belgrade", cityEnabled: true,
    event: { title: "B", url: "u2" },
  });

  for (const input of [[noCity, withCity], [withCity, noCity]]) {
    const c = aggregateEventFirstCandidates(input, { maxNewVenues: 50 }).candidates[0];
    assert.equal(c.city, "Belgrade");
    assert.equal(c.cityEnabled, true);
    assert.ok(!c.reasonCodes.includes("conflicting-city-across-events"), "null -> value is not a conflict");
  }
});
