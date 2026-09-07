# nightlife-ingestion

Standalone data-ingestion runner for the nightlife app.

It reads venue data from public sources (currently OpenStreetMap via the
Overpass API) and writes it into the app's Supabase database. It is a plain
Node/TypeScript project — **not** part of the Expo app, never imported by it,
never bundled into it.

## Architecture rules

- The **service-role key lives only here**, in `ingestion/.env` (git-ignored).
  It must never appear in the Expo app, in an `EXPO_PUBLIC_*` variable, or in
  a committed file.
- The mobile app stays **read-only** (anon/publishable key). This runner is the
  only component that writes.
- Ingestion targets are **configuration, not code**: see `src/targets.ts`.
  The OpenStreetMap area/relation id is only a query boundary for Overpass —
  it is never stored and never seen by the app.

## Setup

```sh
cd ingestion
cp .env.example .env      # then fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
```

The database migration `supabase/migrations/20260907150000_add_venue_ingestion_columns.sql`
must be applied to the target Supabase project before the first run.

## Commands

| Command | What it does |
| --- | --- |
| `npm run ingest:dry` | Fetch + normalize + match, print the summary, **write nothing** |
| `npm run ingest` | The same, then insert/update `venues` |
| `npm test` | Parser + normalization unit tests (no network) |
| `npm run typecheck` | `tsc --noEmit` |

## What one run does (per target city)

1. Resolve the `OpenStreetMap` row in `data_sources` (create if missing).
2. Resolve the city row in `cities` (`country_id` + `name`). This milestone
   does not create cities.
3. Fetch nightlife venues from Overpass for the city's OSM area
   (`amenity=nightclub`, `amenity=music_venue`, `club=music`).
4. Normalize each element: name, `name_normalized`, coordinates
   (node `lat`/`lon`, way/relation `center`), address from `addr:*`, website,
   `opening_hours`, `wikidata`, and the `osm_type/osm_id` external id.
5. Backfill `name_normalized` on existing city venues that lack it.
6. Match each venue: `(source_id, external_id)` first, then a single exact
   `city_id + name_normalized`. More than one match → skipped (never merged).
7. Insert new venues; update only changed fields on existing ones. Coordinates
   with `coordinates_source = 'manual'` are never overwritten.
8. Print `Fetched / Inserted / Updated / Unchanged / Skipped / Invalid`.

Events, scheduling, geocoding, and genre ingestion are out of scope here.
