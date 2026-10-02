/**
 * `npm run sync:osm` — `../../src/sync/osm-cli.ts` (wiring + CLI) and
 * `../../src/sync/runner.ts` (plan → optional apply).
 *
 * The Overpass transport and the store are injected: the real
 * `SupabaseCanonicalStore` runs over `FakeSupabase`, whose `writes` log proves
 * which modes write. Nothing here touches the network or a real database. The
 * last tests spawn the real entry file only on paths that fail before any I/O.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOsmSyncArgs, runOsmSyncCli, type OsmSyncCliDeps } from "../../src/sync/osm-cli.ts";
import { commitRefusal, runSync } from "../../src/sync/runner.ts";
import { OSM_SOURCE_KEY, createOsmConfigProvider, createOsmOverpassAdapter } from "../../src/sync/adapters/osm-overpass.ts";
import { InMemoryCanonicalStore, type CanonicalStore } from "../../src/sync/store.ts";
import { SupabaseCanonicalStore } from "../../src/sync/supabase-store.ts";
import { parseOverpassVenues } from "../../src/sources/osm-overpass.ts";
import { FakeSupabase } from "./fake-supabase.ts";
import type { IngestionTarget } from "../../src/targets.ts";
import type { OverpassResponse } from "../../src/types.ts";
import type { SyncPlan } from "../../src/sync/types.ts";

const INGESTION_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/overpass-belgrade.sample.json", import.meta.url), "utf8"),
) as OverpassResponse;
const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2728438 };
const ACCEPTED = parseOverpassVenues(FIXTURE, BELGRADE).venues.length;
const NOW = "2026-09-27T00:00:00.000Z";
/** Stand-in for the service-role key: must never appear in any output. */
const SENTINEL_KEY = "SENTINEL-osm-sync-svc-role-must-never-be-printed-k3x";
const ENV = { SUPABASE_URL: "https://project.example.invalid", SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY };

function fakeDb(): FakeSupabase {
  const fake = new FakeSupabase();
  fake.seed("countries", [{ id: "RS", name: "Serbia" }]);
  fake.seed("cities", [{ id: "city-bg", country_id: "RS", name: "Belgrade" }]);
  fake.seed("data_sources", [{ id: "ds-osm", name: OSM_SOURCE_KEY, type: "api" }]);
  return fake;
}

/** The real Supabase store over the fake, with every `apply` call recorded. */
function spiedStore(fake: FakeSupabase) {
  const store = new SupabaseCanonicalStore(fake.asClient(), { now: () => NOW });
  const applyCalls: { commit: boolean }[] = [];
  const original = store.apply.bind(store);
  store.apply = async (plan: SyncPlan, opts: { commit: boolean }) => {
    applyCalls.push(opts);
    return original(plan, opts);
  };
  return { store, applyCalls };
}

interface CliRun {
  code: number;
  text: string;
  storeCreated: number;
  transportCalls: number;
  envLoaded: number;
}

async function cli(
  argv: string[],
  opts: { store?: CanonicalStore; response?: OverpassResponse | (() => Promise<OverpassResponse>); env?: NodeJS.ProcessEnv } = {},
): Promise<CliRun> {
  const lines: string[] = [];
  const run = { storeCreated: 0, transportCalls: 0, envLoaded: 0 };
  const response = opts.response ?? FIXTURE;
  const deps: OsmSyncCliDeps = {
    env: opts.env ?? ENV,
    loadEnvFile: () => {
      run.envLoaded++;
      return { path: "/nowhere/.env", existed: false, parsedKeys: [] };
    },
    targets: [BELGRADE],
    createStore: () => {
      run.storeCreated++;
      return opts.store ?? spiedStore(fakeDb()).store;
    },
    transport: async () => {
      run.transportCalls++;
      return typeof response === "function" ? response() : response;
    },
    now: () => NOW,
    out: (t) => lines.push(t),
    err: (t) => lines.push(t),
  };
  const code = await runOsmSyncCli(argv, deps);
  return { code, text: lines.join("\n"), ...run };
}

