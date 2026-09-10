/**
 * `../../src/sync/venue-identity.ts#resolveVenueIdentity` — the thin adapter
 * over `../matching.ts#resolveMatch`. It had no direct unit test.
 *
 * Also pins the honest contract from the identity review: `VenueIdentityRequest`
 * has NO `aliases` field (the old one was silently ignored — the matcher reads
 * `../aliases.ts` directly and its API has no override hook).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVenueIdentity } from "../../src/sync/venue-identity.ts";
import type {
  VenueIdentityInput,
  VenueIdentityRequest,
  VenueMatchCandidate,
} from "../../src/sync/venue-identity.ts";

function incoming(over: Partial<VenueIdentityInput> = {}): VenueIdentityInput {
  return {
    source: { sourceKey: "osm", externalId: "osm-1", sourceUrl: null },
    name: "Klub Depo",
    normalizedName: "depo",
    coordinates: null,
    address: null,
    website: null,
    wikidata: null,
    ...over,
  };
}

function candidate(over: Partial<VenueMatchCandidate>): VenueMatchCandidate {
  return {
    id: "v-1",
    name: "Depo",
    normalizedName: "depo",
    sourceKey: null,
    externalId: null,
    sourceUrl: null,
    coordinates: null,
    coordinatesSource: null,
    address: null,
    website: null,
    wikidata: null,
    ...over,
  };
}

function req(over: Partial<VenueIdentityRequest>): VenueIdentityRequest {
  return {
    incoming: incoming(),
    scope: { countryCode: "RS", cityName: "Belgrade" },
    existingInCity: [],
    ...over,
  };
}

test("no existing venue in the city -> new_candidate (tier 4), canonicalId null", () => {
  const r = resolveVenueIdentity(req({ existingInCity: [] }));
  assert.equal(r.decision, "new_candidate");
  assert.equal(r.tier, 4);
  assert.equal(r.canonicalId, null);
});

test("exactly one existing venue with the same normalized name in the city -> matched (tier 2)", () => {
  const r = resolveVenueIdentity(req({ existingInCity: [candidate({ id: "v-depo" })] }));
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 2);
  assert.equal(r.canonicalId, "v-depo");
});

test("two existing venues sharing the incoming normalized name -> ambiguous, canonicalId null", () => {
  const r = resolveVenueIdentity(
    req({
      existingInCity: [
        candidate({ id: "v-a", name: "Depo A" }),
        candidate({ id: "v-b", name: "Depo B" }),
      ],
    }),
  );
  assert.equal(r.decision, "ambiguous");
  assert.equal(r.canonicalId, null, "an ambiguous venue must never look like an update instruction");
});

test("a shared wikidata id wins as a strong identifier (tier 1)", () => {
  const r = resolveVenueIdentity(
    req({
      incoming: incoming({ wikidata: "Q42", normalizedName: "totally different name" }),
      existingInCity: [candidate({ id: "v-qid", normalizedName: "something-else", wikidata: "Q42" })],
    }),
  );
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 1);
  assert.equal(r.canonicalId, "v-qid");
});

test("resolveVenueIdentity result never carries a canonicalId unless decision is 'matched'", () => {
  for (const r of [
    resolveVenueIdentity(req({ existingInCity: [] })),
    resolveVenueIdentity(
      req({ existingInCity: [candidate({ id: "x" }), candidate({ id: "y" })] }),
    ),
  ]) {
    if (r.decision !== "matched") assert.equal(r.canonicalId, null);
  }
});

// ════════════════════════════════════════════════════════════════════════
//  AUDIT PASS — adapter ↔ matcher translation (no bug found)
// ════════════════════════════════════════════════════════════════════════

const BG = { countryCode: "RS", cityName: "Belgrade" } as const;
/** Two Belgrade points ~78 m apart (inside the Tier-3 link guard). */
const NEAR_A = { latitude: 44.808, longitude: 20.4612 };
const NEAR_B = { latitude: 44.8087, longitude: 20.4612 };
/** ~500 m from NEAR_A (Tier-3 review band). */
const MID = { latitude: 44.8125, longitude: 20.4612 };
/** ~1.9 km from NEAR_A (past the Tier-3 review band). */
const FAR = { latitude: 44.825, longitude: 20.4612 };

