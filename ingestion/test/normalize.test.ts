import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeNameNormalized,
  extractAddress,
  extractCoordinates,
  normalizeName,
  toNormalizedVenue,
} from "../src/normalize.ts";
import type { OverpassElement } from "../src/types.ts";
import type { IngestionTarget } from "../src/targets.ts";

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

// ════════════════════════════════════════════════════════════════════════
//  AUDIT PASS — toNormalizedVenue / resolveName / extractCoordinates /
//  extractAddress / cleanTag / provenance. Characterization + [latent] pins.
// ════════════════════════════════════════════════════════════════════════

const BELGRADE: IngestionTarget = { countryId: "RS", cityName: "Belgrade", osmRelationId: 2_728_438 };

function ok(el: OverpassElement, target?: IngestionTarget) {
  const r = toNormalizedVenue(el, target);
  assert.ok("ok" in r, `expected ok, got ${JSON.stringify(r)}`);
  return (r as { ok: import("../src/types.ts").NormalizedVenue }).ok;
}

// ── name resolution: fallback order ────────────────────────────────

test("[name] NAME_FALLBACK_KEYS priority — a higher key always wins, lower never overrides", () => {
  const base = { amenity: "bar" } as Record<string, string>;
  assert.equal(ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { ...base, name: "Primary", "name:en": "EN" } }).name, "Primary");
  assert.equal(ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { ...base, "name:sr": "SR", "name:en": "EN" } }).name, "SR");
  assert.equal(ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { ...base, "name:sr-Latn": "Latn", int_name: "Int" } }).name, "Latn");
  assert.equal(ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { ...base, brand: "Brand" } }).name, "Brand");
});

test("[name] a whitespace-only higher-priority name does NOT block a real lower-priority fallback", () => {
  const v = ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "   ", "name:en": "Real Name" } });
  assert.equal(v.name, "Real Name");
});

test("[name] the selected name is trimmed; internal whitespace is preserved in name, collapsed in nameNormalized", () => {
  const v = ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "  Bar   Foo  " } });
  assert.equal(v.name, "Bar   Foo");
  assert.equal(v.nameNormalized, "foo"); // "bar" is a stopword
});

test("[name] no usable name anywhere -> invalid (never reaches the classifier)", () => {
  const r = toNormalizedVenue({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "  ", "name:sr": "\t" } });
  assert.ok("invalid" in r);
  if ("invalid" in r) assert.match(r.invalid.reason, /name/);
});

// ── coordinates: boundaries, invalid, node vs way/relation ─────────

test("[coords] ±90 / ±180 are accepted; anything strictly outside, NaN, Infinity, or non-number -> null", () => {
  const cases: [unknown, unknown, boolean][] = [
    [90, 180, true], [-90, -180, true], [0, 0, true],
    [90.0001, 0, false], [-90.0001, 0, false], [0, 180.0001, false], [0, -180.0001, false],
    [Number.NaN, 0, false], [Infinity, 0, false], [-Infinity, 0, false],
    ["44.8", 20.4, false], [null, 20.4, false], [undefined, 20.4, false],
  ];
  for (const [lat, lon, valid] of cases) {
    const got = extractCoordinates({ type: "node", id: 1, lat: lat as number, lon: lon as number });
    assert.equal(got !== null, valid, `lat=${String(lat)} lon=${String(lon)}`);
  }
});

test("[coords] node reads lat/lon; way & relation read center; missing center -> null", () => {
  assert.deepEqual(extractCoordinates({ type: "node", id: 1, lat: 44.8, lon: 20.4 }), { lat: 44.8, lon: 20.4 });
  assert.deepEqual(extractCoordinates({ type: "way", id: 1, center: { lat: 44.8, lon: 20.4 } }), { lat: 44.8, lon: 20.4 });
  assert.deepEqual(extractCoordinates({ type: "relation", id: 1, center: { lat: 1, lon: 2 } }), { lat: 1, lon: 2 });
  assert.equal(extractCoordinates({ type: "way", id: 1 }), null);
  // a node that only carries `center` (not its own lat/lon) is still rejected
  assert.equal(extractCoordinates({ type: "node", id: 1, center: { lat: 44, lon: 20 } }), null);
  // half-coordinates never pass
  assert.equal(extractCoordinates({ type: "node", id: 1, lat: 44.8 }), null);
});

test("[coords] invalid coordinates -> invalid outcome; coordinates are never fabricated", () => {
  const r = toNormalizedVenue({ type: "node", id: 1, lat: 200, lon: 20, tags: { amenity: "bar", name: "X" } });
  assert.ok("invalid" in r);
  if ("invalid" in r) assert.match(r.invalid.reason, /coordinates/);
});

// ── address assembly ──────────────────────────────────────────────

test("[address] deterministic assembly across every subset; no 'undefined'/'null'/empty fragments", () => {
  const T = (t: Record<string, string>): string | null => extractAddress(t);
  assert.equal(T({}), null);
  assert.equal(T({ "addr:street": "Makedonska" }), "Makedonska");
  assert.equal(T({ "addr:housenumber": "115" }), "115");
  assert.equal(T({ "addr:street": "Makedonska", "addr:housenumber": "22" }), "Makedonska 22");
  assert.equal(T({ "addr:postcode": "11000", "addr:city": "Beograd" }), "11000 Beograd");
  assert.equal(T({ "addr:street": "Kralja Petra", "addr:housenumber": "1", "addr:postcode": "11000", "addr:city": "Beograd" }), "Kralja Petra 1, 11000 Beograd");
  // whitespace-only parts are dropped, not rendered as empty fragments
  assert.equal(T({ "addr:street": "   ", "addr:housenumber": "5" }), "5");
  assert.equal(T({ "addr:street": "Ulica", "addr:city": "   " }), "Ulica");
  assert.equal(T({ "addr:street": "  ", "addr:postcode": "  " }), null);
});

