/// <reference types="node" />
// Run: npm test  (node:test with Node's built-in TypeScript type stripping)
import assert from "node:assert/strict";
import { test } from "node:test";
import { queryActiveVenues } from "./venue-query.ts";

type Row = Record<string, unknown>;

/** A fake of the PostgREST builder chain used by the query, applying its `eq` filters to `rows`. */
function fakeClient(rows: Row[], error: { message: string } | null = null) {
  const calls: string[] = [];
  const filters: [string, unknown][] = [];
  const builder = {
    select(columns: string) {
      calls.push(`select ${columns}`);
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.push(`eq ${column}=${String(value)}`);
      filters.push([column, value]);
      return builder;
    },
    order(column: string) {
      calls.push(`order ${column}`);
      return builder;
    },
    returns() {
      const data = rows
        .filter((r) => filters.every(([c, v]) => r[c] === v))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return Promise.resolve(error ? { data: null, error } : { data, error: null });
    },
  };
  const client = {
    from(table: string) {
      calls.push(`from ${table}`);
      return builder;
    },
  };
  return { client: client as unknown as Parameters<typeof queryActiveVenues>[0], calls };
}

const row = (id: string, name: string, isActive: boolean): Row => ({
  id,
  name,
  closing_time: "04:00:00",
  is_active: isActive,
  latitude: 44.8,
  longitude: 20.46,
  cities: { name: "Belgrade", country_id: "RS" },
  music_genres: [{ name: "Techno" }],
});

test("is_active = false venues are excluded by the query; active venues are returned and mapped", async () => {
  const { client, calls } = fakeClient([
    row("v-1", "Drugstore", true),
    row("v-2", "Gone Bar", false), // e.g. deactivated by the OSM lifecycle (gone)
    row("v-3", "Barutana", true),
    row("v-4", "Hidden Club", false), // e.g. hidden by a curator
  ]);

  const venues = await queryActiveVenues(client);

  assert.deepEqual(venues.map((v) => v.id), ["v-3", "v-1"], "only active venues, ordered by name");
  assert.ok(calls.includes("eq is_active=true"), "filtered at the query boundary, not in the UI");
  assert.deepEqual(calls[0], "from venues");
  assert.deepEqual(venues[0], {
    id: "v-3",
    name: "Barutana",
    country: "RS",
    city: "Belgrade",
    musicGenres: ["Techno"],
    closingTime: "04:00",
    latitude: 44.8,
    longitude: 20.46,
  });
});

test("all venues active → all returned (nothing else filtered)", async () => {
  const { client } = fakeClient([row("a", "A", true), row("b", "B", true)]);
  assert.deepEqual((await queryActiveVenues(client)).map((v) => v.id), ["a", "b"]);
});

test("a query error still throws", async () => {
  const { client } = fakeClient([], { message: "boom" });
  await assert.rejects(queryActiveVenues(client), /Failed to fetch venues: boom/);
});