// ── STEP 3 / 9E — source isolation via ctx.osmSourceId ──────────────────
test("[source-isolation] Tier 0 needs the SAME source key — a matching external id from a different source does not merge", () => {
  const notMine = resolveVenueIdentity(
    req({
      incoming: incoming({ source: { sourceKey: "gigstix", externalId: "g-9", sourceUrl: null }, normalizedName: "unique-xyz" }),
      existingInCity: [candidate({ id: "v-osm", normalizedName: "something-else", sourceKey: "osm", externalId: "g-9" })],
    }),
  );
  assert.equal(notMine.decision, "new_candidate", "cross-source id collision must NOT be a Tier 0 match");

  const mine = resolveVenueIdentity(
    req({
      incoming: incoming({ source: { sourceKey: "gigstix", externalId: "g-9", sourceUrl: null }, normalizedName: "something-else" }),
      existingInCity: [candidate({ id: "v-gig", normalizedName: "something-else", sourceKey: "gigstix", externalId: "g-9" })],
    }),
  );
  assert.equal(mine.decision, "matched");
  assert.equal(mine.tier, 0);
  assert.equal(mine.canonicalId, "v-gig");
});

// ── STEP 8 — tier precedence (stronger identity wins, deterministically) ─
test("[precedence] Tier 0 beats a conflicting Tier 1 (Wikidata) candidate", () => {
  const r = resolveVenueIdentity(
    req({
      incoming: incoming({ source: { sourceKey: "osm", externalId: "o-5", sourceUrl: null }, wikidata: "Q9", normalizedName: "zzz" }),
      existingInCity: [
        candidate({ id: "v-wd", normalizedName: "wd", wikidata: "Q9" }),
        candidate({ id: "v-t0", normalizedName: "t0", sourceKey: "osm", externalId: "o-5" }),
      ],
    }),
  );
  assert.equal(r.tier, 0);
  assert.equal(r.canonicalId, "v-t0");
});

test("[precedence] Tier 1 (Wikidata) beats a Tier 2 exact-name candidate", () => {
  const r = resolveVenueIdentity(
    req({
      incoming: incoming({ wikidata: "Q7", normalizedName: "depo" }),
      existingInCity: [
        candidate({ id: "v-name", normalizedName: "depo" }), // would be Tier 2
        candidate({ id: "v-qid", normalizedName: "unrelated", wikidata: "Q7" }), // Tier 1
      ],
    }),
  );
  assert.equal(r.tier, 1);
  assert.equal(r.canonicalId, "v-qid");
});

// ── STEP 4 — Tier 1 website: dedicated domain only ─────────────────────
test("[website] a shared dedicated domain is Tier 1; a shared platform host is NOT; a malformed URL never matches", () => {
  const dedicated = resolveVenueIdentity(
    req({
      incoming: incoming({ website: "https://www.klubdepo.rs/events", normalizedName: "zzz" }),
      existingInCity: [candidate({ id: "v-site", normalizedName: "d", website: "http://klubdepo.rs" })],
    }),
  );
  assert.equal(dedicated.tier, 1);
  assert.equal(dedicated.canonicalId, "v-site");

  const platform = resolveVenueIdentity(
    req({
      incoming: incoming({ website: "https://facebook.com/klubdepo", normalizedName: "zzz" }),
      existingInCity: [candidate({ id: "v-fb", normalizedName: "d", website: "https://facebook.com/someoneelse" })],
    }),
  );
  assert.equal(platform.decision, "new_candidate", "a platform host is never venue identity");

  const malformed = resolveVenueIdentity(
    req({
      incoming: incoming({ website: "not a url", normalizedName: "zzz" }),
      existingInCity: [candidate({ id: "v-x", normalizedName: "d", website: "also not a url" })],
    }),
  );
  assert.equal(malformed.decision, "new_candidate");
});