// ── website / opening_hours / wikidata cleaning ───────────────────

test("[cleanTag] website precedence, contact:website fallback, whitespace -> null", () => {
  assert.equal(ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "X", website: "  https://w  ", "contact:website": "https://c" } }).website, "https://w");
  assert.equal(ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "X", website: "   ", "contact:website": "https://c" } }).website, "https://c");
  const v = ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "X", opening_hours: "  Mo-Su 18:00-02:00 ", wikidata: " Q42 " } });
  assert.equal(v.openingHours, "Mo-Su 18:00-02:00");
  assert.equal(v.wikidata, "Q42");
  assert.equal(ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "X" } }).website, null);
});

// ── classification integration + error classification ────────────

test("[classify] invalid (bad data) beats excluded (classifier) beats accepted", () => {
  // nameless shop: caught as INVALID before the classifier would exclude it
  const nameless = toNormalizedVenue({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { shop: "bakery" } });
  assert.ok("invalid" in nameless);
  // named shop: usable data, classifier excludes it
  const named = toNormalizedVenue({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { shop: "bakery", name: "Pekara" } });
  assert.ok("excluded" in named);
  if ("excluded" in named) assert.equal(named.excluded.name, "Pekara");
});

test("[classify] rescue metadata (rescued / review / category / via) is copied through verbatim", () => {
  const v = ok({ type: "way", id: 150_590_534, center: { lat: 44.81, lon: 20.46 }, tags: { amenity: "restaurant", name: "Три шешира" } }, BELGRADE);
  assert.equal(v.rescued, true);
  assert.equal(v.review, true);
  assert.equal(v.category, "kafana");
  assert.match(v.acceptedVia ?? "", /^Layer C rescue: /);
});

test("[classify] a plain accepted venue has rescued:false / review:false (undefined normalized to false)", () => {
  const v = ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "Plain Bar" } });
  assert.equal(v.rescued, false);
  assert.equal(v.review, false);
  assert.equal(v.category, "bar");
});

// ── provenance / external identity ───────────────────────────────

test("[provenance] externalId / osmType / osmId / sourceUrl are deterministic and type-prefixed", () => {
  const n = ok({ type: "node", id: 42, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "X" } });
  assert.equal(n.externalId, "node/42");
  assert.equal(n.osmType, "node");
  assert.equal(n.osmId, 42);
  assert.equal(n.sourceUrl, "https://www.openstreetmap.org/node/42");

  // a node and a way sharing id 42 never collide (OSM types share an id space)
  const w = ok({ type: "way", id: 42, center: { lat: 44.8, lon: 20.4 }, tags: { amenity: "bar", name: "X" } });
  assert.equal(w.externalId, "way/42");
  assert.notEqual(n.externalId, w.externalId);
  assert.notEqual(n.sourceUrl, w.sourceUrl);
});

// ── object / reference safety ────────────────────────────────────

test("[purity] the input element and its tags are never mutated; repeated calls are deterministic", () => {
  const el: OverpassElement = {
    type: "node", id: 7, lat: 44.8, lon: 20.4,
    tags: { amenity: "nightclub", name: "  Klub X  ", website: "  https://x  ", opening_hours: "24/7" },
  };
  const snapshot = JSON.stringify(el);
  const a = toNormalizedVenue(el, BELGRADE);
  const b = toNormalizedVenue(el, BELGRADE);
  assert.equal(JSON.stringify(el), snapshot, "input element untouched");
  assert.deepEqual(a, b, "deterministic");

  // mutating the returned venue must not reach back into the input
  if ("ok" in a) {
    a.ok.name = "MUTATED";
    a.ok.latitude = 0;
    assert.equal(el.tags?.name, "  Klub X  ");
    assert.equal(el.lat, 44.8);
  }
});

// ── normalized-name persistence: the inline fallback vs the helper ─

test("[persistence] toNormalizedVenue's nameNormalized equals computeNameNormalized(name) for every accepted venue", () => {
  // normalize.ts line ~114 re-inlines `normalizeName(name) || name.toLowerCase()
  // .replace(/\s+/g," ").trim()` instead of calling computeNameNormalized. They
  // are the same expression today, so the persisted key (this path) equals a
  // backfilled key (ingest-venues.ts uses the helper). Pinned so a future edit
  // to one and not the other is caught here.
  for (const name of ["Drugstore", "Klub DOT", "Кафана Šešir", "20/44", "The Tube", "Три шешира"]) {
    const v = ok({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name } }, BELGRADE);
    assert.equal(v.nameNormalized, computeNameNormalized(v.name), name);
  }
});

// ── [latent] malformed elements the real source never produces ────

test("[latent] a null / non-string-tag element THROWS instead of returning { invalid } — pinned", () => {
  // Overpass always emits well-formed element objects with string tag values, and
  // the type is OverpassElement[] (non-null). But parse.ts's loop has no
  // try/catch, so one such entry would abort the whole city's ingestion rather
  // than being recorded as a single invalid. The `element && …` guard in the
  // `ref` line shows the intent; a one-line `typeof element !== "object"` check
  // would complete it. Left unchanged — not reachable from the real source.
  assert.throws(() => toNormalizedVenue(null as unknown as OverpassElement), /Cannot read properties of null/);
  assert.throws(
    () => toNormalizedVenue({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { name: 42 as unknown as string } }),
    /is not a function/,
  );
  // a null-valued tag IS handled gracefully (optional chaining short-circuits)
  const r = toNormalizedVenue({ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "X", website: null as unknown as string } });
  assert.ok("ok" in r);
  if ("ok" in r) assert.equal(r.ok.website, null);
});
