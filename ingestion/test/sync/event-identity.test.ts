/**
 * `../../src/sync/event-identity.ts#resolveEventIdentity`.
 *
 * Focus: the Tier-2 decision must be a pure function of the candidate SET, not
 * its order — a unique automatic match is `matched`, anything less is
 * `ambiguous` with `canonicalId: null`, an empty/clean field is `new_candidate`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEventIdentity } from "../../src/sync/event-identity.ts";
import type {
  CanonicalEventForMatch,
  EventIdentityInput,
  EventIdentityRequest,
} from "../../src/sync/event-identity.ts";

const VENUE = "v-1";

function incoming(over: Partial<EventIdentityInput> = {}): EventIdentityInput {
  return {
    source: { sourceKey: "src-b", externalId: "b-1", sourceUrl: null },
    title: "Boris Brejcha",
    startLocal: "2026-07-01T22:00",
    ticketUrl: null,
    promoter: null,
    lineup: [],
    venueName: "Tvornica",
    ...over,
  };
}

function cand(over: Partial<CanonicalEventForMatch>): CanonicalEventForMatch {
  return {
    id: "ev-x",
    venueId: VENUE,
    title: "Boris Brejcha",
    startLocal: "2026-07-01T22:00",
    ticketUrl: null,
    promoter: null,
    ...over,
  };
}

function req(over: Partial<EventIdentityRequest>): EventIdentityRequest {
  return {
    incoming: incoming(),
    resolvedVenueId: VENUE,
    existingBySource: null,
    existingLink: null,
    candidates: [],
    ...over,
  };
}

/** Every permutation of a small array (for order-independence proofs). */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

// ── tier 0 / 1 short-circuit ───────────────────────────────────────
test("tier 0: an existing (source, external id) match wins immediately", () => {
  const r = resolveEventIdentity(req({ existingBySource: { canonicalId: "ev-0" } }));
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 0);
  assert.equal(r.canonicalId, "ev-0");
});

test("tier 1: an existing source-link row wins over the candidate pool", () => {
  const r = resolveEventIdentity(
    req({
      existingLink: { canonicalId: "ev-1" },
      candidates: [cand({ id: "ev-other", ticketUrl: "https://t.example/event/9" })],
      incoming: incoming({ ticketUrl: "https://t.example/event/9" }),
    }),
  );
  assert.equal(r.tier, 1);
  assert.equal(r.canonicalId, "ev-1");
});

// ── tier 2: exactly one automatic candidate -> matched ─────────────
test("exactly one automatic candidate (shared ticket id) -> matched at tier 2", () => {
  const ticket = "https://tix.example/event/12345";
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ ticketUrl: ticket }),
      candidates: [
        cand({ id: "ev-A", ticketUrl: ticket }),
        cand({ id: "ev-sep", startLocal: "2026-09-15T22:00", title: "Unrelated" }), // separate
      ],
    }),
  );
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 2);
  assert.equal(r.canonicalId, "ev-A");
});

test("one automatic + one weaker candidate -> still matched (the automatic is definitive)", () => {
  const ticket = "https://tix.example/event/777";
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ title: "Kokorico Label Night", ticketUrl: ticket }),
      candidates: [
        cand({ id: "ev-auto", ticketUrl: ticket, title: "Something Else" }),
        cand({ id: "ev-weak", title: "Kokorico Label Showcase" }), // probable (jaccard ~0.5)
      ],
    }),
  );
  assert.equal(r.decision, "matched");
  assert.equal(r.canonicalId, "ev-auto");
});

// ── tier 2: NOT a unique automatic -> ambiguous, canonicalId null ──
test("two automatic candidates -> ambiguous, canonicalId is null (never guess)", () => {
  const ticket = "https://tix.example/event/12345";
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ ticketUrl: ticket }),
      candidates: [cand({ id: "ev-A", ticketUrl: ticket }), cand({ id: "ev-B", ticketUrl: ticket })],
    }),
  );
  assert.equal(r.decision, "ambiguous");
  assert.equal(r.canonicalId, null);
  assert.equal(r.tier, null);
});

test("no automatic + one 'probable' candidate -> ambiguous, canonicalId null", () => {
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ title: "Kokorico Label Night" }),
      candidates: [cand({ id: "ev-weak", title: "Kokorico Label Showcase" })],
    }),
  );
  assert.equal(r.decision, "ambiguous");
  assert.equal(r.canonicalId, null);
});

test("no automatic + one 'ambiguous-band' candidate -> ambiguous, canonicalId null", () => {
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ title: "Room One Opening", startLocal: "2026-07-01T23:00" }),
      candidates: [cand({ id: "ev-amb", title: "Basement Session", startLocal: "2026-07-01T23:45" })],
    }),
  );
  assert.equal(r.decision, "ambiguous");
  assert.equal(r.canonicalId, null);
});

