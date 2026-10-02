/**
 * `../../src/sync/event-contract.ts` — the normalized event contract: canonical
 * instants from source-local time + IANA zone, and pure contract validation.
 * Deterministic: no wall-clock, no network, no store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { eventInstants, validateEventContract, type NormalizedEvent } from "../../src/sync/event-contract.ts";
import { validateRecord } from "../../src/sync/validation.ts";
import type { EventFields, ResolvedScope, VenueLinkHint } from "../../src/sync/types.ts";

const BELGRADE = "Europe/Belgrade";

function event(over: {
  fields?: Partial<EventFields>;
  venue?: Partial<VenueLinkHint> | null;
  sourceKey?: string;
  externalId?: string;
  sourceUrl?: string | null;
} = {}): NormalizedEvent {
  return {
    kind: "event",
    provenance: {
      sourceKey: over.sourceKey ?? "gigstix",
      externalId: over.externalId ?? "evt-1",
      sourceUrl: over.sourceUrl === undefined ? null : over.sourceUrl,
      confidence: 1,
      fetchedAt: "2026-09-27T00:00:00.000Z",
      reported: {},
    },
    scope: { countryCode: "RS", cityText: "Belgrade", coordinates: null },
    fields: {
      title: "Techno night",
      description: null,
      startLocal: "2026-10-30T23:00",
      endLocal: null,
      doorsLocal: null,
      timeZone: null,
      startPrecision: "datetime",
      status: "scheduled",
      promoter: null,
      ticketUrl: null,
      coverImageUrl: null,
      lineup: [],
      ...over.fields,
    },
    links:
      over.venue === null
        ? {}
        : { venue: { name: "Drugstore", sourceVenueId: null, address: null, coordinates: null, cityText: "Belgrade", ...over.venue } },
  };
}

const contract = (e: NormalizedEvent, zone: string | null = BELGRADE) => validateEventContract(e, zone)?.reasonCode ?? "ok";

// ── valid events ──────────────────────────────────────────────────────────
test("a valid minimal event passes: no end, no description / image / ticket / source URL", () => {
  assert.equal(contract(event()), "ok");
  assert.deepEqual(eventInstants(event().fields, BELGRADE), { ok: true, startAt: "2026-10-30T22:00:00.000Z", endAt: null });
});

test("a valid event with every optional field passes, with both canonical instants", () => {
  const full = event({
    sourceUrl: "https://gigstix.test/e/evt-1",
    fields: {
      description: "All night long",
      endLocal: "2026-10-31T05:00",
      timeZone: BELGRADE,
      status: "cancelled",
      ticketUrl: "https://tickets.test/1",
      coverImageUrl: "https://img.test/1.jpg",
    },
    venue: { sourceVenueId: "venue-42", address: "Poenkareova 36", coordinates: { latitude: 44.8185, longitude: 20.4884 } },
  });
  assert.equal(contract(full), "ok");
  assert.deepEqual(eventInstants(full.fields, null), {
    ok: true,
    startAt: "2026-10-30T22:00:00.000Z",
    endAt: "2026-10-31T04:00:00.000Z",
  });
});

test("a valid event without endAt", () => {
  assert.equal(contract(event({ fields: { endLocal: null } })), "ok");
  assert.equal(contract(event({ fields: { endLocal: "  " } })), "ok", "a blank end is an absent end");
});

test("venue name + city is enough — no canonical venue id is needed at normalization time", () => {
  const e = event({ venue: { name: "Drugstore", sourceVenueId: null, cityText: "Belgrade" } });
  assert.equal(contract(e), "ok");
  assert.equal("canonicalId" in e.links.venue!, false);
  // a source venue id alone is also a venue identity
  assert.equal(contract(event({ venue: { name: "", sourceVenueId: "venue-42" } })), "ok");
});

// ── rejections ────────────────────────────────────────────────────────────
test("blank title is rejected", () => {
  for (const title of ["", "   "]) assert.equal(contract(event({ fields: { title } })), "missing-title");
});

test("missing externalId is rejected (blank or whitespace)", () => {
  for (const externalId of ["", "  "]) assert.equal(contract(event({ externalId })), "missing-external-id");
});

test("missing source identity is rejected", () => {
  for (const sourceKey of ["", "  "]) assert.equal(contract(event({ sourceKey })), "missing-source");
});

test("invalid startAt is rejected: unparseable, calendar-impossible, trailing junk", () => {
  assert.equal(contract(event({ fields: { startLocal: "" } })), "missing-start");
  for (const startLocal of ["next friday", "2026-02-30T22:00", "2026-13-01", "2026-10-30T25:00", "2026-10-30T23:00garbage", "30.10.2026. 23.00"]) {
    assert.equal(contract(event({ fields: { startLocal } })), "invalid-start", startLocal);
  }
});

test("invalid endAt is rejected when supplied", () => {
  for (const endLocal of ["garbage", "2026-02-30", "2026-10-31T24:30"]) {
    assert.equal(contract(event({ fields: { endLocal } })), "invalid-end", endLocal);
  }
});

test("end before start is rejected; equal is allowed", () => {
  assert.equal(contract(event({ fields: { startLocal: "2026-10-30T23:00", endLocal: "2026-10-30T21:00" } })), "end-before-start");
  assert.equal(contract(event({ fields: { startLocal: "2026-10-30T23:00", endLocal: "2026-10-30T23:00" } })), "ok");
  // with no zone at all, wall-clock order is still checked
  assert.equal(contract(event({ fields: { startLocal: "2026-10-30T23:00", endLocal: "2026-10-29T23:00" } }), null), "end-before-start");
});

test("a date-only end means 'ends that day' — not midnight before a late start", () => {
  assert.equal(contract(event({ fields: { startLocal: "2026-10-30T23:00", endLocal: "2026-10-30" } })), "ok");
  assert.equal(contract(event({ fields: { startLocal: "2026-10-30T23:00", endLocal: "2026-10-29" } })), "end-before-start");
});

test("missing venue identity is rejected: no hint, or a hint with neither name nor source venue id", () => {
  assert.equal(contract(event({ venue: null })), "missing-venue-identity");
  assert.equal(contract(event({ venue: { name: "  ", sourceVenueId: null } })), "missing-venue-identity");
});

test("an unknown time zone is rejected rather than guessed", () => {
  assert.equal(contract(event({ fields: { timeZone: "Mars/Olympus" } })), "invalid-time-zone");
  assert.equal(contract(event(), "Not/AZone"), "invalid-time-zone");
});

// ── time handling ─────────────────────────────────────────────────────────
test("local time + IANA zone → canonical UTC instant (Belgrade summer +02:00, winter +01:00)", () => {
  const at = (startLocal: string) => eventInstants({ startLocal, endLocal: null, timeZone: BELGRADE }, null);
  assert.deepEqual(at("2026-07-01T22:00"), { ok: true, startAt: "2026-07-01T20:00:00.000Z", endAt: null });
  assert.deepEqual(at("2026-12-05T22:00"), { ok: true, startAt: "2026-12-05T21:00:00.000Z", endAt: null });
  assert.deepEqual(at("2026-07-01"), { ok: true, startAt: "2026-06-30T22:00:00.000Z", endAt: null }, "date-only = local midnight");
});

test("the record's own zone wins; otherwise the config-resolved zone; with neither, no instant is guessed", () => {
  const fields = { startLocal: "2026-07-01T22:00", endLocal: null };
  assert.equal((eventInstants({ ...fields, timeZone: "Europe/London" }, BELGRADE) as { startAt: string }).startAt, "2026-07-01T21:00:00.000Z");
  assert.equal((eventInstants({ ...fields, timeZone: null }, BELGRADE) as { startAt: string }).startAt, "2026-07-01T20:00:00.000Z");
  assert.deepEqual(eventInstants({ ...fields, timeZone: null }, null), { ok: true, startAt: null, endAt: null });
});

test("an already-absolute ISO instant is accepted as-is (the store's offset-wins rule)", () => {
  assert.deepEqual(eventInstants({ startLocal: "2026-07-01T20:00:00+00:00", endLocal: "2026-07-02T01:00Z", timeZone: BELGRADE }, null), {
    ok: true,
    startAt: "2026-07-01T20:00:00.000Z",
    endAt: "2026-07-02T01:00:00.000Z",
  });
  assert.equal(contract(event({ fields: { startLocal: "2026-02-30T20:00:00Z" } })), "invalid-start");
});

test("DST: a local time inside the spring-forward gap does not exist and is rejected", () => {
  // Europe/Belgrade: 2026-03-29 02:00 → 03:00
  assert.equal(contract(event({ fields: { startLocal: "2026-03-29T02:30" } })), "invalid-start");
  assert.equal(contract(event({ fields: { startLocal: "2026-03-29T01:30", endLocal: "2026-03-29T02:15" } })), "invalid-end");
  assert.equal(contract(event({ fields: { startLocal: "2026-03-29T03:00" } })), "ok", "the first valid time after the gap");
});

test("DST: an overnight event across the gap / overlap gets its true duration", () => {
  const hours = (startLocal: string, endLocal: string) => {
    const r = eventInstants({ startLocal, endLocal, timeZone: BELGRADE }, null);
    assert.ok(r.ok && r.startAt && r.endAt);
    return (Date.parse(r.endAt!) - Date.parse(r.startAt!)) / 3_600_000;
  };
  assert.equal(hours("2026-03-28T23:00", "2026-03-29T05:00"), 5, "spring forward: one hour shorter");
  assert.equal(hours("2026-10-24T23:00", "2026-10-25T05:00"), 7, "fall back: one hour longer");
});

test("DST: a fall-back wall-clock that occurs twice resolves deterministically (the same instant the store writes)", () => {
  // Europe/Belgrade: 2026-10-25 03:00 CEST → 02:00 CET; 02:30 happens twice
  const r = eventInstants({ startLocal: "2026-10-25T02:30", endLocal: null, timeZone: BELGRADE }, null);
  assert.deepEqual(r, { ok: true, startAt: "2026-10-25T01:30:00.000Z", endAt: null });
});

// ── the engine enforces the contract (validateRecord) ─────────────────────
const SCOPE: ResolvedScope = {
  countryCode: "RS",
  cityName: "Belgrade",
  cityId: "city-bg",
  timeZone: BELGRADE,
  cityEnabled: true,
  eventFirstEnabled: false,
  bounds: null,
  resolvedVia: "country+city",
};
const engine = (e: NormalizedEvent) => validateRecord({ record: e, scope: SCOPE, country: null });

test("[BUG regression] validateRecord now rejects events it used to admit as upserts", () => {
  // each of these validated "ok" before the contract existed
  assert.equal(engine(event({ fields: { endLocal: "garbage" } })).reasonCode, "invalid-end");
  assert.equal(engine(event({ fields: { startLocal: "2026-10-30T23:00", endLocal: "2026-10-30T21:00" } })).reasonCode, "end-before-start");
  assert.equal(engine(event({ sourceKey: "" })).reasonCode, "missing-source");
  assert.equal(engine(event({ fields: { startLocal: "2026-03-29T02:30" } })).reasonCode, "invalid-start", "uses the config-resolved zone");
  for (const r of [engine(event({ fields: { endLocal: "garbage" } })), engine(event({ sourceKey: "" }))]) {
    assert.equal(r.outcome, "rejected");
  }
});

test("validateRecord: a valid event is still ok, and the existing review rules still apply after the contract", () => {
  assert.equal(engine(event()).outcome, "ok");
  // a source venue id without a name satisfies the contract but can't be matched by name yet
  const r = engine(event({ venue: { name: "", sourceVenueId: "venue-42" } }));
  assert.equal(r.outcome, "needs_review");
  assert.equal(r.reasonCode, "event-no-venue-named");
  assert.equal(validateRecord({ record: event(), scope: { ...SCOPE, cityName: null }, country: null }).reasonCode, "city-unresolved");
});
