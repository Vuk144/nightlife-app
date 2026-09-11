/**
 * Characterization of the OSM venue-ingestion orchestrator
 * (`../src/ingest-venues.ts#ingestVenuesForTarget`).
 *
 * `planUpdate` is covered separately in `plan-update.test.ts`; this file pins
 * the end-to-end orchestration: dry-run write suppression, summary accounting,
 * the within-run "consume" rule, and the write column set — driven through the
 * REAL query/parse/normalize/classify/match pipeline with a stubbed `fetch`
 * (no network) and the in-memory `FakeSupabase` (no database).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSupabase } from "./sync/fake-supabase.ts";
import { ingestVenuesForTarget } from "../src/ingest-venues.ts";
import type { IngestionTarget } from "../src/targets.ts";
import type { Config } from "../src/config.ts";
import type { OverpassElement } from "../src/types.ts";

const TARGET: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const CONFIG = {
  supabaseUrl: "http://stub.supabase",
  supabaseServiceRoleKey: "stub-key",
  overpassUrl: "http://stub.overpass/api",
  overpassUserAgent: "ingest-venues-test/1",
} satisfies Config;

/** Replace global fetch with one canned Overpass 200 response. Returns a restore fn. */
function stubOverpass(elements: OverpassElement[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ elements }),
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function node(id: number, tags: Record<string, string>, lat = 44.81, lon = 20.46): OverpassElement {
  return { type: "node", id, lat, lon, tags };
}

function seededDb(opts: { dataSource?: boolean; venues?: Record<string, unknown>[] } = {}): FakeSupabase {
  const db = new FakeSupabase();
  if (opts.dataSource ?? true) db.seed("data_sources", [{ id: "src-osm", name: "OpenStreetMap" }]);
  db.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  db.seed("venues", opts.venues ?? []);
  return db;
}

function existingVenue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "v-1",
    city_id: "city-bg",
    name: "Akademija",
    name_normalized: "akademija",
    source_id: null,
    external_id: null,
    source_url: null,
    latitude: null,
    longitude: null,
    coordinates_source: null,
    address: null,
    website: null,
    opening_hours: null,
    wikidata: null,
    ...over,
  };
}

// ── dry run: no writes ───────────────────────────────────────────────

test("[dry-run] performs ZERO database writes (data_sources row present)", async () => {
  const db = seededDb({ venues: [existingVenue()] });
  const restore = stubOverpass([
    node(1, { amenity: "bar", name: "Akademija" }),        // -> Tier 2 match -> update (no write)
    node(2, { amenity: "nightclub", name: "Brand New Club" }), // -> new (no write)
  ]);
  try {
    const { summary } = await ingestVenuesForTarget(db.asClient(), CONFIG, TARGET, { dryRun: true });
    assert.equal(db.writes.length, 0, `expected no writes, got ${JSON.stringify(db.writes)}`);
    assert.equal(summary.inserted, 1);
    assert.equal(summary.updated + summary.unchanged, 1);
  } finally {
    restore();
  }
});

test("[dry-run] backfills name_normalized IN MEMORY so matching works, but writes nothing", async () => {
  // existing row seeded WITHOUT name_normalized -> Tier 2 can only match it if
  // backfillNameNormalized fills it in memory during the run.
  const db = seededDb({ venues: [existingVenue({ name_normalized: null })] });
  const restore = stubOverpass([node(1, { amenity: "bar", name: "Akademija" })]);
  try {
    const { summary } = await ingestVenuesForTarget(db.asClient(), CONFIG, TARGET, { dryRun: true });
    assert.equal(db.writes.length, 0);
    assert.equal(summary.inserted, 0, "must match the backfilled row, not insert a duplicate");
    assert.equal(summary.updated + summary.unchanged, 1);
  } finally {
    restore();
  }
});

// ── summary accounting ───────────────────────────────────────────────

