/**
 * Curated cross-source identity: GIGS TIX venue `nova-zappa-barka` → the
 * existing OSM venue "Zappa Barka" (way/1446216912). Same physical venue,
 * confirmed by the product owner. "Nova Zappa Barka" does not name-match
 * "Zappa Barka", so only the curated identity links them — never a name or
 * proximity heuristic, never a second venue.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGigstixConfigProvider } from "../../src/sync/adapters/gigstix-config.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { planSync } from "../../src/sync/engine.ts";
import type { NormalizedEvent } from "../../src/sync/event-contract.ts";
import { matchEventVenue } from "../../src/sync/event-venue-match.ts";
import { serbianProfile } from "../../src/sync/normalization.ts";
import { InMemoryCanonicalStore, type CanonicalVenue } from "../../src/sync/store.ts";
import type { VenueLinkHint } from "../../src/sync/types.ts";
import {
  CROSS_SOURCE_VENUE_IDENTITIES,
  resolveCrossSourceIdentity,
  type CrossSourceVenueIdentity,
} from "../../src/sync/venue-cross-source-identity.ts";

const NOW = "2026-09-29T20:00:00.000Z";
const ZAPPA_REF = "way/1446216912";
const CITIES = [
  { id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: null },
  { id: "city-ns", countryCode: "RS", name: "Novi Sad", timeZone: null },
];

function venue(over: Partial<CanonicalVenue> & { id: string; name: string }): CanonicalVenue {
  return {
    cityId: "city-bg",
    cityName: "Belgrade",
    countryCode: "RS",
    normalizedName: serbianProfile.normalizeName(over.name),
    address: null,
    coordinates: null,
    coordinatesSource: null,
    website: null,
    wikidata: null,
    openingHours: null,
    description: null,
    openingTime: null,
    closingTime: null,
    isActive: true,
    sourceKey: "OpenStreetMap",
    externalId: null,
    sourceUrl: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const ZAPPA = venue({ id: "v-zb", name: "Zappa Barka", externalId: ZAPPA_REF, address: "Обала мајора Драгутина Гавриловића 10" });
const KARMAKOMA = venue({ id: "v-km", name: "Karmakoma", externalId: "node/1" });
const VENUES = [ZAPPA, KARMAKOMA];
const WITHOUT_NOVA = CROSS_SOURCE_VENUE_IDENTITIES.filter((i) => i.externalId !== "nova-zappa-barka");

const hint = (name: string, sourceVenueId: string | null): VenueLinkHint => ({
  name,
  sourceVenueId,
  address: null,
  coordinates: null,
  cityText: "Beograd",
});
const NOVA = hint("Nova Zappa Barka", "nova-zappa-barka");

function match(
  h: VenueLinkHint,
  identities: CrossSourceVenueIdentity[] = CROSS_SOURCE_VENUE_IDENTITIES,
  over: { sourceKey?: string; city?: { countryCode: string; cityName: string }; venues?: CanonicalVenue[] } = {},
) {
  return matchEventVenue({
    sourceKey: over.sourceKey ?? "gigstix",
    hint: h,
    city: over.city ?? { countryCode: "RS", cityName: "Belgrade" },
    venues: over.venues ?? VENUES,
    normalizeName: serbianProfile.normalizeName,
    crossSourceIdentities: identities,
  });
}

/** GIGS event 25652 ("Tribute To Bathory - Blood Fire Death") as the GIGS adapter shapes it. */
const EVENT: NormalizedEvent = {
  kind: "event",
  provenance: {
    sourceKey: "gigstix",
    externalId: "25652",
    sourceUrl: "https://new.gigstix.com/event/tribute-to-bathory-beograd-20-novembar-2026/",
    confidence: 1,
    fetchedAt: NOW,
    reported: {},
  },
  scope: { countryCode: "RS", cityText: "Beograd", coordinates: null },
  fields: {
    title: "Tribute To Bathory - Blood Fire Death",
    description: null,
    startLocal: "2026-11-20T20:00",
    endLocal: null,
    doorsLocal: null,
    timeZone: "Europe/Belgrade",
    startPrecision: "datetime",
    status: "scheduled",
    promoter: null,
    ticketUrl: null,
    coverImageUrl: null,
    lineup: [],
  },
  links: { venue: NOVA },
};

function plan(store: InMemoryCanonicalStore, identities: CrossSourceVenueIdentity[]) {
  const config = createGigstixConfigProvider();
  return planSync({
    adapter: createInMemoryAdapter({ key: "gigstix", items: [{ externalId: "25652", kind: "event", payload: EVENT }] }),
    source: config.source("gigstix")!,
    config,
    store,
    now: NOW,
    runId: "t",
    crossSourceIdentities: identities,
  });
}

// ── the shipped entry ────────────────────────────────────────────────
test("the shipped Belgrade identity: gigstix `nova-zappa-barka` → OpenStreetMap way/1446216912", () => {
  const entries = CROSS_SOURCE_VENUE_IDENTITIES.filter((i) => i.sourceKey === "gigstix" && i.externalId === "nova-zappa-barka");
  assert.deepEqual(
    entries.map((i) => [i.countryCode, i.cityName, i.canonical]),
    [["RS", "Belgrade", { sourceKey: "OpenStreetMap", externalId: ZAPPA_REF }]],
  );
});