// ── new_candidate ─────────────────────────────────────────────────
test("no candidates at the venue -> new_candidate, canonicalId null", () => {
  const r = resolveEventIdentity(req({ candidates: [] }));
  assert.equal(r.decision, "new_candidate");
  assert.equal(r.tier, 3);
  assert.equal(r.canonicalId, null);
});

test("only 'separate' candidates (different nights) -> new_candidate", () => {
  const r = resolveEventIdentity(
    req({
      candidates: [
        cand({ id: "ev-1", startLocal: "2026-09-01T22:00", title: "Other A" }),
        cand({ id: "ev-2", startLocal: "2026-05-01T22:00", title: "Other B" }),
      ],
    }),
  );
  assert.equal(r.decision, "new_candidate");
  assert.equal(r.canonicalId, null);
});

test("a candidate at a DIFFERENT venue is ignored entirely", () => {
  const ticket = "https://tix.example/event/12345";
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ ticketUrl: ticket }),
      candidates: [cand({ id: "ev-elsewhere", venueId: "v-2", ticketUrl: ticket })],
    }),
  );
  assert.equal(r.decision, "new_candidate");
});

// ── ORDERING INDEPENDENCE (the core regression) ──────────────────
test("candidate ORDER cannot flip a unique automatic match to ambiguous (or vice versa)", () => {
  const ticket = "https://tix.example/event/12345";
  const pool: CanonicalEventForMatch[] = [
    cand({ id: "ev-auto", ticketUrl: ticket }), // automatic (shared ticket)
    cand({ id: "ev-weak", title: "Boris Brejcha Fan Meetup" }), // jaccard ~0.5 -> probable
    cand({ id: "ev-sep", startLocal: "2026-09-01T22:00", title: "Nope" }), // separate
  ];
  for (const order of permutations(pool)) {
    const r = resolveEventIdentity(req({ incoming: incoming({ ticketUrl: ticket }), candidates: order }));
    assert.equal(r.decision, "matched", JSON.stringify(order.map((c) => c.id)));
    assert.equal(r.canonicalId, "ev-auto");
  }
});

test("candidate ORDER cannot change WHICH id a unique automatic match returns", () => {
  const t1 = "https://tix.example/event/111";
  const pool: CanonicalEventForMatch[] = [
    cand({ id: "ev-hit", ticketUrl: t1 }),
    cand({ id: "ev-a", startLocal: "2026-09-01T22:00", title: "A" }),
    cand({ id: "ev-b", startLocal: "2026-05-01T22:00", title: "B" }),
  ];
  for (const order of permutations(pool)) {
    const r = resolveEventIdentity(req({ incoming: incoming({ ticketUrl: t1 }), candidates: order }));
    assert.equal(r.canonicalId, "ev-hit");
  }
});

test("candidate ORDER cannot change an ambiguous (2+ automatic) verdict, and id stays null", () => {
  const ticket = "https://tix.example/event/999";
  const pool: CanonicalEventForMatch[] = [
    cand({ id: "ev-A", ticketUrl: ticket }),
    cand({ id: "ev-B", ticketUrl: ticket }),
    cand({ id: "ev-weak", title: "Boris Brejcha Afterparty" }),
  ];
  for (const order of permutations(pool)) {
    const r = resolveEventIdentity(req({ incoming: incoming({ ticketUrl: ticket }), candidates: order }));
    assert.equal(r.decision, "ambiguous", JSON.stringify(order.map((c) => c.id)));
    assert.equal(r.canonicalId, null);
  }
});

test("candidate ORDER cannot change a weak-only ambiguous verdict", () => {
  const pool: CanonicalEventForMatch[] = [
    cand({ id: "ev-w1", title: "Kokorico Label Showcase" }), // probable
    cand({ id: "ev-w2", title: "Room Session", startLocal: "2026-07-01T23:30" }), // ambiguous band
    cand({ id: "ev-sep", startLocal: "2026-09-01T22:00", title: "Different" }), // separate
  ];
  for (const order of permutations(pool)) {
    const r = resolveEventIdentity(
      req({ incoming: incoming({ title: "Kokorico Label Night" }), candidates: order }),
    );
    assert.equal(r.decision, "ambiguous", JSON.stringify(order.map((c) => c.id)));
    assert.equal(r.canonicalId, null);
  }
});

