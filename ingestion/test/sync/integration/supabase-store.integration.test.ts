/**
 * OPT-IN Supabase integration test for SupabaseCanonicalStore.
 *
 * Skipped unless `SYNC_INTEGRATION=1`. When enabled it hits the REAL Supabase
 * project configured in `ingestion/.env` (service-role key), but is strictly
 * isolated:
 *
 *   - all rows it creates carry `source_id` = the `sync-int-test` data source;
 *   - `before` and `after` hard-delete ONLY rows with that `source_id`;
 *   - it never reads, writes or deletes any other data.
 *
 * There is only one Supabase project (production + pilot data), so this is the
 * safest possible real read-after-write proof. Run it deliberately:
 *
 *   SYNC_INTEGRATION=1 npm test
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig, loadEnvFile } from "../../../src/config.ts";
import { createServiceClient } from "../../../src/supabase.ts";
import { planSync } from "../../../src/sync/engine.ts";
import { SupabaseCanonicalStore } from "../../../src/sync/supabase-store.ts";
import {
  DEFAULT_RECONCILIATION,
  InMemoryConfigProvider,
  type SyncConfig,
} from "../../../src/sync/config.ts";
import { createInMemoryAdapter } from "../../../src/sync/adapters/in-memory.ts";
import type { NormalizedRecord, VenueFields } from "../../../src/sync/types.ts";

const ENABLED = process.env.SYNC_INTEGRATION === "1";
const TEST_SOURCE = "sync-int-test";
const EXTERNAL_ID = "synctest-venue-001";

let db: SupabaseClient;
let testSourceId: string | null = null;
let cityName = "";
let countryCode = "";

async function purge(opts: { dropSource?: boolean } = {}): Promise<void> {
  if (!testSourceId) return;
  await db.from("events").delete().eq("source_id", testSourceId);
  await db.from("venues").delete().eq("source_id", testSourceId);
  if (opts.dropSource) {
    await db.from("data_sources").delete().eq("id", testSourceId);
    testSourceId = null;
  }
}

before(async () => {
  if (!ENABLED) return;
  loadEnvFile();
  db = createServiceClient(loadConfig());

  const src = await db.from("data_sources").select("id").eq("name", TEST_SOURCE).maybeSingle();
  if (src.error) throw new Error(`data_sources read: ${src.error.message}`);
  if (src.data?.id) testSourceId = String(src.data.id);
  else {
    const created = await db
      .from("data_sources")
      .insert({ name: TEST_SOURCE, type: "manual" })
      .select("id")
      .single();
    if (created.error) throw new Error(`data_sources insert: ${created.error.message}`);
    testSourceId = String(created.data.id);
  }
  await purge();

  const cities = await db.from("cities").select("name, country_id").limit(1);
  if (cities.error || !cities.data?.length) {
    throw new Error(`cities read failed or empty: ${cities.error?.message}`);
  }
  cityName = String(cities.data[0].name);
  countryCode = String(cities.data[0].country_id);
});

after(async () => {
  if (!ENABLED) return;
  await purge({ dropSource: true });
});

function config(): InMemoryConfigProvider {
  const cfg: SyncConfig = {
    countries: [
      {
        code: countryCode,
        name: countryCode,
        enabled: true,
        defaultTimeZone: "Europe/Belgrade",
        bounds: null,
        normalizationProfile: countryCode === "RS" ? "sr" : "latin",
        extraPlaceholderPatterns: [],
      },
    ],
    cities: [
      {
        countryCode,
        canonicalName: cityName,
        enabled: true,
        eventFirstEnabled: true,
        timeZone: "Europe/Belgrade",
        nameAliases: [cityName.toLowerCase()],
        bounds: null,
        sourceScope: {},
      },
    ],
    sources: [
      {
        key: TEST_SOURCE,
        adapter: "in-memory",
        kinds: ["venue"],
        enabled: true,
        trusted: true,
        tos: "permitted",
        scope: { countries: [countryCode], cities: [] },
        schedule: null,
        rateLimit: null,
        fieldTrust: {},
        settings: {},
      },
    ],
    venueAliases: [],
    reconciliation: DEFAULT_RECONCILIATION,
  };
  return new InMemoryConfigProvider(cfg);
}

function venueItem(closingTime: string): { externalId: string; kind: "venue"; payload: NormalizedRecord } {
  const fields: VenueFields = {
    name: "SYNC-INT Example Club",
    normalizedName: "",
    address: null,
    coordinates: null,
    coordinatesSource: null,
    website: null,
    wikidata: null,
    openingHours: null,
    description: null,
    openingTime: null,
    closingTime,
    isActive: false, // isolated + inert
  };
  return {
    externalId: EXTERNAL_ID,
    kind: "venue",
    payload: {
      kind: "venue",
      provenance: {
        sourceKey: TEST_SOURCE,
        externalId: EXTERNAL_ID,
        sourceUrl: null,
        contentHash: "",
        confidence: 1,
        fetchedAt: new Date().toISOString(),
        reported: {},
      },
      scope: { countryCode, cityText: cityName, coordinates: null },
      fields,
      links: {},
    },
  };
}

test("real Supabase: NEW -> UPDATED -> UNCHANGED, read-after-write", { skip: !ENABLED }, async () => {
  const store = new SupabaseCanonicalStore(db);
  const src = config().source(TEST_SOURCE)!;
  const run = async (closingTime: string, runId: string) => {
    const adapter = createInMemoryAdapter({ key: TEST_SOURCE, items: [venueItem(closingTime)] });
    const plan = await planSync({
      adapter,
      source: src,
      config: config(),
      store,
      now: new Date().toISOString(),
      runId,
    });
    const res = await store.apply(plan, { commit: true });
    assert.equal(res.error, null, JSON.stringify(res.error));
    return { plan, res };
  };

  // NEW
  const a = await run("03:00", "int-1");
  assert.equal(a.plan.upserts[0]?.changeStatus, "NEW");
  assert.equal(a.res.inserted, 1);
  let back = await store.getVenueBySource(TEST_SOURCE, EXTERNAL_ID);
  assert.equal(back?.name, "SYNC-INT Example Club");
  assert.equal(back?.closingTime, "03:00");
  const insertedId = back!.id;
  const insertedUpdatedAt = back!.updatedAt;

  // UPDATED
  const b = await run("04:00", "int-2");
  assert.equal(b.plan.upserts[0]?.changeStatus, "UPDATED");
  assert.deepEqual(b.plan.upserts[0]?.fieldDeltas, [
    { field: "closingTime", from: "03:00", to: "04:00" },
  ]);
  assert.equal(b.res.updated, 1);
  back = await store.getVenueBySource(TEST_SOURCE, EXTERNAL_ID);
  assert.equal(back?.id, insertedId, "same canonical row");
  assert.equal(back?.closingTime, "04:00");
  assert.equal(back?.name, "SYNC-INT Example Club", "unrelated field preserved");
  assert.notEqual(back?.updatedAt, insertedUpdatedAt, "updated_at advanced");
  const updatedUpdatedAt = back!.updatedAt;

  // UNCHANGED
  const c = await run("04:00", "int-3");
  assert.equal(c.plan.upserts[0]?.changeStatus, "UNCHANGED");
  assert.equal(c.res.updated, 0);
  back = await store.getVenueBySource(TEST_SOURCE, EXTERNAL_ID);
  assert.equal(back?.updatedAt, updatedUpdatedAt, "UNCHANGED does not bump updated_at");
  assert.equal(back?.closingTime, "04:00");
});

test("(sync integration disabled — set SYNC_INTEGRATION=1 to run against real Supabase)", { skip: ENABLED }, () => {
  assert.ok(true);
});