// ── arguments ─────────────────────────────────────────────────────────────
test("[args] no arguments = PLAN ONLY; --commit is the only way to commit", () => {
  assert.deepEqual(parseOsmSyncArgs([]), { ok: true, mode: "plan" });
  assert.deepEqual(parseOsmSyncArgs(["--commit"]), { ok: true, mode: "commit" });
});

test("[args] any unknown / near-miss argument is an error, never silently ignored", () => {
  for (const argv of [["--dry-run"], ["--commit", "--city=Novi Sad"], ["commit"], ["--COMMIT"], ["--commit=true"], ["-c"], ["--verbose"]]) {
    const r = parseOsmSyncArgs(argv);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(argv)}`);
  }
});

test("[args] the CLI rejects an unknown argument before loading config, touching the store or the network", async () => {
  const r = await cli(["--commit", "--force"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /unknown argument "--force"/);
  assert.match(r.text, /Usage: npm run sync:osm/);
  assert.deepEqual([r.envLoaded, r.storeCreated, r.transportCalls], [0, 0, 0]);
});

// ── configuration ─────────────────────────────────────────────────────────
test("[config] missing Supabase configuration fails clearly before any sync — no store, no fetch, no key leak", async () => {
  for (const env of [
    { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY },
    { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: "  " },
    {},
  ]) {
    const r = await cli(["--commit"], { env });
    assert.equal(r.code, 1);
    assert.match(r.text, /Configuration error: Missing or empty required variable\(s\)/);
    assert.deepEqual([r.storeCreated, r.transportCalls], [0, 0]);
    assert.equal(r.text.includes(SENTINEL_KEY), false);
  }
});

test("[config] a write-capable run never falls back to an anon key: only the service-role key satisfies config", async () => {
  const r = await cli([], { env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_ANON_KEY: "anon", EXPO_PUBLIC_SUPABASE_ANON_KEY: "anon" } });
  assert.equal(r.code, 1);
  assert.match(r.text, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(r.storeCreated, 0);
});

// ── PLAN ONLY (default) ───────────────────────────────────────────────────
test("[plan] default invocation: full plan + report, ZERO database writes, apply never called", async () => {
  const fake = fakeDb();
  const { store, applyCalls } = spiedStore(fake);
  const r = await cli([], { store });
  assert.equal(r.code, 0);
  assert.equal(r.transportCalls, 1, "OSM was fetched");
  assert.deepEqual(fake.writes, [], "no insert / update of any table");
  assert.deepEqual(applyCalls, [], "apply is not called at all in plan mode");
  assert.equal(fake.tables.venues.length, 0);
  assert.match(r.text, /MODE: PLAN ONLY/);
  assert.match(r.text, /DATABASE WRITES: 0/);
  assert.doesNotMatch(r.text, /MODE: COMMIT/);
  assert.match(r.text, new RegExp(`inserts\\s+${ACCEPTED}\\b`));
  assert.match(r.text, /source:\s+OpenStreetMap/);
  assert.match(r.text, /targets: Belgrade \(RS, relation 2728438\)/);
  assert.equal(r.text.includes(SENTINEL_KEY), false);
});

test("[plan] plan mode creates no data_sources row even when the source row is missing", async () => {
  const fake = fakeDb();
  fake.seed("data_sources", []);
  const r = await cli([], { store: spiedStore(fake).store });
  assert.equal(r.code, 0);
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.tables.data_sources.length, 0);
});

// ── COMMIT ────────────────────────────────────────────────────────────────
test("[commit] --commit applies exactly once with commit=true through the store; the report says COMMIT", async () => {
  const fake = fakeDb();
  const { store, applyCalls } = spiedStore(fake);
  const r = await cli(["--commit"], { store });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(applyCalls, [{ commit: true }]);
  assert.equal(fake.tables.venues.length, ACCEPTED);
  assert.ok(fake.writes.every((w) => w.op === "insert" && w.table === "venues"), "only venue inserts on a fresh slate");
  assert.match(r.text, /MODE: COMMIT/);
  assert.match(r.text, /APPLY RESULT — committed=true/);
  assert.match(r.text, new RegExp(`inserted\\s+${ACCEPTED}\\b`));
  assert.doesNotMatch(r.text, /DATABASE WRITES: 0/);
});

test("[commit] after a commit, the next default run is PLAN ONLY, writes nothing, and plans all UNCHANGED", async () => {
  const fake = fakeDb();
  await cli(["--commit"], { store: spiedStore(fake).store });
  const writesAfterCommit = fake.writes.length;
  const { store, applyCalls } = spiedStore(fake);
  const r = await cli([], { store });
  assert.equal(fake.writes.length, writesAfterCommit);
  assert.deepEqual(applyCalls, []);
  assert.match(r.text, new RegExp(`unchanged\\s+${ACCEPTED}\\b`));
  assert.match(r.text, /inserts\s+0\b/);
});

// ── unsafe plans are never applied ────────────────────────────────────────
test("[safety] a FAILED plan (Overpass error) with --commit is refused: no apply, no writes, exit 1", async () => {
  const fake = fakeDb();
  const { store, applyCalls } = spiedStore(fake);
  const r = await cli(["--commit"], {
    store,
    response: async () => {
      throw new Error("Overpass returned an error remark: runtime error");
    },
  });
  assert.equal(r.code, 1);
  assert.deepEqual(applyCalls, []);
  assert.deepEqual(fake.writes, []);
  assert.match(r.text, /COMMIT REFUSED/);
  assert.match(r.text, /DATABASE WRITES: 0/);
});

test("[safety][7A] an EMPTY snapshot after a synced run: --commit refused, nothing written, reconciliation skipped with its reason", async () => {
  const fake = fakeDb();
  await cli(["--commit"], { store: spiedStore(fake).store });
  const before = fake.writes.length;
  const { store, applyCalls } = spiedStore(fake);
  const r = await cli(["--commit"], { store, response: { elements: [] } });
  assert.equal(r.code, 1);
  assert.deepEqual(applyCalls, []);
  assert.equal(fake.writes.length, before);
  assert.equal(fake.tables.venues.length, ACCEPTED, "nothing removed");
  assert.match(r.text, /reconciliation: SKIPPED/);
  assert.match(r.text, /reason: .*empty.*reconciliation skipped/);
  assert.doesNotMatch(r.text, /mark-stale|mark-missing|mark-gone/);
});

test("[safety][7A] a COLLAPSED snapshot: --commit refused even though the returned venues are valid", async () => {
  const fake = fakeDb();
  await cli(["--commit"], { store: spiedStore(fake).store });
  const before = fake.writes.length;
  const { store, applyCalls } = spiedStore(fake);
  const one: OverpassResponse = { elements: (FIXTURE.elements ?? []).filter((e) => e.id === 1001) };
  const r = await cli(["--commit"], { store, response: one });
  assert.equal(r.code, 1);
  assert.deepEqual(applyCalls, []);
  assert.equal(fake.writes.length, before);
  assert.match(r.text, /reason: collapsed result/);
});

test("[safety][7A] a HEALTHY snapshot missing one venue: applied, the miss persisted as stale (still active), no row removed", async () => {
  const fake = fakeDb();
  await cli(["--commit"], { store: spiedStore(fake).store });
  const withoutOne: OverpassResponse = { elements: (FIXTURE.elements ?? []).filter((e) => e.id !== 8008) };
  const r = await cli(["--commit"], { store: spiedStore(fake).store, response: withoutOne });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /reconciliation: RECONCILED — stale 1/);
  assert.equal(fake.tables.venues.length, ACCEPTED);
  const dropped = fake.tables.venues.find((v) => v.external_id === "node/8008")!;
  assert.deepEqual([dropped.source_status, dropped.consecutive_misses, dropped.is_active], ["stale", 1, true]);
});

test("[safety] commitRefusal: only an ok + healthy plan may be applied", () => {
  const plan = (status: "ok" | "degraded" | "failed", healthy: boolean) =>
    ({ stats: { status, healthy } }) as unknown as SyncPlan;
  assert.equal(commitRefusal(plan("ok", true)), null);
  assert.match(commitRefusal(plan("ok", false)) ?? "", /unhealthy/);
  assert.match(commitRefusal(plan("degraded", false)) ?? "", /DEGRADED/);
  assert.match(commitRefusal(plan("failed", false)) ?? "", /FAILED/);
});

// ── baseline (existing links in scope) ────────────────────────────────────
const baselineLine = (n: number) =>
  new RegExp(`baseline: ${n} existing OpenStreetMap-linked venue rows in current scope \\(Belgrade\\)`);

/** OSM-owned venue rows in `cityId`, external ids `node/<base+i>`. */
function osmRows(cityId: string, n: number, base: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `v-${cityId}-${i}`,
    city_id: cityId,
    name: `Venue ${cityId} ${i}`,
    name_normalized: `venue ${cityId} ${i}`,
    latitude: 44.8 + i / 10000,
    longitude: 20.4,
    coordinates_source: "source",
    is_active: true,
    source_id: "ds-osm",
    external_id: `node/${base + i}`,
    source_url: `https://www.openstreetmap.org/node/${base + i}`,
    created_at: NOW,
    updated_at: NOW,
  }));
}