// ── ambiguity never yields a canonicalId (point 3) ───────────────
test("EVERY ambiguous result has canonicalId === null", () => {
  const ticket = "https://tix.example/event/12345";
  const ambiguousReqs: EventIdentityRequest[] = [
    req({
      incoming: incoming({ ticketUrl: ticket }),
      candidates: [cand({ id: "a", ticketUrl: ticket }), cand({ id: "b", ticketUrl: ticket })],
    }),
    req({
      incoming: incoming({ title: "Kokorico Label Night" }),
      candidates: [cand({ id: "p", title: "Kokorico Label Showcase" })],
    }),
    req({
      incoming: incoming({ title: "Room One Opening", startLocal: "2026-07-01T23:00" }),
      candidates: [cand({ id: "am", title: "Basement Session", startLocal: "2026-07-01T23:40" })],
    }),
  ];
  for (const r of ambiguousReqs) {
    const out = resolveEventIdentity(r);
    assert.equal(out.decision, "ambiguous");
    assert.equal(out.canonicalId, null, "ambiguous must never look like an update instruction");
  }
});

// ── lineup carried but not consulted (point 5) ──────────────────
test("lineup on the input never changes the identity decision (compareEvents ignores it)", () => {
  const ticket = "https://tix.example/event/12345";
  const withLineup = resolveEventIdentity(
    req({
      incoming: incoming({ ticketUrl: ticket, lineup: ["DJ A", "DJ B", "DJ C"] }),
      candidates: [cand({ id: "ev-A", ticketUrl: ticket })],
    }),
  );
  const withoutLineup = resolveEventIdentity(
    req({
      incoming: incoming({ ticketUrl: ticket, lineup: [] }),
      candidates: [cand({ id: "ev-A", ticketUrl: ticket })],
    }),
  );
  assert.deepEqual(withLineup, withoutLineup);
});

test("resolvedVenueId === null skips the candidate pass entirely -> new_candidate", () => {
  const ticket = "https://tix.example/event/12345";
  const r = resolveEventIdentity(
    req({
      resolvedVenueId: null,
      incoming: incoming({ ticketUrl: ticket }),
      candidates: [cand({ id: "ev-A", ticketUrl: ticket })],
    }),
  );
  assert.equal(r.decision, "new_candidate");
});

// ── tier precedence: 0 > 1 > 2 > 3 (point 1) ─────────────────────
test("tier 0 outranks tier 1 — a conflicting source-link is NOT consulted", () => {
  // Both signals present, DIFFERENT canonical ids. Tier 0 wins silently; the
  // function never tries to reconcile the two (that is a store-consistency
  // problem upstream, not this decision's job).
  const r = resolveEventIdentity(
    req({
      existingBySource: { canonicalId: "ev-by-source" },
      existingLink: { canonicalId: "ev-by-link" },
    }),
  );
  assert.equal(r.tier, 0);
  assert.equal(r.canonicalId, "ev-by-source");
});

test("tier 1 outranks the candidate pool even when a candidate would match automatically", () => {
  const r = resolveEventIdentity(
    req({
      existingLink: { canonicalId: "ev-linked" },
      candidates: [cand({ id: "ev-auto" })], // identical title+night -> would be automatic
    }),
  );
  assert.equal(r.tier, 1);
  assert.equal(r.canonicalId, "ev-linked");
});

// ── canonical id passthrough — no validation here (point 9) ──────
test("tier 0/1 return the supplied canonicalId verbatim, including a falsy one", () => {
  // Contract: the id's validity is the caller's responsibility. The store's
  // apply step is what tolerates a falsy target id; this function must not
  // silently rewrite or drop what it was handed.
  const s = resolveEventIdentity(req({ existingBySource: { canonicalId: "" } }));
  assert.equal(s.decision, "matched");
  assert.equal(s.canonicalId, "");
  const l = resolveEventIdentity(req({ existingLink: { canonicalId: "  ev weird  " } }));
  assert.equal(l.canonicalId, "  ev weird  ");
});

// ── plain identical event -> automatic tier 2 (no ticket needed) ──
test("a single candidate with identical title + same night -> matched at tier 2", () => {
  const r = resolveEventIdentity(req({ candidates: [cand({ id: "ev-same" })] }));
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 2);
  assert.equal(r.canonicalId, "ev-same");
});

// ── startPrecision is inert (point 6) ───────────────────────────
test("startPrecision (date vs datetime) never enters the decision — only localDatePart / delta do", () => {
  // incoming is a bare date; candidate is a datetime on the SAME calendar day.
  // shim() classifies them as "date" vs "datetime" but compareEvents reads
  // neither — same local date + strong title overlap is still automatic.
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ startLocal: "2026-07-01" }),
      candidates: [cand({ id: "ev-dt", startLocal: "2026-07-01T22:00" })],
    }),
  );
  assert.equal(r.decision, "matched");
  assert.equal(r.canonicalId, "ev-dt");

  // Different calendar day -> separate regardless of precision.
  const sep = resolveEventIdentity(
    req({
      incoming: incoming({ startLocal: "2026-07-01" }),
      candidates: [cand({ id: "ev-x", startLocal: "2026-07-02T22:00" })],
    }),
  );
  assert.equal(sep.decision, "new_candidate");
});