// ── STEP 4 — Tier 1 Wikidata: exact id, name-independent ───────────────
test("[wikidata] an exact shared QID matches at Tier 1 regardless of name; a different QID does not", () => {
  assert.equal(
    resolveVenueIdentity(
      req({
        incoming: incoming({ wikidata: "Q123", normalizedName: "completely different" }),
        existingInCity: [candidate({ id: "v-q", normalizedName: "x", wikidata: "Q123" })],
      }),
    ).tier,
    1,
  );
  assert.equal(
    resolveVenueIdentity(
      req({
        incoming: incoming({ wikidata: "Q123", normalizedName: "x" }),
        existingInCity: [candidate({ id: "v-q", normalizedName: "x", wikidata: "Q999" })],
      }),
    ).tier,
    2, // falls through to Tier 2 on the exact name
  );
});

// ── STEP 6 — Tier 3 alias + proximity guard ───────────────────────────
test("[alias] 'dragstor' -> curated canonical 'Drugstore' links at Tier 3 within the proximity guard", () => {
  const r = resolveVenueIdentity({
    incoming: incoming({ normalizedName: "dragstor", coordinates: NEAR_B }),
    scope: BG,
    existingInCity: [candidate({ id: "v-ds", name: "Drugstore", normalizedName: "drugstore", coordinates: NEAR_A })],
  });
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 3);
  assert.equal(r.canonicalId, "v-ds");
});

test("[alias][characterization] a 300–1000 m alias link is STILL `matched` tier 3 — the matcher's `review` flag is not on IdentityOutcome, only in `note`", () => {
  const r = resolveVenueIdentity({
    incoming: incoming({ normalizedName: "dragstor", coordinates: MID }),
    scope: BG,
    existingInCity: [candidate({ id: "v-ds", name: "Drugstore", normalizedName: "drugstore", coordinates: NEAR_A })],
  });
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 3);
  assert.match(r.note, /over the 300 m guard/); // the only surviving trace of the review flag
});

test("[alias] past the review band (>1 km) the alias does NOT link -> new_candidate", () => {
  const r = resolveVenueIdentity({
    incoming: incoming({ normalizedName: "dragstor", coordinates: FAR }),
    scope: BG,
    existingInCity: [candidate({ id: "v-ds", name: "Drugstore", normalizedName: "drugstore", coordinates: NEAR_A })],
  });
  assert.equal(r.decision, "new_candidate");
});

test("[alias] an alias is country + city scoped — the same normalized name outside RS/Belgrade is not aliased", () => {
  const r = resolveVenueIdentity({
    incoming: incoming({ normalizedName: "dragstor" }),
    scope: { countryCode: "HR", cityName: "Zagreb" },
    existingInCity: [candidate({ id: "v-ds", name: "Drugstore", normalizedName: "drugstore" })],
  });
  assert.equal(r.decision, "new_candidate", "no HR/Zagreb alias for 'dragstor'");
});

// ── STEP 6 / 9H — missing / NaN coordinates never create a distance link ─
test("[missing-coords] incoming with NO coordinates never gets a distance-based Tier 3 link when the canonical venue HAS coordinates", () => {
  const r = resolveVenueIdentity({
    incoming: incoming({ normalizedName: "dragstor", coordinates: null }),
    scope: BG,
    existingInCity: [candidate({ id: "v-ds", name: "Drugstore", normalizedName: "drugstore", coordinates: NEAR_A })],
  });
  assert.equal(r.decision, "new_candidate", "null coords -> NaN -> fails every distance comparison");
});

test("[missing-coords] an alias still links at Tier 3 when the CANONICAL venue has no coordinates to cross-check (matcher policy)", () => {
  const r = resolveVenueIdentity({
    incoming: incoming({ normalizedName: "dragstor", coordinates: null }),
    scope: BG,
    existingInCity: [candidate({ id: "v-ds", name: "Drugstore", normalizedName: "drugstore", coordinates: null })],
  });
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 3);
});