/** Belgrade (in scope) + Novi Sad (out of scope). */
function twoCityDb(): FakeSupabase {
  const fake = fakeDb();
  fake.seed("cities", [
    { id: "city-bg", country_id: "RS", name: "Belgrade" },
    { id: "city-ns", country_id: "RS", name: "Novi Sad" },
  ]);
  return fake;
}

test("[baseline] the report shows the in-scope baseline (read-only), 0 then N, and never blocks a commit on it", async () => {
  const fake = fakeDb();
  const first = await cli([], { store: spiedStore(fake).store });
  assert.match(first.text, baselineLine(0));

  await cli(["--commit"], { store: spiedStore(fake).store });
  const writes = fake.writes.length;
  const later = await cli([], { store: spiedStore(fake).store });
  assert.match(later.text, baselineLine(ACCEPTED));
  assert.doesNotMatch(later.text, /EMPTY SLATE|NOT an empty slate/, "a non-zero baseline is not framed as an error");
  assert.equal(fake.writes.length, writes, "the check itself is read-only");

  const again = await cli(["--commit"], { store: spiedStore(fake).store });
  assert.equal(again.code, 0, "a non-zero baseline does not refuse later commits");
});

test("[baseline scope] OSM-linked venues in Belgrade AND another city: only the Belgrade rows are counted", async () => {
  const fake = twoCityDb();
  await cli(["--commit"], { store: spiedStore(fake).store }); // ACCEPTED Belgrade rows
  fake.seed("venues", [...fake.tables.venues, ...osmRows("city-ns", 3, 9_000_000)]);
  const writes = fake.writes.length;
  const r = await cli([], { store: spiedStore(fake).store });
  assert.match(r.text, baselineLine(ACCEPTED));
  assert.equal(fake.writes.length, writes, "read-only");
});

