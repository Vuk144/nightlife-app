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
