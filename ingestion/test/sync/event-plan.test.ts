/**
 * `../../src/sync/event-plan.ts` — READY / REVIEW / REJECTED for one parsed
 * event. Exercised with the real GIGS Intercell fixture; the store is the
 * real `SupabaseCanonicalStore` over the fake Supabase, with `apply` fenced
 * off. No network, no wall clock, no writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseGigstixEventRecord } from "../../src/sync/adapters/gigstix-event.ts";
import { DEFAULT_RECONCILIATION, InMemoryConfigProvider } from "../../src/sync/config.ts";
import type { NormalizedEvent } from "../../src/sync/event-contract.ts";
import { planEvent, planEventInStore, type EventParseResult } from "../../src/sync/event-plan.ts";
import type { EventVenueMatch } from "../../src/sync/event-venue-match.ts";
import type { CanonicalStore } from "../../src/sync/store.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { CROSS_SOURCE_VENUE_IDENTITIES } from "../../src/sync/venue-cross-source-identity.ts";
import { FakeSupabase } from "./fake-supabase.ts";

const fixture = (name: string) => readFileSync(new URL(`../events/fixtures/gigstix-event-${name}.html`, import.meta.url), "utf8");
const CTX = { fetchedAt: "2026-09-27T00:00:00.000Z" };
const intercell = (): EventParseResult => parseGigstixEventRecord(fixture("intercell"), "https://new.gigstix.com/event/intercell-with-dvs1/", CTX);

const config = () =>
  new InMemoryConfigProvider({
    countries: [{ code: "RS", name: "Serbia", enabled: true, defaultTimeZone: "Europe/Belgrade", bounds: null, normalizationProfile: "sr", extraPlaceholderPatterns: [] }],
    cities: [{ countryCode: "RS", canonicalName: "Belgrade", enabled: true, eventFirstEnabled: false, timeZone: "Europe/Belgrade", nameAliases: ["beograd"], bounds: null, sourceScope: {} }],
    sources: [],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  });

/** The real Supabase store code over the fake DB, `apply` fenced off. */
function readOnlyStore(venues: Record<string, unknown>[]) {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: "OpenStreetMap", type: "api" }]);
  fake.seed("venues", venues);
  const store = new SupabaseCanonicalStore(fake.asClient());
  const calls = { apply: 0 };
  store.apply = async () => {
    calls.apply++;
    throw new Error("the planner must never apply");
  };
  return { fake, store, calls };
}
const DRAGSTOR_ROW = { id: "uuid-dragstor", city_id: "city-bg", name: "Драгстор", name_normalized: "dragstor", source_id: "ds-osm", external_id: "node/5302622223", is_active: true, created_at: "x", updated_at: "x" };

// ── READY ───────────────────────────────────────────────────────────────
test("READY: real Intercell → valid event → venue matched to the existing OSM node/5302622223 'Драгстор'", async () => {
  const { fake, store, calls } = readOnlyStore([DRAGSTOR_ROW]);
  const plan = await planEventInStore(intercell(), { config: config(), store, crossSourceIdentities: CROSS_SOURCE_VENUE_IDENTITIES });

  assert.equal(plan.action, "READY");
  if (plan.action !== "READY") return;
  assert.equal(plan.event.provenance.sourceKey, "gigstix");
  assert.equal(plan.event.provenance.externalId, "25772");
  assert.equal(plan.event.fields.title, "Intercell with DVS1");
  assert.equal(plan.startAt, "2026-10-30T22:00:00.000Z");
  assert.equal(plan.endAt, null);
  assert.equal(plan.venueId, "uuid-dragstor");
  assert.equal(plan.venueName, "Драгстор");
  const canonical = await store.getVenueById(plan.venueId);
  assert.deepEqual([canonical?.sourceKey, canonical?.externalId], ["OpenStreetMap", "node/5302622223"]);

  assert.equal(calls.apply, 0);
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.tables.venues.length, 1);
  assert.equal(fake.tables.events.length, 0);
});

