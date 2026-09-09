/**
 * ZAGREB TEST — proves the generic engine processes Croatia / Zagreb through
 * exactly the same code path as Serbia / Belgrade, with no city-specific or
 * country-specific business logic.
 *
 * Also covers the 10 architecture checks from the task.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planSync } from "../../src/sync/engine.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import {
  CONFIG,
  CITY_IDS,
  eventRecord,
  fakeItem,
  provider,
  seededStore,
  venuePage,
  venueRecord,
} from "./world.ts";

const NOW = "2026-06-01T00:00:00.000Z";
const cfg = () => provider();
const src = (key: string) => provider().source(key)!;

// ── 1 & 2 & 3 & 10: venue-first, multi-city, no coordinates ────────────
test("[1][2][3][10] one venue source, venues in Belgrade + Zagreb resolve to their OWN city's canonical venue", async () => {
  const store = seededStore();
  const adapter = createInMemoryAdapter({
    key: "osm",
    items: [
      fakeItem(venueRecord({ sourceKey: "osm", externalId: "osm-1", countryCode: "HR", cityText: "Zagreb", name: "Tvornica" })),
      fakeItem(venueRecord({ sourceKey: "osm", externalId: "osm-2", countryCode: "RS", cityText: "Beograd", name: "Tvornica" })),
    ],
  });

  const plan = await planSync({ adapter, source: src("osm"), config: cfg(), store, now: NOW, runId: "r1" });

  const zg = plan.upserts.find((u) => u.record.provenance.externalId === "osm-1")!;
  const bg = plan.upserts.find((u) => u.record.provenance.externalId === "osm-2")!;

  // [1] each matched by exact normalized name in its own city
  assert.equal(zg.identity.decision, "matched");
  assert.equal(zg.identity.canonicalId, "v-zg-tvornica");
  assert.equal(zg.identity.tier, 2);
  assert.equal(bg.identity.decision, "matched");
  assert.equal(bg.identity.canonicalId, "v-bg-tvornica");

  // [2] same name, different cities → different canonical rows, no new venue created
  assert.notEqual(zg.identity.canonicalId, bg.identity.canonicalId);
  assert.equal(plan.upserts.filter((u) => u.operation === "insert").length, 0);

  // [3] matched with NO coordinates in the incoming record
  assert.equal((zg.record.kind === "venue" && zg.record.fields.coordinates) || null, null);

  // [10] Zagreb ran through the same planSync, same stats shape, no error
  assert.equal(plan.stats.status, "ok");
  assert.equal(plan.stats.venuesMatched, 2);
});

// ── 4: a new venue becomes a candidate (event-first, no OSM) ───────────
test("[4] an event whose venue is unknown produces a safe new-venue candidate (enriched from the source's venue page)", async () => {
  const store = seededStore();
  const adapter = createInMemoryAdapter({
    key: "entrio-hr",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "entrio-hr",
          externalId: "E-new",
          countryCode: "HR",
          cityText: "Zagreb",
          title: "Opening Rave",
          startLocal: "2026-07-04T23:00",
          venueName: "Novi Klub XYZ",
          sourceVenueId: "novi-klub-xyz",
        }),
      ),
    ],
    venuePages: [
      venuePage("novi-klub-xyz", {
        kind: "venue",
        provenance: {
          sourceKey: "entrio-hr",
          externalId: "novi-klub-xyz",
          sourceUrl: "memory://entrio-hr/venue/novi-klub-xyz",
          contentHash: "vp-hash",
          confidence: 0.95,
          fetchedAt: NOW,
          reported: {},
        },
        scope: { countryCode: "HR", cityText: "Zagreb", coordinates: { latitude: 45.81, longitude: 15.98 } },
        fields: {
          name: "Novi Klub XYZ",
          normalizedName: "",
          address: "Ilica 100, Zagreb",
          coordinates: { latitude: 45.81, longitude: 15.98 },
          coordinatesSource: "source",
          website: null,
          wikidata: null,
          openingHours: null,
        },
        links: {},
      }),
    ],
  });

  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r1" });

  const venueUpsert = plan.upserts.find((u) => u.kind === "venue")!;
  assert.equal(venueUpsert.operation, "insert");
  assert.equal(venueUpsert.changeStatus, "NEW");
  assert.equal(venueUpsert.identity.decision, "new_candidate");
  assert.equal(venueUpsert.record.kind, "venue");
  if (venueUpsert.record.kind === "venue") {
    assert.equal(venueUpsert.record.fields.address, "Ilica 100, Zagreb");
    assert.deepEqual(venueUpsert.record.fields.coordinates, { latitude: 45.81, longitude: 15.98 });
  }
  assert.equal(plan.stats.venuesNew, 1);
});

// ── 5: same event, same source, twice → still one event ───────────────
test("[5] the same event from the same source stays the same canonical event", async () => {
  const store = seededStore();
  const ev = () =>
    eventRecord({
      sourceKey: "entrio-hr",
      externalId: "E1",
      countryCode: "HR",
      cityText: "Zagreb",
      title: "DJ Night",
      startLocal: "2026-07-01T22:00",
      ticketUrl: "https://tickets.example/e/55555",
      venueName: "Tvornica",
      sourceVenueId: "tvornica",
    });

  const run = async (runId: string) => {
    const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [fakeItem(ev())] });
    const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId });
    await store.apply(plan, { commit: true });
    return plan;
  };

  const p1 = await run("r1");
  assert.equal(p1.upserts.find((u) => u.kind === "event")!.operation, "insert");
  assert.equal(store.events.length, 1);

  const p2 = await run("r2");
  const e2 = p2.upserts.find((u) => u.kind === "event")!;
  assert.equal(e2.identity.tier, 0, "tier 0 = same source key + external id");
  assert.equal(e2.operation, "link-only");
  assert.equal(store.events.length, 1, "no second canonical event");
});

// ── 6: same real event from a different source → same canonical ───────
test("[6] the same real event from a SECOND source resolves to the same canonical event", async () => {
  const store = seededStore();
  const ticket = "https://tickets.example/e/55555";

  const a1 = createInMemoryAdapter({
    key: "entrio-hr",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "entrio-hr",
          externalId: "E1",
          countryCode: "HR",
          cityText: "Zagreb",
          title: "Boris Brejcha",
          startLocal: "2026-07-01T22:00",
          ticketUrl: ticket,
          venueName: "Tvornica",
          sourceVenueId: "tvornica",
        }),
      ),
    ],
  });
  const p1 = await planSync({ adapter: a1, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r1" });
  await store.apply(p1, { commit: true });
  assert.equal(store.events.length, 1);
  const canonicalId = store.events[0].id;

  // second source, same night, same venue, same ticket id, slightly different title
  const a2 = createInMemoryAdapter({
    key: "cooltix",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "cooltix",
          externalId: "C-9",
          countryCode: "HR",
          cityText: "Zagreb",
          title: "Boris Brejcha live @ Tvornica",
          startLocal: "2026-07-01T22:30",
          ticketUrl: ticket,
          venueName: "Tvornica",
          sourceVenueId: "tvornica",
        }),
      ),
    ],
  });
  const p2 = await planSync({ adapter: a2, source: src("cooltix"), config: cfg(), store, now: NOW, runId: "r2" });
  const e = p2.upserts.find((u) => u.kind === "event")!;
  assert.equal(e.identity.decision, "matched");
  assert.equal(e.identity.tier, 2, "tier 2 = same venue + same night + shared ticket id");
  assert.equal(e.identity.canonicalId, canonicalId);
  assert.equal(e.operation, "link-only");

  await store.apply(p2, { commit: true });
  assert.equal(store.events.length, 1, "still one canonical event");
  assert.equal(store.links.filter((l) => l.kind === "event" && l.canonicalId === canonicalId).length, 2);
});

// ── 7 & 8: change detection ──────────────────────────────────────────
test("[7][8] changed event fields → UPDATED; identical fields → UNCHANGED", async () => {
  const store = seededStore();
  const base = {
    sourceKey: "entrio-hr" as const,
    externalId: "E1",
    countryCode: "HR",
    cityText: "Zagreb",
    title: "DJ Night",
    ticketUrl: "https://tickets.example/e/55555",
    venueName: "Tvornica",
    sourceVenueId: "tvornica",
  };

  const runWith = async (startLocal: string, runId: string) => {
    const adapter = createInMemoryAdapter({
      key: "entrio-hr",
      items: [fakeItem(eventRecord({ ...base, startLocal }))],
    });
    const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId });
    await store.apply(plan, { commit: true });
    return plan;
  };

  await runWith("2026-07-01T22:00", "r1"); // NEW

  const same = await runWith("2026-07-01T22:00", "r2");
  const u1 = same.upserts.find((u) => u.kind === "event")!;
  assert.equal(u1.changeStatus, "UNCHANGED");
  assert.deepEqual(u1.fieldDeltas, []);
  assert.equal(u1.operation, "link-only");

  const changed = await runWith("2026-07-01T23:30", "r3");
  const u2 = changed.upserts.find((u) => u.kind === "event")!;
  assert.equal(u2.changeStatus, "UPDATED");
  // change detection compares the stable UTC instant (what events.start_at stores)
  assert.ok(u2.fieldDeltas.some((d) => d.field === "startInstant"));
  assert.equal(u2.operation, "update");

  // section H: the canonical row is now updated → an app read sees the new time
  const eventId = store.events[0].id;
  assert.equal((await store.getEventById(eventId))!.startLocal, "2026-07-01T23:30");
});

// ── 9: source failure never reconciles ──────────────────────────────
test("[9] a failed source run does NOT reconcile or touch any record", async () => {
  const store = seededStore();
  // seed an existing active source-link that COULD be marked missing
  store.links.push({
    id: "seed-link",
    kind: "event",
    sourceKey: "entrio-hr",
    externalId: "OLD-1",
    sourceUrl: null,
    canonicalId: "ev-old",
    contentHash: "h",
    comparableFields: {},
    reported: {},
    firstSeenAt: "2026-05-01T00:00:00.000Z",
    lastSeenAt: "2026-05-20T00:00:00.000Z",
    lastSyncedAt: "2026-05-20T00:00:00.000Z",
    sourceStatus: "active",
    consecutiveMisses: 0,
  });

  const adapter = createInMemoryAdapter({ key: "entrio-hr", items: [], failDiscovery: true });
  const plan = await planSync({ adapter, source: src("entrio-hr"), config: cfg(), store, now: NOW, runId: "r1" });

  assert.equal(plan.stats.status, "failed");
  assert.equal(plan.reconciliation.reconciled, false);
  assert.deepEqual(plan.reconciliation.actions, []);

  await store.apply(plan, { commit: true });
  assert.equal(store.links.find((l) => l.externalId === "OLD-1")!.sourceStatus, "active");
});

// ── the engine core contains no geography branches ──────────────────
test("engine core modules contain no country / city name and no `x === \"City\"` branch", () => {
  const files = [
    "engine.ts",
    "venue-identity.ts",
    "event-identity.ts",
    "change-detection.ts",
    "reconcile.ts",
    "validation.ts",
  ];
  const forbidden =
    /\b(Belgrade|Beograd|Zagreb|Serbia|Croatia|Srbija|Hrvatska|Budapest|Berlin)\b|(city|country|cityName|countryCode)\s*===\s*["'][A-Z]/;
  for (const f of files) {
    const src = readFileSync(
      new URL(`../../src/sync/${f}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(src, forbidden, `${f} must not branch on geography`);
  }
});

// ── config-driven city resolution: adding Zagreb was data only ──────
test("resolveCity is data-driven: Zagreb and its aliases resolve with zero code changes", () => {
  const p = provider();
  assert.equal(p.resolveCity("HR", "Zagreb")?.city.canonicalName, "Zagreb");
  assert.equal(p.resolveCity("RS", "Beograd")?.city.canonicalName, "Belgrade"); // exonym alias
  assert.equal(p.resolveCity("HU", "Budimpešta")?.city.canonicalName, "Budapest");
  assert.equal(p.resolveCity("HR", "Zagreb")?.city.eventFirstEnabled, true);
  // a city not in config does not resolve — no silent default
  assert.equal(p.resolveCity("HR", "Karlovac"), null);
  // config carries the four required expansion countries
  const codes = CONFIG.countries.map((c) => c.code).sort();
  assert.deepEqual(codes, ["DE", "HR", "HU", "RS"]);
});