test("[baseline scope] an OSM-linked venue ONLY in an out-of-scope city is not counted", async () => {
  const fake = twoCityDb();
  fake.seed("venues", osmRows("city-ns", 2, 9_100_000));
  const r = await cli([], { store: spiedStore(fake).store });
  assert.match(r.text, baselineLine(0));
});

test("[baseline scope] a legacy-sized Belgrade baseline (434 rows) is reported as 434; out-of-scope rows and unowned Belgrade rows are not", async () => {
  const fake = twoCityDb();
  fake.seed("venues", [
    ...osmRows("city-bg", 434, 1_000_000),
    ...osmRows("city-ns", 5, 9_200_000),
    { ...osmRows("city-bg", 1, 0)[0], id: "v-unowned", source_id: null, external_id: null, source_url: null },
  ]);
  const r = await cli([], { store: spiedStore(fake).store });
  assert.match(r.text, baselineLine(434));
  assert.deepEqual(fake.writes, []);
});

test("[baseline scope] --commit is unchanged by out-of-scope OSM rows: applied once, and those rows are never written", async () => {
  // Belgrade synced first: the (separately known, globally scoped) Step 7A
  // collapse guard also counts out-of-scope rows, so a Belgrade-less baseline
  // would be refused for that reason — not this check's concern.
  const fake = twoCityDb();
  await cli(["--commit"], { store: spiedStore(fake).store });
  fake.seed("venues", [...fake.tables.venues, ...osmRows("city-ns", 2, 9_300_000)]);
  fake.writes.length = 0;
  const { store, applyCalls } = spiedStore(fake);
  const r = await cli(["--commit"], { store });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(applyCalls, [{ commit: true }]);
  assert.match(r.text, baselineLine(ACCEPTED));
  assert.ok(
    fake.writes.every((w) => !String(w.values.city_id ?? "").includes("city-ns") && !w.filters.some(([, v]) => String(v).startsWith("v-city-ns"))),
    "no write touches the out-of-scope rows",
  );
});

