/**
 * `../../src/sync/adapters/in-memory.ts#createInMemoryAdapter` — the test/proof
 * `SourceAdapter`. It is used everywhere but its own contract was untested.
 *
 * A real adapter fetches + parses over HTTP and hands the engine a brand-new
 * object every time; this double must behave the same — pure, deterministic,
 * no shared references to its own fixtures, no process-timezone dependence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import type { AdapterContext, NormalizedRecord, SourceItemRef } from "../../src/sync/types.ts";

const CTX = {} as AdapterContext;

type VenueRecord = Extract<NormalizedRecord, { kind: "venue" }>;

function venueRec(name = "Klub X"): VenueRecord {
  return {
    kind: "venue",
    provenance: {
      sourceKey: "s",
      externalId: "v1",
      sourceUrl: null,
      confidence: 1,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      reported: {},
    },
    scope: { countryCode: "HR", cityText: "Zagreb", coordinates: { latitude: 45.8, longitude: 15.9 } },
    fields: {
      name,
      normalizedName: name.toLowerCase(),
      address: "Ilica 1",
      coordinates: { latitude: 45.8, longitude: 15.9 },
      coordinatesSource: "source",
      website: null,
      wikidata: null,
      openingHours: null,
    },
    links: {},
  };
}

async function collect(it: AsyncIterable<SourceItemRef>): Promise<SourceItemRef[]> {
  const out: SourceItemRef[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ── parse returns a fresh object (already correct — pin it) ─────────
test("parse() returns a fresh deep copy, never a reference to the fixture payload", () => {
  const payload = venueRec();
  const adapter = createInMemoryAdapter({ key: "k", items: [{ externalId: "v1", kind: "venue", payload }] });
  const raw = { ref: {} as SourceItemRef, url: "u", status: 200, body: JSON.stringify(payload), contentType: "application/json", fetchedAt: "x" };
  const p = adapter.parse(raw, CTX);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.notEqual(p.records[0], payload);
  if (p.records[0].kind === "venue") p.records[0].fields.name = "MUTATED";
  assert.equal(payload.fields.name, "Klub X", "mutating the parsed record must not touch the fixture");
});

// ── fetchLinked returns a fresh object (the fixed bug) ─────────────
test("fetchLinked() returns a FRESH deep copy each call — no shared reference to the fixture", async () => {
  const record = venueRec("Novi Klub");
  const adapter = createInMemoryAdapter({ key: "k", items: [], venuePages: [{ externalId: "vp1", record }] });

  const l1 = await adapter.fetchLinked!("venue", "vp1", CTX);
  const l2 = await adapter.fetchLinked!("venue", "vp1", CTX);

  assert.ok(l1 && l2);
  assert.notEqual(l1, record, "must not be the fixture object");
  assert.notEqual(l1, l2, "each call is a fresh object (like a real fetch+parse)");
  assert.deepEqual(l1, l2, "…but structurally identical");

  if (l1 && l1.kind === "venue") l1.fields.name = "MUTATED";
  assert.equal(record.fields.name, "Novi Klub", "fixture untouched");
  assert.equal(
    l2 && l2.kind === "venue" ? l2.fields.name : null,
    "Novi Klub",
    "a second fetchLinked result is unaffected by mutating the first",
  );
});

test("fetchLinked() nested objects are deep-copied (coordinates are not shared)", async () => {
  const record = venueRec();
  const adapter = createInMemoryAdapter({ key: "k", items: [], venuePages: [{ externalId: "vp1", record }] });
  const l = await adapter.fetchLinked!("venue", "vp1", CTX);
  assert.ok(l && l.kind === "venue");
  if (l && l.kind === "venue") {
    assert.notEqual(l.fields.coordinates, record.fields.coordinates);
    assert.deepEqual(l.fields.coordinates, { latitude: 45.8, longitude: 15.9 });
  }
});

test("fetchLinked() returns null for a non-venue kind or an unknown id", async () => {
  const adapter = createInMemoryAdapter({
    key: "k",
    items: [],
    venuePages: [{ externalId: "vp1", record: venueRec() }],
  });
  assert.equal(await adapter.fetchLinked!("event", "vp1", CTX), null);
  assert.equal(await adapter.fetchLinked!("venue", "nope", CTX), null);
});

// ── discover: deterministic, order-preserving, failure path ───────
test("discover() yields refs in items order, and is repeatable", async () => {
  const adapter = createInMemoryAdapter({
    key: "src",
    items: [
      { externalId: "a", kind: "venue", payload: venueRec("A") },
      { externalId: "b", kind: "event", payload: venueRec("B") },
      { externalId: "c", kind: "venue", payload: venueRec("C") },
    ],
  });
  const first = (await collect(adapter.discover(CTX))).map((r) => r.externalId);
  const second = (await collect(adapter.discover(CTX))).map((r) => r.externalId);
  assert.deepEqual(first, ["a", "b", "c"]);
  assert.deepEqual(first, second);
});

test("discover() throws the simulated outage when failDiscovery is set", async () => {
  const adapter = createInMemoryAdapter({ key: "src", items: [], failDiscovery: true });
  await assert.rejects(collect(adapter.discover(CTX)), /simulated source outage/);
});

// ── fetch: unknown id -> 404 -> parse fails distinctly ────────────
test("fetch() returns 404 for an unknown externalId; parse() then reports http-404 (not a valid empty result)", async () => {
  const adapter = createInMemoryAdapter({ key: "src", items: [{ externalId: "known", kind: "venue", payload: venueRec() }] });
  const raw = await adapter.fetch({ url: "u", externalId: "missing", kindHint: null, lastModified: null }, CTX);
  assert.equal(raw.status, 404);
  const p = adapter.parse(raw, CTX);
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.reason, /404/);
});

// ── capabilities derived from the fixtures ────────────────────────
test("capabilities.kinds is derived from items; givesVenuePages reflects venuePages", () => {
  const a = createInMemoryAdapter({
    key: "k",
    items: [
      { externalId: "1", kind: "venue", payload: venueRec() },
      { externalId: "2", kind: "event", payload: venueRec() },
      { externalId: "3", kind: "venue", payload: venueRec() },
    ],
  });
  assert.deepEqual(a.capabilities.kinds, ["venue", "event"]); // de-duped, first-seen order
  assert.equal(a.capabilities.givesVenuePages, false);

  const b = createInMemoryAdapter({ key: "k", items: [], venuePages: [{ externalId: "x", record: venueRec() }] });
  assert.equal(b.capabilities.givesVenuePages, true);

  const c = createInMemoryAdapter({ key: "k", items: [], capabilities: { emitsCancellations: false } });
  assert.equal(c.capabilities.emitsCancellations, false, "explicit override wins");
});

// ── purity / no hidden state ─────────────────────────────────────
test("the adapter never mutates the options it was given", async () => {
  const items = [{ externalId: "v1", kind: "venue" as const, payload: venueRec() }];
  const venuePages = [{ externalId: "vp1", record: venueRec("VP") }];
  const itemsSnapshot = JSON.stringify(items);
  const pagesSnapshot = JSON.stringify(venuePages);

  const adapter = createInMemoryAdapter({ key: "k", items, venuePages });
  await collect(adapter.discover(CTX));
  const raw = await adapter.fetch({ url: "u", externalId: "v1", kindHint: null, lastModified: null }, CTX);
  const p = adapter.parse(raw, CTX);
  if (p.ok && p.records[0].kind === "venue") p.records[0].fields.name = "changed";
  const linked = await adapter.fetchLinked!("venue", "vp1", CTX);
  if (linked && linked.kind === "venue") linked.fields.name = "changed too";

  assert.equal(JSON.stringify(items), itemsSnapshot);
  assert.equal(JSON.stringify(venuePages), pagesSnapshot);
});

test("fetch().fetchedAt is a fixed literal — no process-timezone / clock dependence", async () => {
  const saved = process.env.TZ;
  try {
    const adapter = createInMemoryAdapter({ key: "k", items: [{ externalId: "v1", kind: "venue", payload: venueRec() }] });
    for (const tz of ["UTC", "Asia/Tokyo", "America/New_York"]) {
      process.env.TZ = tz;
      const raw = await adapter.fetch({ url: "u", externalId: "v1", kindHint: null, lastModified: null }, CTX);
      assert.equal(raw.fetchedAt, "2026-01-01T00:00:00.000Z", `TZ=${tz}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});
