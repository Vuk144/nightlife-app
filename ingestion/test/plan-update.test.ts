import { test } from "node:test";
import assert from "node:assert/strict";
import { planUpdate, type ExistingVenue } from "../src/ingest-venues.ts";
import type { NormalizedVenue } from "../src/types.ts";

const OSM = "osm-source-id";

function incoming(overrides: Partial<NormalizedVenue> = {}): NormalizedVenue {
  return {
    externalId: "node/1001",
    osmType: "node",
    osmId: 1001,
    sourceUrl: "https://www.openstreetmap.org/node/1001",
    name: "Drugstore",
    nameNormalized: "drugstore",
    latitude: 44.8185,
    longitude: 20.4884,
    address: "Bulevar despota Stefana 115",
    website: "https://example.org/drugstore",
    openingHours: "Fr-Sa 23:00-06:00",
    wikidata: "Q3040577",
    category: "nightclub",
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingVenue> = {}): ExistingVenue {
  return {
    id: "venue-uuid",
    name: "Drugstore",
    name_normalized: "drugstore",
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
    ...overrides,
  };
}

test("links a manually seeded venue: sets provenance, fills empties, sets coords", () => {
  const fields = planUpdate(existing(), incoming(), OSM);
  assert.ok(fields);
  assert.equal(fields.source_id, OSM);
  assert.equal(fields.external_id, "node/1001");
  assert.equal(fields.source_url, "https://www.openstreetmap.org/node/1001");
  assert.equal(fields.address, "Bulevar despota Stefana 115");
  assert.equal(fields.website, "https://example.org/drugstore");
  assert.equal(fields.wikidata, "Q3040577");
  assert.equal(fields.latitude, 44.8185);
  assert.equal(fields.coordinates_source, "source");
});

test("never overwrites manually maintained coordinates", () => {
  const fields = planUpdate(
    existing({ coordinates_source: "manual", latitude: 44.9, longitude: 20.9 }),
    incoming(),
    OSM,
  );
  assert.ok(fields);
  assert.equal("latitude" in fields, false);
  assert.equal("longitude" in fields, false);
  assert.equal("coordinates_source" in fields, false);
  // still links provenance
  assert.equal(fields.source_id, OSM);
});

test("never clobbers a curated address / website already present", () => {
  const fields = planUpdate(
    existing({
      source_id: OSM,
      external_id: "node/1001",
      source_url: "https://www.openstreetmap.org/node/1001",
      coordinates_source: "source",
      latitude: 44.8185,
      longitude: 20.4884,
      address: "Curated address",
      website: "https://curated.example",
      name_normalized: "drugstore",
    }),
    incoming(),
    OSM,
  );
  // address + website are already curated -> never touched, whatever else changes
  assert.equal(fields === null || !("address" in fields), true);
  assert.equal(fields === null || !("website" in fields), true);
});

test("returns null when nothing changed", () => {
  const settled = existing({
    source_id: OSM,
    external_id: "node/1001",
    source_url: "https://www.openstreetmap.org/node/1001",
    coordinates_source: "source",
    latitude: 44.8185,
    longitude: 20.4884,
    address: "Bulevar despota Stefana 115",
    website: "https://example.org/drugstore",
    opening_hours: "Fr-Sa 23:00-06:00",
    wikidata: "Q3040577",
  });
  assert.equal(planUpdate(settled, incoming(), OSM), null);
});

test("never changes name_normalized, even when the OSM name differs", () => {
  // e.g. a Tier 3 alias link: existing "KST" keeps its name; the OSM element
  // is "Клуб студената технике" -> "studenata tehnike".
  const fields = planUpdate(
    existing({
      name: "KST",
      name_normalized: "kst",
      coordinates_source: "manual",
      latitude: 44.8,
      longitude: 20.4,
    }),
    incoming({ nameNormalized: "studenata tehnike" }),
    OSM,
  );
  assert.equal(fields === null || !("name_normalized" in fields), true);
  assert.equal(fields === null || !("name" in fields), true);
});

test("detects a moved (source) coordinate", () => {
  const fields = planUpdate(
    existing({
      source_id: OSM,
      external_id: "node/1001",
      coordinates_source: "source",
      latitude: 44.8185,
      longitude: 20.4884,
    }),
    incoming({ latitude: 44.82, longitude: 20.49 }),
    OSM,
  );
  assert.ok(fields);
  assert.equal(fields.latitude, 44.82);
  assert.equal(fields.longitude, 20.49);
  assert.equal(fields.coordinates_source, "source");
});