test("[missing-coords] coordinates ALONE never merge two venues (no alias, exact-different name)", () => {
  const r = resolveVenueIdentity(
    req({
      incoming: incoming({ normalizedName: "alpha", coordinates: NEAR_A }),
      existingInCity: [candidate({ id: "v-b", normalizedName: "beta", coordinates: NEAR_B })], // ~78 m, different name, no alias
    }),
  );
  assert.equal(r.decision, "new_candidate");
});

// ── STEP 7 — candidate evaluation / ambiguity / ordering ───────────────
test("[ambiguity] >1 exact-name candidates -> ambiguous (skip), never a guess, canonicalId null", () => {
  for (const order of [
    [candidate({ id: "v-a" }), candidate({ id: "v-b" })],
    [candidate({ id: "v-b" }), candidate({ id: "v-a" })],
  ]) {
    const r = resolveVenueIdentity(req({ existingInCity: order }));
    assert.equal(r.decision, "ambiguous");
    assert.equal(r.tier, null);
    assert.equal(r.canonicalId, null);
  }
});

test("[ordering] a well-formed candidate pool is order-independent for Tier 2 (one match) and Tier 2 (ambiguous)", () => {
  const permute = <T>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  const onePool = [
    candidate({ id: "v-hit", normalizedName: "depo" }),
    candidate({ id: "v-other", normalizedName: "elsewhere" }),
    candidate({ id: "v-third", normalizedName: "third" }),
  ];
  for (const order of permute(onePool)) {
    const r = resolveVenueIdentity(req({ existingInCity: order }));
    assert.equal(r.canonicalId, "v-hit", JSON.stringify(order.map((c) => c.id)));
  }

  const ambigPool = [
    candidate({ id: "v-1", normalizedName: "depo" }),
    candidate({ id: "v-2", normalizedName: "depo" }),
    candidate({ id: "v-3", normalizedName: "other" }),
  ];
  for (const order of permute(ambigPool)) {
    assert.equal(resolveVenueIdentity(req({ existingInCity: order })).decision, "ambiguous");
  }
});

test("[characterization][unreachable] two candidates with the SAME id read as two rows -> false Tier-2 ambiguity", () => {
  // `resolveMatch` counts matching ROWS, not distinct ids. `store.listVenuesInCity`
  // always returns distinct rows (SELECT on the PK / a de-duped array), so this
  // shape is not reachable from the production query path. Pinned so a future
  // caller that could pass duplicates knows the consequence.
  const dup = candidate({ id: "v-dup", normalizedName: "depo" });
  const r = resolveVenueIdentity(req({ existingInCity: [dup, { ...dup }] }));
  assert.equal(r.decision, "ambiguous");
  assert.equal(r.canonicalId, null);
});

test("[characterization][unreachable] Tier 1 uses first-match on a duplicate identifier — needs a data error AND an unordered store to matter", () => {
  // Wikidata / dedicated-domain uniqueness is a data invariant; two same-city
  // venues sharing one is a data error. This pins that IF it happens, the pick
  // follows candidate order (a `.find()` in matching.ts, not this adapter).
  const first = resolveVenueIdentity(
    req({
      incoming: incoming({ wikidata: "Q1", normalizedName: "zzz" }),
      existingInCity: [
        candidate({ id: "v-A", normalizedName: "a", wikidata: "Q1" }),
        candidate({ id: "v-B", normalizedName: "b", wikidata: "Q1" }),
      ],
    }),
  );
  const flipped = resolveVenueIdentity(
    req({
      incoming: incoming({ wikidata: "Q1", normalizedName: "zzz" }),
      existingInCity: [
        candidate({ id: "v-B", normalizedName: "b", wikidata: "Q1" }),
        candidate({ id: "v-A", normalizedName: "a", wikidata: "Q1" }),
      ],
    }),
  );
  assert.equal(first.canonicalId, "v-A");
  assert.equal(flipped.canonicalId, "v-B");
});

// ── STEP 10 — null / empty / malformed inputs ─────────────────────────
test("[null-empty] an empty incoming normalizedName never matches another empty normalizedName", () => {
  const r = resolveVenueIdentity(
    req({ incoming: incoming({ normalizedName: "" }), existingInCity: [candidate({ id: "v-e", normalizedName: "" })] }),
  );
  assert.equal(r.decision, "new_candidate");
});

