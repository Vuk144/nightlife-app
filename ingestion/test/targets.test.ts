/**
 * Characterization of the static ingestion target configuration
 * (`../src/targets.ts`).
 *
 * `TARGETS` is plain declarative data with exactly one runtime consumer —
 * `src/index.ts` iterates it — plus the type `IngestionTarget` used throughout
 * the pipeline. These tests pin the shape and the shipped Belgrade values,
 * the uniqueness invariants a second city would have to keep, and the fact
 * that `osmRelationId` feeds ONLY the Overpass area id.
 *
 * Where a test leans on seeded database data (country/city rows) it is marked
 * [config-vs-seed] — that is configuration characterization, not schema
 * validation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TARGETS, type IngestionTarget } from "../src/targets.ts";
import { buildOverpassQuery } from "../src/sources/osm-overpass.ts";

/** Overpass area id = 3_600_000_000 + relation id (mirrors query.ts). */
const OVERPASS_AREA_OFFSET = 3_600_000_000;

// ── shape ────────────────────────────────────────────────────────────

test("[shape] TARGETS is a non-empty array of well-formed IngestionTarget objects", () => {
  assert.ok(Array.isArray(TARGETS));
  assert.ok(TARGETS.length >= 1);

  for (const t of TARGETS) {
    assert.equal(typeof t.countryId, "string");
    assert.match(t.countryId, /^[A-Z]{2}$/, `countryId "${t.countryId}" must be ISO 3166-1 alpha-2`);
    assert.equal(t.countryId.trim(), t.countryId, "no surrounding whitespace in countryId");

    assert.equal(typeof t.cityName, "string");
    assert.ok(t.cityName.length > 0, "cityName is non-empty");
    assert.equal(t.cityName.trim(), t.cityName, "no surrounding whitespace in cityName");

    assert.equal(typeof t.osmRelationId, "number");
    assert.ok(Number.isInteger(t.osmRelationId), "osmRelationId is an integer");
    assert.ok(t.osmRelationId > 0, "osmRelationId is positive");
    assert.ok(
      Number.isSafeInteger(OVERPASS_AREA_OFFSET + t.osmRelationId),
      "area id stays a safe integer",
    );

    // exactly the three documented fields — nothing smuggled in
    assert.deepEqual(Object.keys(t).sort(), ["cityName", "countryId", "osmRelationId"]);
  }
});

// ── the shipped target ───────────────────────────────────────────────

test("[belgrade] the shipped Belgrade target has its expected, fixture-shared values", () => {
  // Six test files hand-copy this literal ("kept in sync with src/targets.ts").
  // If this assertion fails, update those fixtures too.
  const belgrade = TARGETS.find((t) => t.countryId === "RS" && t.cityName === "Belgrade");
  assert.ok(belgrade, "a RS/Belgrade target is present");
  assert.deepEqual(belgrade, {
    countryId: "RS",
    cityName: "Belgrade",
    osmRelationId: 2_728_438,
  });
});

test("[config-vs-seed] every target's (countryId, cityName) is a pair the location seed provides", () => {
  // Configuration characterization against migration 20260901165921 — NOT a
  // schema test. `resolveCityId` will throw "No cities row …" for any pair not
  // seeded, so a target that drifts from the seed fails the whole run.
  const SEEDED_CITIES = new Set([
    "RS|Belgrade", "RS|Novi Sad", "RS|Niš", "RS|Kragujevac", "RS|Subotica",
    "RS|Pančevo", "RS|Čačak", "RS|Zrenjanin", "RS|Sombor", "RS|Kraljevo",
    "RS|Užice", "RS|Leskovac", "RS|Novi Pazar", "RS|Šabac", "RS|Valjevo",
  ]);
  for (const t of TARGETS) {
    assert.ok(
      SEEDED_CITIES.has(`${t.countryId}|${t.cityName}`),
      `target ${t.countryId}/${t.cityName} has no matching seeded cities row`,
    );
  }
});

// ── uniqueness invariants ────────────────────────────────────────────

test("[uniqueness] no duplicate (countryId, cityName) pair", () => {
  const seen = new Set<string>();
  for (const t of TARGETS) {
    const key = `${t.countryId}|${t.cityName}`;
    assert.equal(seen.has(key), false, `duplicate target identity: ${key}`);
    seen.add(key);
  }
});

test("[uniqueness] no two targets share an osmRelationId", () => {
  const seen = new Set<number>();
  for (const t of TARGETS) {
    assert.equal(seen.has(t.osmRelationId), false, `duplicate osmRelationId: ${t.osmRelationId}`);
    seen.add(t.osmRelationId);
  }
});

// ── osmRelationId is an Overpass-only query boundary ─────────────────

test("[overpass] osmRelationId feeds exactly one thing: the Overpass area id line", () => {
  const belgrade: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2_728_438 };
  const query = buildOverpassQuery(belgrade);
  assert.ok(
    query.includes(`area(id:${OVERPASS_AREA_OFFSET + belgrade.osmRelationId})->.bg;`),
    "the area id is offset + relation id",
  );

  // changing ONLY osmRelationId changes ONLY the area line
  const moved = buildOverpassQuery({ ...belgrade, osmRelationId: 111_222 });
  const diffLines = query
    .split("\n")
    .filter((line, i) => line !== moved.split("\n")[i]);
  assert.deepEqual(diffLines, [`area(id:${OVERPASS_AREA_OFFSET + belgrade.osmRelationId})->.bg;`]);

  // countryId / cityName do NOT appear in the query as identity — only the
  // curated Layer-C rescue clauses reference the (country, city) pair as data.
  assert.equal(query.includes("2728438"), true); // as part of the area id only
  assert.equal(moved.includes("2728438"), false);
});

// ── determinism ──────────────────────────────────────────────────────

test("[determinism] TARGETS iteration order is stable across reads", () => {
  const first = TARGETS.map((t) => `${t.countryId}|${t.cityName}`);
  const second = TARGETS.map((t) => `${t.countryId}|${t.cityName}`);
  assert.deepEqual(first, second);
});
