/**
 * `../../src/sync/adapters/gigstix-config.ts` — GIGS city text → canonical
 * RS city, via the shared city alias table and the engine's existing
 * `resolveCity`. Pure; no network, no store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CITY_ALIASES } from "../../src/city-aliases.ts";
import { parseGigstixEventRecord } from "../../src/sync/adapters/gigstix-event.ts";
import {
  buildGigstixSyncConfig,
  createGigstixConfigProvider,
  resolveGigstixCity,
} from "../../src/sync/adapters/gigstix-config.ts";
import { buildOsmSyncConfig, createOsmConfigProvider } from "../../src/sync/adapters/osm-overpass.ts";
import { planEventInStore } from "../../src/sync/event-plan.ts";
import { InMemoryCanonicalStore } from "../../src/sync/store.ts";
import { TARGETS } from "../../src/targets.ts";

test("Beograd → RS / Belgrade", () => {
  assert.deepEqual(resolveGigstixCity("Beograd"), { countryCode: "RS", cityName: "Belgrade" });
});

test("Novi Sad → RS / Novi Sad", () => {
  assert.deepEqual(resolveGigstixCity("Novi Sad"), { countryCode: "RS", cityName: "Novi Sad" });
});

test("Niš → RS / Niš", () => {
  assert.deepEqual(resolveGigstixCity("Niš"), { countryCode: "RS", cityName: "Niš" });
});

test("the existing cityKey folding applies: case, diacritics, whitespace, hyphens; plus the table's own aliases", () => {
  for (const [text, city] of [
    ["BEOGRAD", "Belgrade"],
    ["  beograd ", "Belgrade"],
    ["Belgrade", "Belgrade"],
    ["NOVI SAD", "Novi Sad"],
    ["Novi  Sad", "Novi Sad"],
    ["Novi-Sad", "Novi Sad"],
    ["Nis", "Niš"],
    ["NIŠ", "Niš"],
    ["Niš Srbija", "Niš"],
  ] as const) {
    assert.deepEqual(resolveGigstixCity(text), { countryCode: "RS", cityName: city }, text);
  }
});

test("unknown or unsupported city text → null (unresolved), never guessed", () => {
  for (const text of ["Vršac", "Sremski Karlovci", "Kragujevac", "Zagreb", "Beogradd", "", "   ", null, undefined]) {
    assert.equal(resolveGigstixCity(text), null, JSON.stringify(text));
  }
  // cityKey does not transliterate (existing convention): Cyrillic stays unresolved
  for (const text of ["Београд", "Нови Сад", "Ниш"]) assert.equal(resolveGigstixCity(text), null, text);
});

test("deterministic: the same config and results every time", () => {
  assert.deepEqual(buildGigstixSyncConfig(), buildGigstixSyncConfig());
  const texts = ["Beograd", "Novi Sad", "Niš", "Vršac"];
  assert.deepEqual(texts.map((t) => resolveGigstixCity(t)), texts.map((t) => resolveGigstixCity(t)));
});

test("the config is built from the shared alias table: exactly its target cities, all RS, no event-first creation", () => {
  const config = buildGigstixSyncConfig();
  assert.deepEqual(config.countries.map((c) => c.code), ["RS"]);
  assert.deepEqual(
    config.cities.map((c) => [c.countryCode, c.canonicalName, c.nameAliases, c.eventFirstEnabled]),
    [
      ["RS", "Belgrade", ["beograd", "belgrade"], false],
      ["RS", "Novi Sad", ["novi sad"], false],
      ["RS", "Niš", ["nis", "nis srbija"], false],
    ],
  );
  assert.deepEqual([...new Set(Object.values(CITY_ALIASES))], config.cities.map((c) => c.canonicalName));
  assert.deepEqual(config.venueAliases, [], "city identity only — no venue data");
  assert.equal(createGigstixConfigProvider().source("gigstix")?.kinds.join(), "event");
});

test("city resolution involves no venue matching and creates nothing (planner with this config, rejected event)", async () => {
  // a city-only GIGS listing: the city resolves, the event has no venue identity
  const html = readFileSync(new URL("../events/fixtures/gigstix-event-intercell.html", import.meta.url), "utf8")
    .replace(/<li[^>]*class=["']gt-venue["'][\s\S]*?<\/li>/i, "");
  const parsed = parseGigstixEventRecord(html, "https://new.gigstix.com/event/x/", { fetchedAt: "2026-09-27T00:00:00.000Z" });
  assert.ok(parsed.ok);
  assert.deepEqual(resolveGigstixCity(parsed.record.links.venue?.cityText), { countryCode: "RS", cityName: "Belgrade" });

  const store = new InMemoryCanonicalStore({ cities: [{ id: "city-bg", countryCode: "RS", name: "Belgrade", timeZone: null }] });
  const plan = await planEventInStore(parsed, { config: createGigstixConfigProvider(), store });
  assert.equal(plan.action === "REJECTED" && plan.reasonCode, "missing-venue-identity");
  assert.deepEqual(store.venues, []);
  assert.deepEqual(store.applied, []);
});

// ── OSM regression: its config and city resolution are untouched ────────
test("[regression] the OSM sync config is unchanged: no city aliases, and 'Beograd' does not resolve there", () => {
  const osm = buildOsmSyncConfig(TARGETS);
  assert.deepEqual(
    osm.cities.map((c) => [c.countryCode, c.canonicalName, c.nameAliases, c.eventFirstEnabled, c.sourceScope]),
    [["RS", "Belgrade", [], false, { osm: { relationId: 2728438 } }]],
  );
  assert.deepEqual(osm.sources.map((s) => [s.key, s.kinds]), [["OpenStreetMap", ["venue"]]]);
  const provider = createOsmConfigProvider(TARGETS);
  assert.equal(provider.resolveCity("RS", "Belgrade")?.city.canonicalName, "Belgrade");
  assert.equal(provider.resolveCity("RS", "Beograd"), null, "the GIGS aliases must not leak into OSM");
});
