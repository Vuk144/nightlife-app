import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildOverpassQuery,
  parseOverpassVenues,
} from "../src/sources/osm-overpass.ts";
import type { IngestionTarget } from "../src/targets.ts";
import type { OverpassResponse } from "../src/types.ts";

const BELGRADE: IngestionTarget = {
  countryId: "RS",
  cityName: "Belgrade",
  osmRelationId: 2728438,
};

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/overpass-belgrade.sample.json", import.meta.url),
    "utf8",
  ),
) as OverpassResponse;

test("buildOverpassQuery: scopes to the area, whitelisted values only", () => {
  const q = buildOverpassQuery(BELGRADE);

  assert.match(q, /area\(id:3602728438\)/);
  assert.match(q, /out tags center;/);

  // Layer A
  assert.match(q, /"amenity"="nightclub"/);
  assert.match(q, /"amenity"="bar"/);
  assert.match(q, /"amenity"="pub"/);
  assert.match(q, /"amenity"="biergarten"/);
  assert.match(q, /"amenity"="music_venue"/);
  assert.match(q, /"amenity"="karaoke_box"/);
  assert.match(q, /"club"~"\^\(music\|nightlife\|social\)\$"/);

  // regional name layers
  assert.match(q, /"name"~"[^"]*kafana[^"]*",i/);
  assert.match(q, /"name"~"[^"]*splav[^"]*",i/);
  assert.match(q, /"name"~"[^"]*shisha[^"]*",i/);

  // Layer B — signal-gated, incl. arts_centre, concert_hall, community_centre=music
  assert.match(q, /arts_centre/);
  assert.match(q, /"theatre:type"~"\^\(concert_hall\|music\|cabaret\)\$"/);
  assert.match(q, /"community_centre"~"\^\(music\|arts\|youth_centre\)\$"/);
  assert.match(q, /\["concert"="yes"\]/);
  assert.match(q, /\["dancing"="yes"\]/);

  // Layer C — every Belgrade rescue entry now has a confirmed osmRef, so the
  // query fetches them by id (no name clause needed).
  assert.match(q, /way\(id:[0-9,]*41234985/); // Dom omladine
  assert.match(q, /node\(id:[0-9,]*12872107296/); // SKC
  assert.match(q, /node\(id:[0-9,]*6782874303/); // Dorian Grey

  // never a bare key, never an excluded category
  assert.doesNotMatch(q, /nwr\["amenity"\]\(/);
  assert.doesNotMatch(q, /fast_food|cinema|casino|conference_centre/);
});

test("parseOverpassVenues: v2 fixture split (no target)", () => {
  const { venues, invalid, excluded } = parseOverpassVenues(fixture);
  const byId = Object.fromEntries(venues.map((v) => [v.externalId, v]));

  assert.equal(byId["node/1001"].category, "nightclub");
  assert.equal(byId["relation/3003"].category, "nightclub");
  assert.equal(byId["node/7007"].category, "kafana");
  assert.equal(byId["node/8008"].category, "bar");
  assert.equal(byId["node/9009"].category, "concert_hall");
  assert.equal(byId["node/1011"].category, "other_nightlife"); // splav restaurant + "cocktail bar" name
  assert.equal(byId["node/1011"].review, true);
  assert.equal(byId["node/1012"].name, "Кафић без имена"); // name:sr fallback

  // no target -> Dom omladine (arts_centre, no signal) is excluded
  assert.ok(excluded.some((e) => e.ref === "way/41234985"));
  // splav restaurant with no signal / no drinking-venue name -> excluded
  assert.ok(
    excluded.some((e) => e.ref === "node/1013" && /splav/.test(e.reason)),
    "Splav Riblji Restoran must be excluded",
  );
  // ordinary restaurant + cafe-with-only-bar=yes
  assert.ok(excluded.some((e) => e.ref === "node/6006"));
  assert.ok(excluded.some((e) => e.ref === "node/1010" && /weak signal/.test(e.reason)));

  assert.equal(venues.length, 7);
  assert.equal(invalid.length, 2);
  assert.equal(excluded.length, 4);
});

test("parseOverpassVenues: with a target, Layer C rescue fires by osmRef", () => {
  const { venues } = parseOverpassVenues(fixture, BELGRADE);
  const dom = venues.find((v) => v.externalId === "way/41234985");
  assert.ok(dom, "Dom omladine (way/41234985) should be rescued");
  assert.equal(dom!.category, "concert_hall");
  assert.equal(dom!.rescued, true);
  assert.equal(venues.length, 8);
});

test("parseOverpassVenues: tolerates an empty / missing elements array", () => {
  assert.deepEqual(parseOverpassVenues({}), { venues: [], invalid: [], excluded: [] });
  assert.deepEqual(parseOverpassVenues({ elements: [] }), {
    venues: [],
    invalid: [],
    excluded: [],
  });
});