// ── REVIEW ──────────────────────────────────────────────────────────────
test("REVIEW: a valid event whose venue is unresolved (no curated identity, no name match)", async () => {
  const { fake, store, calls } = readOnlyStore([DRAGSTOR_ROW]);
  const plan = await planEventInStore(intercell(), { config: config(), store }); // no cross-source identities
  assert.equal(plan.action, "REVIEW");
  if (plan.action !== "REVIEW") return;
  assert.equal(plan.reasonCode, "no-existing-venue");
  assert.equal(plan.venueMatch?.status, "unresolved");
  assert.equal(plan.startAt, "2026-10-30T22:00:00.000Z", "the event itself is valid");
  assert.equal("venueId" in plan, false);
  assert.equal(calls.apply, 0);
  assert.deepEqual(fake.writes, []);
});

test("REVIEW: an ambiguous venue match keeps its candidates and picks none", async () => {
  const twins = [
    { ...DRAGSTOR_ROW, id: "v-1", name: "Drugstore", name_normalized: "drugstore", source_id: null, external_id: null },
    { ...DRAGSTOR_ROW, id: "v-2", name: "DRUGSTORE", name_normalized: "drugstore", source_id: null, external_id: null },
  ];
  const { store, calls } = readOnlyStore(twins);
  const plan = await planEventInStore(intercell(), { config: config(), store });
  assert.equal(plan.action, "REVIEW");
  if (plan.action !== "REVIEW") return;
  assert.equal(plan.reasonCode, "venue-ambiguous");
  assert.deepEqual(plan.venueMatch?.status === "review" && plan.venueMatch.candidates.map((c) => c.id), ["v-1", "v-2"]);
  assert.equal(calls.apply, 0);
});

test("REVIEW (pure): a matched venue but a start with no zone to resolve in is not READY", () => {
  const parsed = intercell();
  assert.ok(parsed.ok);
  const noZone: EventParseResult = { ok: true, record: { ...parsed.record, fields: { ...parsed.record.fields, timeZone: null } } };
  const matched: EventVenueMatch = { status: "matched", venueId: "uuid-dragstor", venueName: "Драгстор", tier: 0, note: "" };
  const plan = planEvent({ parsed: noZone, venueMatch: matched, fallbackTimeZone: null });
  assert.equal(plan.action === "REVIEW" && plan.reasonCode, "start-time-unresolved");
  // the same with a zone is READY
  assert.equal(planEvent({ parsed: noZone, venueMatch: matched, fallbackTimeZone: "Europe/Belgrade" }).action, "READY");
});

// ── REJECTED ────────────────────────────────────────────────────────────
/** A store whose every method throws: proves a rejected event never reaches the store. */
const untouchableStore = new Proxy({}, {
  get: (_t, prop) => () => {
    throw new Error(`store.${String(prop)} must not be called for a rejected event`);
  },
}) as CanonicalStore;

test("REJECTED: the event breaks the contract (end before start) — the store is never touched", async () => {
  const parsed = intercell();
  assert.ok(parsed.ok);
  const broken: NormalizedEvent = { ...parsed.record, fields: { ...parsed.record.fields, endLocal: "2026-10-30T21:00" } };
  const plan = await planEventInStore({ ok: true, record: broken }, { config: config(), store: untouchableStore });
  assert.equal(plan.action, "REJECTED");
  if (plan.action === "REJECTED") {
    assert.equal(plan.reasonCode, "end-before-start");
    assert.equal(plan.event?.provenance.externalId, "25772");
  }
});

test("REJECTED: the page does not parse (GIGS 'page not found')", async () => {
  const parsed = parseGigstixEventRecord(fixture("notfound"), "https://new.gigstix.com/event/gone/", CTX);
  const plan = await planEventInStore(parsed, { config: config(), store: untouchableStore });
  assert.deepEqual(plan, { action: "REJECTED", event: null, reasonCode: "not-found-page", note: "Stranica nije pronađena" });
});

test("the planner is source-agnostic and pure: same input, same plan; no store needed", () => {
  const parsed = intercell();
  const matched: EventVenueMatch = { status: "matched", venueId: "any-venue", venueName: "Any", tier: 2, note: "" };
  const a = planEvent({ parsed, venueMatch: matched, fallbackTimeZone: null });
  const b = planEvent({ parsed, venueMatch: matched, fallbackTimeZone: null });
  assert.deepEqual(a, b);
  assert.equal(a.action === "READY" && a.venueId, "any-venue");
});
