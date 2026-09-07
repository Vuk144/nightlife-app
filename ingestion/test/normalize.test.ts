import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAddress,
  extractCoordinates,
  normalizeName,
  toNormalizedVenue,
} from "../src/normalize.ts";
import type { OverpassElement } from "../src/types.ts";

test("normalizeName: trims and lower-cases", () => {
  assert.equal(normalizeName("  Drugstore  "), "drugstore");
  assert.equal(normalizeName("DRUGSTORE"), "drugstore");
});

test("normalizeName: strips diacritics", () => {
  assert.equal(normalizeName("Kafana Sesir".normalize()), "kafana sesir");
  assert.equal(normalizeName("Kafana Šešir"), "kafana sesir");
  assert.equal(normalizeName("Đeram"), "deram");
});

test("normalizeName: transliterates Serbian Cyrillic", () => {
  // "Дрогстор"
  assert.equal(normalizeName("Дрогстор"), "drogstor");
});

test("normalizeName: removes generic venue words as whole tokens only", () => {
  assert.equal(normalizeName("Klub Drugstore"), "drugstore");
  assert.equal(normalizeName("Drugstore Club"), "drugstore");
  assert.equal(normalizeName("The Tube"), "tube");
  assert.equal(normalizeName("Bar Central"), "central");
  // "bar" as a substring must NOT be stripped:
  assert.equal(normalizeName("Barbarella"), "barbarella");
});

test("normalizeName: strips leading/trailing city words", () => {
  assert.equal(normalizeName("Drugstore Beograd"), "drugstore");
  assert.equal(normalizeName("Drugstore Belgrade"), "drugstore");
});

test("normalizeName: keeps the string when it is only stopwords", () => {
  assert.equal(normalizeName("The Club"), "the club");
});

test("normalizeName: punctuation and digits become spaced tokens", () => {
  assert.equal(normalizeName("20/44"), "20 44");
  assert.equal(normalizeName("R&B Lounge"), "r b lounge");
});

test("extractAddress: assembles from addr:* parts", () => {
  assert.equal(
    extractAddress({
      "addr:street": "Bulevar despota Stefana",
      "addr:housenumber": "115",
      "addr:postcode": "11000",
      "addr:city": "Beograd",
    }),
    "Bulevar despota Stefana 115, 11000 Beograd",
  );
  assert.equal(extractAddress({ "addr:street": "Makedonska" }), "Makedonska");
  assert.equal(
    extractAddress({ "addr:postcode": "11000", "addr:city": "Beograd" }),
    "11000 Beograd",
  );
  assert.equal(extractAddress({}), null);
});

test("extractCoordinates: node uses lat/lon", () => {
  const node: OverpassElement = { type: "node", id: 1, lat: 44.8, lon: 20.4 };
  assert.deepEqual(extractCoordinates(node), { lat: 44.8, lon: 20.4 });
});

test("extractCoordinates: way/relation use center", () => {
  const way: OverpassElement = { type: "way", id: 2, center: { lat: 44.81, lon: 20.46 } };
  const relation: OverpassElement = {
    type: "relation",
    id: 3,
    center: { lat: 44.82, lon: 20.45 },
  };
  assert.deepEqual(extractCoordinates(way), { lat: 44.81, lon: 20.46 });
  assert.deepEqual(extractCoordinates(relation), { lat: 44.82, lon: 20.45 });
});

test("extractCoordinates: rejects missing or out-of-range", () => {
  assert.equal(extractCoordinates({ type: "node", id: 4 }), null);
  assert.equal(extractCoordinates({ type: "node", id: 5, lat: 200, lon: 20 }), null);
  assert.equal(extractCoordinates({ type: "way", id: 6 }), null);
});