// ── ticketUrl / promoter normalization through the shim (point 7) ─
test('ticketUrl "" and null are indistinguishable to the decision', () => {
  const mk = (t: string | null) =>
    resolveEventIdentity(
      req({
        incoming: incoming({ title: "Alpha", startLocal: "2026-07-01T20:00", ticketUrl: t }),
        candidates: [
          cand({ id: "c", title: "Omega", startLocal: "2026-07-01T23:45", ticketUrl: t }),
        ],
      }),
    );
  assert.deepEqual(mk(""), mk(null));
});

test("a ticketUrl with no extractable /event/<id> creates no shared-ticket identity", () => {
  const url = "https://shop.example/checkout";
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ title: "Alpha", startLocal: "2026-07-01T20:00", ticketUrl: url }),
      candidates: [
        cand({ id: "c", title: "Omega", startLocal: "2026-07-01T20:10", ticketUrl: url }),
      ],
    }),
  );
  // identical unparseable url on both sides -> NOT automatic; close+sameday+no
  // signal falls through to the ambiguous band -> held, never merged.
  assert.notEqual(r.canonicalId, "c");
  assert.equal(r.decision, "ambiguous");
});

test('promoter "" and null are indistinguishable to the decision', () => {
  const mk = (p: string | null) =>
    resolveEventIdentity(
      req({
        incoming: incoming({ title: "Alpha", startLocal: "2026-07-01T20:00", promoter: p }),
        candidates: [
          cand({ id: "c", title: "Omega", startLocal: "2026-07-01T23:45", promoter: p }),
        ],
      }),
    );
  assert.deepEqual(mk(""), mk(null));
});

test("promoter match is a STRONG signal when close in time -> automatic", () => {
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ title: "Alpha", startLocal: "2026-07-01T22:00", promoter: "Kokorico" }),
      candidates: [
        cand({ id: "c", title: "Totally Different", startLocal: "2026-07-01T22:15", promoter: "Kokorico" }),
      ],
    }),
  );
  assert.equal(r.decision, "matched");
  assert.equal(r.canonicalId, "c");
});

test("promoter match is only WEAK corroboration when far apart on the same day -> ambiguous", () => {
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ title: "Alpha", startLocal: "2026-07-01T18:00", promoter: "Kokorico" }),
      candidates: [
        cand({ id: "c", title: "Totally Different", startLocal: "2026-07-01T23:30", promoter: "Kokorico" }),
      ],
    }),
  );
  assert.equal(r.decision, "ambiguous");
  assert.equal(r.canonicalId, null);
});

// ── venue equality is structural, not name-based, inside the pass ─
test("candidate venue name is never consulted — both shims get the incoming name, both ids equal", () => {
  // Even though shim() passes `incoming.venueName` for the candidate too, the
  // venue-id branch of compareEvents (both ids non-null and equal) is the one
  // taken, so the name is dead weight. A candidate whose real venue differs only
  // by id is still excluded by the hard `c.venueId !== resolvedVenueId` guard.
  const r = resolveEventIdentity(
    req({
      incoming: incoming({ venueName: "Whatever Club" }),
      candidates: [
        cand({ id: "ev-here" }), // venueId === VENUE
        cand({ id: "ev-there", venueId: "v-OTHER" }), // excluded outright
      ],
    }),
  );
  assert.equal(r.decision, "matched");
  assert.equal(r.canonicalId, "ev-here");
});

// ── input immutability (point 10) ───────────────────────────────
test("resolveEventIdentity does not mutate its request (deep-frozen input still resolves)", () => {
  const r0 = req({
    incoming: incoming({ ticketUrl: "https://tix.example/event/500", lineup: ["DJ A"] }),
    candidates: [
      cand({ id: "ev-A", ticketUrl: "https://tix.example/event/500" }),
      cand({ id: "ev-sep", startLocal: "2026-09-01T22:00", title: "Nope" }),
    ],
  });
  Object.freeze(r0);
  Object.freeze(r0.incoming);
  Object.freeze(r0.incoming.lineup);
  r0.candidates.forEach((c) => Object.freeze(c));
  Object.freeze(r0.candidates);

  const out = resolveEventIdentity(r0);
  assert.equal(out.canonicalId, "ev-A");
});

// ── latent: automatic[] is not deduped by id (point 3, deferred) ─
test("[latent] the SAME canonical event listed twice reads as two automatic matches -> ambiguous", () => {
  // Not reachable from `store.findEventsAtVenueOnDate` (its rows are distinct),
  // documented so a future caller that can produce duplicates knows the shape.
  const dup = cand({ id: "ev-dup" });
  const r = resolveEventIdentity(req({ candidates: [dup, { ...dup }] }));
  assert.equal(r.decision, "ambiguous");
  assert.equal(r.canonicalId, null);
});