test("[null-empty] null website / null wikidata simply skip Tier 1", () => {
  const r = resolveVenueIdentity(
    req({
      incoming: incoming({ website: null, wikidata: null, normalizedName: "solo" }),
      existingInCity: [candidate({ id: "v-1", normalizedName: "solo", website: "https://x.rs", wikidata: "Q5" })],
    }),
  );
  assert.equal(r.tier, 2, "falls through to the exact-name tier");
});

test("[inert-fields][characterization] sourceUrl / coordinatesSource / address / opening hours never affect the tier", () => {
  const base = () => resolveVenueIdentity(req({ existingInCity: [candidate({ id: "v-1", normalizedName: "depo" })] }));
  const noisy = () =>
    resolveVenueIdentity(
      req({
        incoming: incoming({ address: "Somewhere 5" }),
        existingInCity: [
          candidate({
            id: "v-1",
            normalizedName: "depo",
            sourceUrl: "https://elsewhere.example/x",
            coordinatesSource: "manual",
            address: "A Totally Different Address 99",
          }),
        ],
      }),
    );
  assert.deepEqual(noisy(), base());
});

// ── STEP 11 — purity / determinism ────────────────────────────────────
test("[purity] resolveVenueIdentity does not mutate a deep-frozen request", () => {
  const existing = [candidate({ id: "v-1", normalizedName: "depo" }), candidate({ id: "v-2", normalizedName: "other" })];
  existing.forEach((c) => Object.freeze(c));
  Object.freeze(existing);
  const request: VenueIdentityRequest = Object.freeze({
    incoming: Object.freeze(incoming()) as VenueIdentityInput,
    scope: Object.freeze({ countryCode: "RS", cityName: "Belgrade" }),
    existingInCity: existing,
  });
  const before = JSON.stringify(request);
  const r = resolveVenueIdentity(request);
  assert.equal(r.canonicalId, "v-1");
  assert.equal(JSON.stringify(request), before);
});

test("[determinism] identical requests yield deep-equal outcomes across repeated calls, for every decision", () => {
  const cases: VenueIdentityRequest[] = [
    req({ existingInCity: [] }), // new_candidate
    req({ existingInCity: [candidate({ id: "v-1" })] }), // matched
    req({ existingInCity: [candidate({ id: "a" }), candidate({ id: "b" })] }), // ambiguous
  ];
  for (const c of cases) {
    const first = resolveVenueIdentity(c);
    for (let i = 0; i < 5; i++) assert.deepEqual(resolveVenueIdentity(c), first);
  }
});

// ── STEP 12 — result translation exactness ───────────────────────────
test("[translation] match -> matched / tier N / venue id / venue-tier-N", () => {
  const r = resolveVenueIdentity(req({ existingInCity: [candidate({ id: "v-abc" })] }));
  assert.equal(r.entity, "venue");
  assert.equal(r.decision, "matched");
  assert.equal(r.tier, 2);
  assert.equal(r.canonicalId, "v-abc");
  assert.equal(r.reasonCode, "venue-tier-2");
});

test("[translation] skip -> ambiguous / tier null / canonicalId null / venue-ambiguous", () => {
  const r = resolveVenueIdentity(req({ existingInCity: [candidate({ id: "a" }), candidate({ id: "b" })] }));
  assert.deepEqual(
    { entity: r.entity, decision: r.decision, tier: r.tier, canonicalId: r.canonicalId, reasonCode: r.reasonCode },
    { entity: "venue", decision: "ambiguous", tier: null, canonicalId: null, reasonCode: "venue-ambiguous" },
  );
});

test("[translation] new -> new_candidate / tier 4 / canonicalId null / venue-new-candidate", () => {
  const r = resolveVenueIdentity(req({ existingInCity: [] }));
  assert.deepEqual(
    { entity: r.entity, decision: r.decision, tier: r.tier, canonicalId: r.canonicalId, reasonCode: r.reasonCode },
    { entity: "venue", decision: "new_candidate", tier: 4, canonicalId: null, reasonCode: "venue-new-candidate" },
  );
});