// ── runner: source-agnostic, in-memory store parity ───────────────────────
test("[runner] runSync plan mode never calls apply; commit mode calls it once (in-memory store)", async () => {
  const provider = createOsmConfigProvider([BELGRADE]);
  const adapter = createOsmOverpassAdapter({ targets: [BELGRADE], config: { supabaseUrl: "", supabaseServiceRoleKey: "", overpassUrl: "x", overpassUserAgent: "t" }, transport: async () => FIXTURE });
  const store = new InMemoryCanonicalStore({ cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade" }] });
  const base = { adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store, now: NOW, runId: "r" };

  const planned = await runSync({ ...base, mode: "plan" });
  assert.equal(planned.apply, null);
  assert.deepEqual(planned.baseline, { venues: 0, cities: ["Belgrade"] });
  assert.deepEqual(store.applied, []);
  assert.equal(store.venues.length, 0);

  const committed = await runSync({ ...base, mode: "commit" });
  assert.equal(store.applied.length, 1);
  assert.equal(committed.apply?.committed, true);
  assert.equal(store.venues.length, ACCEPTED);
});

test("[runner][baseline scope] in-memory store: links are counted per in-scope city via the link table, out-of-scope links are not", async () => {
  const provider = createOsmConfigProvider([BELGRADE]);
  const adapter = createOsmOverpassAdapter({ targets: [BELGRADE], config: { supabaseUrl: "", supabaseServiceRoleKey: "", overpassUrl: "x", overpassUserAgent: "t" }, transport: async () => FIXTURE });
  const store = new InMemoryCanonicalStore({
    cities: [
      { id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: "Europe/Belgrade" },
      { id: "city-ns", countryCode: "RS", name: "Novi Sad", timeZone: "Europe/Belgrade" },
    ],
  });
  const base = { adapter, source: provider.source(OSM_SOURCE_KEY)!, config: provider, store, now: NOW, runId: "r" };
  await runSync({ ...base, mode: "commit" });
  // move one linked venue to the out-of-scope city
  store.venues[0].cityId = "city-ns";
  const r = await runSync({ ...base, mode: "plan" });
  assert.deepEqual(r.baseline, { venues: ACCEPTED - 1, cities: ["Belgrade"] });
});

// ── the real entry point (spawned; fails before any I/O) ──────────────────
function spawnEntry(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/sync-osm.ts", ...args], {
    cwd: INGESTION_DIR,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("[entry] src/sync-osm.ts: unknown argument -> usage, exit 1", () => {
  const { code, out } = spawnEntry(["--dry-run"], { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY });
  assert.equal(code, 1);
  assert.match(out, /unknown argument "--dry-run"/);
  assert.equal(out.includes(SENTINEL_KEY), false);
});

test("[entry] src/sync-osm.ts: blank SUPABASE_URL -> configuration error, exit 1, no key leak, no plan", () => {
  const { code, out } = spawnEntry(["--commit"], { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: SENTINEL_KEY });
  assert.equal(code, 1);
  assert.match(out, /Configuration error: Missing or empty required variable\(s\): SUPABASE_URL/);
  assert.doesNotMatch(out, /SYNC PLAN/);
  assert.equal(out.includes(SENTINEL_KEY), false);
});

test("[scripts] sync:osm is wired to the entry; the legacy ingest scripts are unchanged", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["sync:osm"], "tsx src/sync-osm.ts");
  assert.equal(pkg.scripts.ingest, "tsx src/index.ts");
  assert.equal(pkg.scripts["ingest:dry"], "tsx src/index.ts --dry-run");
  assert.equal(pkg.scripts["ingest:events:dry"], "tsx src/events/index.ts");
});
