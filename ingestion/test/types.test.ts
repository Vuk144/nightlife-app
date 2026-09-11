/**
 * Contract locks for `../src/types.ts`.
 *
 * types.ts has no runtime logic, so this file only pins the handful of
 * cross-module contracts that a silent edit could break:
 *   - ExistingVenue must stay in lock-step with the `venues` SELECT projection
 *     (a dropped column -> an `undefined` field the cast hides -> planUpdate
 *     rewrites that field every run);
 *   - a normalized OSM venue must carry exactly the documented field set;
 *   - VenueCategory / VenueActionKind stay closed and exhaustive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toNormalizedVenue } from "../src/normalize.ts";
import { CATEGORY_LABELS } from "../src/classify.ts";
import type { VenueCategory, VenueActionKind } from "../src/types.ts";
import type { OverpassElement } from "../src/types.ts";

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), "src");

// ── ExistingVenue <-> the venues read projection ───────────────────

test("[ExistingVenue] the type's fields exactly match the `venues` SELECT in ingest-venues.ts", () => {
  // Keep this list identical to the ExistingVenue interface. tsc guarantees the
  // interface itself; this guards the *runtime projection* that fills it.
  const EXISTING_VENUE_FIELDS = [
    "id", "name", "name_normalized", "source_id", "external_id", "source_url",
    "latitude", "longitude", "coordinates_source", "address", "website",
    "opening_hours", "wikidata",
  ].sort();

  const src = readFileSync(join(SRC, "ingest-venues.ts"), "utf8");
  const m = src.match(/\.from\("venues"\)\s*\.select\(\s*"([^"]+)"/);
  assert.ok(m, "could not locate the venues .select(...) projection");
  const projected = m![1].split(",").map((s) => s.trim()).sort();

  assert.deepEqual(
    projected,
    EXISTING_VENUE_FIELDS,
    "the venues projection and ExistingVenue have drifted apart",
  );
});

// ── NormalizedVenue: the OSM producer fills exactly the documented shape ──

test("[NormalizedVenue] a normalized OSM venue carries every required field and only the documented transient set", () => {
  const el: OverpassElement = {
    type: "node", id: 42, lat: 44.8177, lon: 20.4627,
    tags: {
      amenity: "nightclub", name: "Klub DOT",
      website: "https://dot.example", wikidata: "Q1", opening_hours: "Th-Sa 22:00-05:00",
      "addr:street": "Francuska", "addr:housenumber": "6",
    },
  };
  const r = toNormalizedVenue(el);
  assert.ok("ok" in r);
  if (!("ok" in r)) return;

  const REQUIRED = [
    "externalId", "osmType", "osmId", "sourceUrl", "name", "nameNormalized",
    "latitude", "longitude", "address", "website", "openingHours", "wikidata",
  ];
  const TRANSIENT = ["category", "acceptedVia", "rescued", "review"];

  for (const k of REQUIRED) {
    assert.ok(k in r.ok, `missing required field ${k}`);
    assert.notEqual((r.ok as unknown as Record<string, unknown>)[k], undefined, `${k} is undefined`);
  }
  // every extra key must be one of the four documented transient fields
  const extras = Object.keys(r.ok).filter((k) => !REQUIRED.includes(k));
  assert.deepEqual(extras.sort(), TRANSIENT.slice().sort());

  // required narrow-union / numeric fields hold real values
  assert.equal(r.ok.osmType, "node");
  assert.equal(typeof r.ok.osmId, "number");
  assert.equal(Number.isFinite(r.ok.latitude) && Number.isFinite(r.ok.longitude), true);
  assert.ok(r.ok.sourceUrl.startsWith("https://www.openstreetmap.org/"));
  assert.ok(r.ok.nameNormalized.length > 0, "OSM path never yields an empty nameNormalized");
});

test("[NormalizedVenue] nameNormalized is non-empty even when normalizeName() collapses to '' (fallback keeps the raw name)", () => {
  const r = toNormalizedVenue({
    type: "node", id: 1, lat: 44.8, lon: 20.4,
    tags: { amenity: "bar", name: "北京" }, // normalizeName -> "" -> fallback "北京"
  });
  assert.ok("ok" in r && r.ok.nameNormalized === "北京");
});

// ── VenueCategory: closed union, exhaustive against its consumers ──

test("[VenueCategory] CATEGORY_LABELS has exactly the union's members — no orphan label, no missing one", () => {
  const CATEGORIES: VenueCategory[] = [
    "nightclub", "concert_hall", "bar", "pub_brewery",
    "kafana", "nightlife_venue", "other_nightlife",
  ];
  assert.deepEqual(Object.keys(CATEGORY_LABELS).sort(), [...CATEGORIES].sort());
  for (const c of CATEGORIES) {
    assert.equal(typeof CATEGORY_LABELS[c], "string");
    assert.ok(CATEGORY_LABELS[c].length > 0);
  }
});

// ── VenueActionKind: the six kinds ingest-venues.ts actually emits ──

test("[VenueActionKind] the union is exactly the six kinds produced by ingest-venues.ts", () => {
  const KINDS: VenueActionKind[] = ["insert", "update", "unchanged", "skip", "invalid", "excluded"];
  assert.equal(new Set(KINDS).size, 6);

  const src = readFileSync(join(SRC, "ingest-venues.ts"), "utf8");
  // every `kind: "..."` and `venueAction("...")` literal in the producer
  const emitted = new Set<string>();
  for (const m of src.matchAll(/kind:\s*"([a-z]+)"/g)) emitted.add(m[1]);
  for (const m of src.matchAll(/venueAction\(\s*"([a-z]+)"/g)) emitted.add(m[1]);
  emitted.delete("new"); // MatchOutcome.kind, quoted only in a doc comment

  for (const k of emitted) {
    assert.ok((KINDS as string[]).includes(k), `ingest-venues.ts emits kind "${k}" not in VenueActionKind`);
  }
  // and it emits the accepted/edit kinds we expect (sanity that the regex worked)
  for (const k of ["insert", "unchanged", "skip", "invalid", "excluded"]) {
    assert.ok(emitted.has(k), `expected ingest-venues.ts to emit "${k}"`);
  }
});
