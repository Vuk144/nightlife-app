/**
 * Tests for the event-ingestion configuration loader
 * (`../../src/events/config.ts`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EVENT_FIRST_CITIES,
  DEFAULT_EVENT_FIRST_MAX_NEW_VENUES,
  DEFAULT_GIGSTIX_BASE_URL,
  DEFAULT_INGEST_USER_AGENT,
  DEFAULT_TRUSTED_SOURCES,
  loadEventsConfig,
  loadEventsRuntime,
} from "../../src/events/config.ts";

// ── regressions ────────────────────────────────────────────────────

test("[regression] loadEventsConfig hands back copies, never a live reference to an exported default", () => {
  const a = loadEventsConfig({});
  assert.notEqual(a.eventFirstCities, DEFAULT_EVENT_FIRST_CITIES, "eventFirstCities must be a copy");
  assert.notEqual(a.trustedSources, DEFAULT_TRUSTED_SOURCES, "trustedSources must be a copy");

  // mutating the returned config must not corrupt the module constants…
  a.eventFirstCities.push("Zagreb");
  a.trustedSources.push("entrio-hr");
  assert.deepEqual([...DEFAULT_EVENT_FIRST_CITIES], ["Belgrade"]);
  assert.deepEqual([...DEFAULT_TRUSTED_SOURCES], ["gigstix"]);

  // …nor any subsequent load
  const b = loadEventsConfig({});
  assert.deepEqual(b.eventFirstCities, ["Belgrade"]);
  assert.deepEqual(b.trustedSources, ["gigstix"]);
  assert.notEqual(a.eventFirstCities, b.eventFirstCities, "independent loads share no array");
});

test("[regression] EVENT_FIRST_MAX_NEW_VENUES='' / whitespace uses the default, not 0", () => {
  assert.equal(loadEventsConfig({ EVENT_FIRST_MAX_NEW_VENUES: "" }).eventFirstMaxNewVenues, 50);
  assert.equal(loadEventsConfig({ EVENT_FIRST_MAX_NEW_VENUES: "   " }).eventFirstMaxNewVenues, 50);
  // an explicit "0" is still an intentional kill-switch and must be preserved
  assert.equal(loadEventsConfig({ EVENT_FIRST_MAX_NEW_VENUES: "0" }).eventFirstMaxNewVenues, 0);
  assert.equal(loadEventsConfig({ EVENT_FIRST_MAX_NEW_VENUES: " 0 " }).eventFirstMaxNewVenues, 0);
});

test("[regression] loadEventsRuntime loads .env BEFORE reading the events config", () => {
  const KEYS = [
    "GIGSTIX_BASE_URL",
    "INGEST_USER_AGENT",
    "EVENT_FIRST_CITIES",
    "EVENT_FIRST_MAX_NEW_VENUES",
    "EVENT_FIRST_TRUSTED_SOURCES",
  ] as const;
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(join(tmpdir(), "events-runtime-"));
  const envPath = join(dir, ".env");
  writeFileSync(
    envPath,
    [
      "GIGSTIX_BASE_URL=https://mirror.example/",
      "EVENT_FIRST_MAX_NEW_VENUES=7",
      "EVENT_FIRST_CITIES=Belgrade, Novi Sad",
      "",
    ].join("\n"),
  );
  try {
    for (const k of KEYS) delete process.env[k];

    // OLD startup order: config read straight from the environment, before the
    // .env file is applied -> every .env-only override is silently lost.
    const stale = loadEventsConfig();
    assert.equal(stale.eventFirstMaxNewVenues, DEFAULT_EVENT_FIRST_MAX_NEW_VENUES);
    assert.equal(stale.gigstixBaseUrl, DEFAULT_GIGSTIX_BASE_URL);
    assert.deepEqual(stale.eventFirstCities, ["Belgrade"]);

    // CORRECTED order: .env is loaded into process.env first, then read.
    for (const k of KEYS) delete process.env[k];
    const { envFile, config } = loadEventsRuntime(envPath);
    assert.equal(envFile.existed, true);
    assert.equal(config.eventFirstMaxNewVenues, 7);
    assert.equal(config.gigstixBaseUrl, "https://mirror.example");
    assert.deepEqual(config.eventFirstCities, ["Belgrade", "Novi Sad"]);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── defaults ───────────────────────────────────────────────────────

test("loadEventsConfig({}) == the exported DEFAULT_* constants", () => {
  const c = loadEventsConfig({});
  assert.deepEqual(c, {
    gigstixBaseUrl: DEFAULT_GIGSTIX_BASE_URL,
    userAgent: DEFAULT_INGEST_USER_AGENT,
    eventFirstCities: [...DEFAULT_EVENT_FIRST_CITIES],
    eventFirstMaxNewVenues: DEFAULT_EVENT_FIRST_MAX_NEW_VENUES,
    trustedSources: [...DEFAULT_TRUSTED_SOURCES],
  });
});

// ── GIGSTIX_BASE_URL ───────────────────────────────────────────────

test("GIGSTIX_BASE_URL: unset / empty / whitespace / only-slashes -> default", () => {
  for (const v of [undefined, "", "   ", "/", "///", "  //  "]) {
    assert.equal(
      loadEventsConfig(v === undefined ? {} : { GIGSTIX_BASE_URL: v }).gigstixBaseUrl,
      DEFAULT_GIGSTIX_BASE_URL,
      JSON.stringify(v),
    );
  }
});

test("GIGSTIX_BASE_URL: surrounding whitespace trimmed, trailing slashes stripped", () => {
  assert.equal(loadEventsConfig({ GIGSTIX_BASE_URL: "  https://mirror.test/  " }).gigstixBaseUrl, "https://mirror.test");
  assert.equal(loadEventsConfig({ GIGSTIX_BASE_URL: "http://localhost:8080///" }).gigstixBaseUrl, "http://localhost:8080");
});

// ── INGEST_USER_AGENT ──────────────────────────────────────────────

test("INGEST_USER_AGENT: unset / empty / whitespace -> default; surrounding whitespace trimmed", () => {
  assert.equal(loadEventsConfig({}).userAgent, DEFAULT_INGEST_USER_AGENT);
  assert.equal(loadEventsConfig({ INGEST_USER_AGENT: "" }).userAgent, DEFAULT_INGEST_USER_AGENT);
  assert.equal(loadEventsConfig({ INGEST_USER_AGENT: "   " }).userAgent, DEFAULT_INGEST_USER_AGENT);
  assert.equal(loadEventsConfig({ INGEST_USER_AGENT: "  MyBot/2.0  " }).userAgent, "MyBot/2.0");
});

// ── csv fields: EVENT_FIRST_CITIES / EVENT_FIRST_TRUSTED_SOURCES ────

test("csv fields: unset / empty / whitespace / comma-only -> default", () => {
  for (const v of [undefined, "", "   ", ",", " , , "]) {
    const env = v === undefined ? {} : { EVENT_FIRST_CITIES: v, EVENT_FIRST_TRUSTED_SOURCES: v };
    assert.deepEqual(loadEventsConfig(env).eventFirstCities, ["Belgrade"], JSON.stringify(v));
    assert.deepEqual(loadEventsConfig(env).trustedSources, ["gigstix"], JSON.stringify(v));
  }
});

test("csv fields: split on comma, trim each part, drop empty entries, preserve order", () => {
  assert.deepEqual(
    loadEventsConfig({ EVENT_FIRST_CITIES: " Belgrade , ,Novi Sad,  " }).eventFirstCities,
    ["Belgrade", "Novi Sad"],
  );
  assert.deepEqual(
    loadEventsConfig({ EVENT_FIRST_TRUSTED_SOURCES: "b,a" }).trustedSources,
    ["b", "a"],
  );
});

// ── EVENT_FIRST_MAX_NEW_VENUES ─────────────────────────────────────

test("EVENT_FIRST_MAX_NEW_VENUES: integer/decimal/zero/negative/NaN/Infinity/huge", () => {
  const cap = (v: string | undefined) =>
    loadEventsConfig(v === undefined ? {} : { EVENT_FIRST_MAX_NEW_VENUES: v }).eventFirstMaxNewVenues;
  assert.equal(cap("10"), 10);
  assert.equal(cap("  10  "), 10);
  assert.equal(cap("50.9"), 50); // floored
  assert.equal(cap("0"), 0); // explicit kill-switch preserved
  assert.equal(cap("-1"), 50); // negative -> default
  assert.equal(cap("nan"), 50);
  assert.equal(cap("Infinity"), 50); // not finite -> default
  assert.equal(cap("1e999"), 50); // overflows to Infinity -> default
  assert.equal(cap("abc"), 50);
  assert.equal(cap("10abc"), 50); // Number() does not partial-parse
  assert.equal(cap("1000000000"), 1000000000); // large finite value kept
  assert.equal(cap(undefined), 50);
});

// ── purity / determinism ───────────────────────────────────────────

test("loadEventsConfig is pure — no mutation of the supplied env, deterministic for the same env", () => {
  const env = {
    GIGSTIX_BASE_URL: "https://x.test/",
    INGEST_USER_AGENT: "UA/1",
    EVENT_FIRST_CITIES: "Belgrade,Zagreb",
    EVENT_FIRST_MAX_NEW_VENUES: "7",
    EVENT_FIRST_TRUSTED_SOURCES: "gigstix,entrio-hr",
  };
  const snapshot = JSON.stringify(env);
  const a = loadEventsConfig(env);
  const b = loadEventsConfig(env);
  assert.equal(JSON.stringify(env), snapshot, "env object not mutated");
  assert.deepEqual(a, b, "same env -> equal result");
  assert.notEqual(a.eventFirstCities, b.eventFirstCities, "…but no shared arrays between calls");
});