// ── matcher ──────────────────────────────────────────────────────────
test("matcher: GIGS `nova-zappa-barka` resolves to the existing 'Zappa Barka' venue at tier 0 (source identity)", () => {
  const r = match(NOVA);
  assert.equal(r.status, "matched");
  if (r.status !== "matched") return;
  assert.equal(r.venueId, "v-zb");
  assert.equal(r.venueName, "Zappa Barka");
  assert.equal(r.tier, 0);
  assert.match(r.note, /gigstix:nova-zappa-barka is "Zappa Barka" \(source identity\)/);
});

test("matcher: without the curated entry, no name tier links 'Nova Zappa Barka' to 'Zappa Barka' (the prior outcome)", () => {
  const r = match(NOVA, WITHOUT_NOVA);
  assert.deepEqual([r.status, (r as { reasonCode?: string }).reasonCode], ["unresolved", "no-existing-venue"]);
});

test("matcher: when the Zappa Barka row is missing, the identity goes to review — it never falls back to a new venue", () => {
  const r = match(NOVA, CROSS_SOURCE_VENUE_IDENTITIES, { venues: [KARMAKOMA] });
  assert.deepEqual([r.status, (r as { reasonCode?: string }).reasonCode], ["review", "venue-identity-target-missing"]);
});

test("matcher: existing `zappa-barka` behavior is unchanged — still the tier 2 name match to the same venue", () => {
  const zappa = hint("Zappa Barka", "zappa-barka");
  const withEntry = match(zappa);
  assert.deepEqual(withEntry, match(zappa, WITHOUT_NOVA));
  assert.equal(withEntry.status, "matched");
  if (withEntry.status !== "matched") return;
  assert.equal(withEntry.venueId, "v-zb");
  assert.equal(withEntry.tier, 2);
});

test("scoping: the identity is Belgrade-only, RS-only and gigstix-only", () => {
  const nsZappa = { ...ZAPPA, id: "v-ns", cityId: "city-ns", cityName: "Novi Sad" };
  // another city (even with a same-ref venue there)
  assert.equal(match(NOVA, CROSS_SOURCE_VENUE_IDENTITIES, { city: { countryCode: "RS", cityName: "Novi Sad" }, venues: [nsZappa] }).status, "unresolved");
  // another country
  const hrZappa = { ...ZAPPA, id: "v-hr", countryCode: "HR" };
  assert.equal(match(NOVA, CROSS_SOURCE_VENUE_IDENTITIES, { city: { countryCode: "HR", cityName: "Belgrade" }, venues: [hrZappa] }).status, "unresolved");
  // another source using the same venue id
  assert.equal(match(NOVA, CROSS_SOURCE_VENUE_IDENTITIES, { sourceKey: "othersource" }).status, "unresolved");
  // the resolver itself
  const base = { externalId: "nova-zappa-barka", identities: CROSS_SOURCE_VENUE_IDENTITIES, venues: [ZAPPA, nsZappa] };
  assert.equal(resolveCrossSourceIdentity({ ...base, sourceKey: "gigstix", city: { countryCode: "RS", cityName: "Belgrade" } }).status, "matched");
  assert.equal(resolveCrossSourceIdentity({ ...base, sourceKey: "gigstix", city: { countryCode: "RS", cityName: "Novi Sad" } }).status, "none");
  assert.equal(resolveCrossSourceIdentity({ ...base, sourceKey: "othersource", city: { countryCode: "RS", cityName: "Belgrade" } }).status, "none");
});

test("an unrelated GIGS venue is not affected by the entry", () => {
  for (const h of [hint("Karmakoma", "karmakoma-beograd"), hint("Beton", "beton"), hint("Hangar", "hangar-luka-beograd")]) {
    assert.deepEqual(match(h), match(h, WITHOUT_NOVA), h.sourceVenueId ?? "");
  }
  const km = match(hint("Karmakoma", "karmakoma-beograd"));
  assert.equal(km.status === "matched" && km.venueId, "v-km");
  assert.equal(match(hint("Beton", "beton")).status, "unresolved");
});

// ── engine ───────────────────────────────────────────────────────────
test("engine: GIGS 25652 at `nova-zappa-barka` plans an event on the existing Zappa Barka venue — no venue candidate, no review", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [ZAPPA, KARMAKOMA] });
  const p = await plan(store, CROSS_SOURCE_VENUE_IDENTITIES);
  assert.deepEqual(
    p.upserts.map((u) => [u.kind, u.operation, u.changeStatus, u.resolvedVenueId]),
    [["event", "insert", "NEW", "v-zb"]],
  );
  assert.deepEqual(p.reviewItems, []);
  assert.equal(p.stats.venuesMatched, 1);
  assert.equal(p.stats.venuesNew, 0);
  assert.deepEqual(store.venues.map((v) => v.id), ["v-zb", "v-km"], "planning creates nothing");
});

test("engine: without the curated entry the event has no venue and Nova Zappa Barka is only a skipped venue candidate (prior behavior)", async () => {
  const store = new InMemoryCanonicalStore({ cities: CITIES, venues: [ZAPPA, KARMAKOMA] });
  const p = await plan(store, WITHOUT_NOVA);
  assert.equal(p.upserts.find((u) => u.kind === "event")?.resolvedVenueId, null);
  assert.deepEqual(
    p.upserts.filter((u) => u.kind === "venue").map((u) => [u.operation, u.record.provenance.externalId]),
    [["skip", "nova-zappa-barka"]],
  );
  assert.deepEqual(p.reviewItems.map((r) => r.reasonCode), ["city-not-event-first-enabled"]);
});