test("[accounting] fetched == invalid + excluded + accepted, and there is exactly one action per element", async () => {
  const db = seededDb();
  const restore = stubOverpass([
    node(1, { amenity: "bar", name: "Real Bar" }),          // accepted -> new
    node(2, { amenity: "bar" }),                             // invalid  -> missing name
    node(3, { shop: "supermarket", name: "Maxi" }),          // excluded -> shop=supermarket
  ]);
  try {
    const { summary, actions } = await ingestVenuesForTarget(db.asClient(), CONFIG, TARGET, { dryRun: true });
    assert.equal(summary.fetched, 3);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.excluded, 1);
    assert.equal(summary.inserted + summary.updated + summary.unchanged + summary.skipped, 1);
    assert.equal(
      summary.fetched,
      summary.invalid + summary.excluded + summary.inserted + summary.updated + summary.unchanged + summary.skipped,
    );
    assert.equal(actions.length, 3);
    assert.equal(actions.filter((a) => a.kind === "invalid").length, 1);
    assert.equal(actions.filter((a) => a.kind === "excluded").length, 1);
  } finally {
    restore();
  }
});

// ── within-run "consume" ─────────────────────────────────────────────

test("[consume] a 2nd element sharing a just-matched venue's normalized name becomes a NEW venue", async () => {
  const db = seededDb({ venues: [existingVenue()] }); // one "Akademija"
  const restore = stubOverpass([
    node(1, { amenity: "bar", name: "Akademija" }, 44.8100, 20.4600),
    node(2, { amenity: "bar", name: "Akademija" }, 44.8200, 20.4700),
  ]);
  try {
    const { summary, actions } = await ingestVenuesForTarget(db.asClient(), CONFIG, TARGET, { dryRun: true });
    assert.equal(summary.updated + summary.unchanged, 1, "the single existing row is consumed once");
    assert.equal(summary.inserted, 1, "the second same-name element falls through to new");
    assert.equal(actions.filter((a) => a.kind === "insert").length, 1);
    assert.equal(actions.filter((a) => a.kind === "update" || a.kind === "unchanged").length, 1);
  } finally {
    restore();
  }
});

// ── real run: the write column set ──────────────────────────────────

test("[write] a real run inserts new venues and updates matched ones with the documented columns", async () => {
  const db = seededDb({ venues: [existingVenue()] });
  const restore = stubOverpass([
    node(1, { amenity: "bar", name: "Akademija", website: "https://akademija.example" }),
    node(2, { amenity: "nightclub", name: "Novi Klub" }),
  ]);
  try {
    const { summary } = await ingestVenuesForTarget(db.asClient(), CONFIG, TARGET, { dryRun: false });
    assert.equal(summary.inserted, 1);
    assert.equal(summary.updated, 1);

    const inserts = db.writes.filter((w) => w.table === "venues" && w.op === "insert");
    assert.equal(inserts.length, 1);
    const row = inserts[0].values;
    assert.equal(row.city_id, "city-bg");
    assert.equal(row.name, "Novi Klub");
    assert.equal(row.coordinates_source, "source");
    assert.equal(row.source_id, "src-osm");
    assert.equal(row.external_id, "node/2");
    assert.equal(row.is_active, true);
    assert.ok(typeof row.last_synced_at === "string" && row.last_synced_at.length > 0);
    assert.ok("name_normalized" in row);

    const updates = db.writes.filter((w) => w.table === "venues" && w.op === "update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].values.source_id, "src-osm");
    assert.equal(updates[0].values.external_id, "node/1");
    assert.equal(updates[0].values.website, "https://akademija.example");
    assert.ok("last_synced_at" in updates[0].values);
    // name / name_normalized are never rewritten on an existing venue
    assert.equal("name" in updates[0].values, false);
    assert.equal("name_normalized" in updates[0].values, false);
  } finally {
    restore();
  }
});

// ── latent: dry run is not fully write-free on a virgin database ─────

test("[dry-run][latent] resolveOsmSourceId bootstrap-INSERTS the OSM data_sources row even on a dry run", async () => {
  // The OSM `data_sources` row is seeded by migration 20260907150000 (the same
  // migration that adds the venue columns this runner needs), so on any real
  // deployment `resolveOsmSourceId` only ever SELECTs. But the function takes no
  // `dryRun` flag: against a database missing that row, a dry run writes it.
  const db = seededDb({ dataSource: false });
  const restore = stubOverpass([]);
  try {
    await ingestVenuesForTarget(db.asClient(), CONFIG, TARGET, { dryRun: true });
    const dsInserts = db.writes.filter((w) => w.table === "data_sources" && w.op === "insert");
    assert.equal(dsInserts.length, 1, "documents the dry-run write; unreachable when the migration seed is present");
  } finally {
    restore();
  }
});