test("toNormalizedVenue: valid node", () => {
  const element: OverpassElement = {
    type: "node",
    id: 42,
    lat: 44.8177,
    lon: 20.4627,
    tags: {
      amenity: "nightclub",
      name: "Klub DOT",
      "addr:street": "Francuska",
      "addr:housenumber": "6",
      website: "https://dot.example",
      wikidata: "Q123",
      opening_hours: "Th-Sa 22:00-05:00",
    },
  };
  const result = toNormalizedVenue(element);
  assert.ok("ok" in result);
  if ("ok" in result) {
    assert.equal(result.ok.externalId, "node/42");
    assert.equal(result.ok.osmType, "node");
    assert.equal(result.ok.sourceUrl, "https://www.openstreetmap.org/node/42");
    assert.equal(result.ok.name, "Klub DOT");
    assert.equal(result.ok.nameNormalized, "dot");
    assert.equal(result.ok.latitude, 44.8177);
    assert.equal(result.ok.longitude, 20.4627);
    assert.equal(result.ok.address, "Francuska 6");
    assert.equal(result.ok.website, "https://dot.example");
    assert.equal(result.ok.wikidata, "Q123");
    assert.equal(result.ok.openingHours, "Th-Sa 22:00-05:00");
    assert.equal(result.ok.category, "nightclub");
  }
});

test("toNormalizedVenue: falls back to contact:website", () => {
  const result = toNormalizedVenue({
    type: "node",
    id: 43,
    lat: 44.8,
    lon: 20.4,
    tags: { amenity: "bar", name: "X", "contact:website": "https://x.example" },
  });
  assert.ok("ok" in result);
  if ("ok" in result) assert.equal(result.ok.website, "https://x.example");
});

test("toNormalizedVenue: invalid when name is missing", () => {
  const result = toNormalizedVenue({ type: "node", id: 7, lat: 1, lon: 2 });
  assert.ok("invalid" in result);
  if ("invalid" in result) assert.match(result.invalid.reason, /name/);
});

test("toNormalizedVenue: invalid when coordinates are missing", () => {
  const result = toNormalizedVenue({ type: "way", id: 8, tags: { name: "No Coords" } });
  assert.ok("invalid" in result);
  if ("invalid" in result) assert.match(result.invalid.reason, /coordinates/);
});

test("toNormalizedVenue: invalid on unsupported element type", () => {
  const result = toNormalizedVenue({ type: "changeset", id: 9, tags: { name: "N" } });
  assert.ok("invalid" in result);
});

test("toNormalizedVenue: recovers a venue whose name is only in name:sr / name:en", () => {
  const srOnly = toNormalizedVenue({
    type: "node",
    id: 20,
    lat: 44.8,
    lon: 20.4,
    tags: { amenity: "bar", "name:sr": "Кафана Име" },
  });
  assert.ok("ok" in srOnly);
  if ("ok" in srOnly) assert.equal(srOnly.ok.name, "Кафана Име");

  const enOnly = toNormalizedVenue({
    type: "node",
    id: 21,
    lat: 44.8,
    lon: 20.4,
    tags: { amenity: "pub", "name:en": "The Fallback Pub" },
  });
  assert.ok("ok" in enOnly);
  if ("ok" in enOnly) assert.equal(enOnly.ok.name, "The Fallback Pub");
});

test("toNormalizedVenue: excluded when the element is not a nightlife venue", () => {
  const shop = toNormalizedVenue({
    type: "node",
    id: 10,
    lat: 44.8,
    lon: 20.4,
    tags: { shop: "bakery", name: "Pekara" },
  });
  assert.ok("excluded" in shop);
  if ("excluded" in shop) assert.match(shop.excluded.reason, /shop/);

  const restaurant = toNormalizedVenue({
    type: "node",
    id: 11,
    lat: 44.8,
    lon: 20.4,
    tags: { amenity: "restaurant", name: "Restoran", cuisine: "italian" },
  });
  assert.ok("excluded" in restaurant);
  if ("excluded" in restaurant) {
    assert.match(restaurant.excluded.reason, /without a documented nightlife signal/);
    assert.equal(restaurant.excluded.name, "Restoran");
  }
});
