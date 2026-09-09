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
| `npm run ingest:dry` | Venues: fetch + normalize + match, print the summary, **write nothing** |
| `npm run ingest` | The same, then insert/update `venues` |
| `npm run ingest:events:dry -- --source gigstix [--limit N] [--verbose]` | Events: discover + fetch + parse + relevance + venue resolution, print an auditable plan, **write nothing** |
| `npm test` | Parser + normalization + event unit tests (no network) |
| `npm run typecheck` | `tsc --noEmit` |

## Events (`src/events/`) — dry run only

`src/events/` is the multi-source event ingestion foundation. It is **read-only**:
it reads GIGS TIX over HTTP and reads `venues` / `cities` from Supabase to
resolve venues, but performs **no writes**, applies **no migration**, and runs
**no scheduler**.

- `types.ts` — the `EventSourceAdapter` contract (`discover` → `fetch` → `parse`)
  and `NormalizedEvent`.
- `adapters/gigstix*.ts` — GIGS TIX (`new.gigstix.com`): sitemap discovery,
  polite fetch, pure HTML parser (no schema.org `Event` data is published, so
  the parser is anchored on the Event Champ theme's semantic `gt-*` classes and
  Serbian field labels).
- `relevance.ts` — deterministic music / nightlife filter (rejects theatre,
  fairs, lectures, sport, kids…); every rejection carries a reason.
- `venue-resolve.ts` — **event-first venue resolution**: `matched_existing` /
  `safe_new_venue` / `needs_review` / `rejected`. Reuses `../matching.ts`
  (tiers 0–4) and `../aliases.ts` UNCHANGED, read-only. Enriches an unmatched
  venue with the source's own venue page (address + coordinates) via the
  adapter's optional `fetchSourceVenue`; a `safe_new_venue` needs a trusted
  source, an enabled city (`EVENT_FIRST_CITIES`, default `Belgrade`), a
  primary music signal, a non-placeholder name and coordinates-or-address.
- `event-first.ts` — run-level: dedupes candidates (source venue id → name+city
  → name+city+address, never coordinates alone) and applies the per-run safety
  cap (`EVENT_FIRST_MAX_NEW_VENUES`, default 50; excess → `needs_review`).
- `adapters/gigstix-venue-parse.ts` — pure parser for a GIGS TIX `/venue/<slug>/`
  page (name, WordPress id, address, `data-lat`/`data-lng`, city).
- `identity.ts` — per-source identity key + a cross-source dedup band
  classifier (built, unit-tested, **not** wired to any write path yet).
- `engine.ts` / `report.ts` / `index.ts` — orchestration, formatting, CLI.

Config env overrides: `EVENT_FIRST_CITIES`, `EVENT_FIRST_MAX_NEW_VENUES`,
`EVENT_FIRST_TRUSTED_SOURCES`, `GIGSTIX_BASE_URL`, `INGEST_USER_AGENT`.

## Generic sync engine (`src/sync/`) — architecture only

`src/sync/` is a source-agnostic, multi-country synchronization engine. The
generic pipeline (`planSync`) and change detection / reconciliation are done;
`SupabaseCanonicalStore` persists a `SyncPlan` to the CURRENT Supabase schema.
**No migrations, no scheduling, no live ingestion yet.** The existing `events/`
and venue pipelines are untouched.

- `types.ts` — the whole generic contract: `SourceAdapter`, `NormalizedRecord`,
  `ConfigProvider`, `CanonicalStore`, `SyncPlan`, `ChangeStatus`,
  `ReconciliationPlan`, `SyncRunStats`.
- `config.ts` — data-driven `ConfigProvider`. Countries, cities, sources,
  aliases, scope, trust and schedule are DATA. `resolveCity` maps a free-text
  city string to a canonical city with **no city/country name in its body**.
- `normalization.ts` — per-country name profiles (`latin` default; `sr`
  delegates to `../name.ts`, unchanged).
- `venue-identity.ts` / `event-identity.ts` — thin adapters over the existing
  `../matching.ts#resolveMatch` (tiers 0–4) and
  `../events/identity.ts#compareEvents`. No parallel matcher.
- `change-detection.ts` — `detectChange` (NEW / UPDATED / UNCHANGED /
  REJECTED / NEEDS_REVIEW) with content-hash + field-level deltas.
- `reconcile.ts` — `planReconciliation`. A failed / unhealthy run reconciles
  nothing; disappearance is `active → stale → missing → gone`, never a
  cancellation; past events are frozen; nothing is hard-deleted.
- `store.ts` — the `CanonicalStore` port + `InMemoryCanonicalStore` + the
  canonical `comparable()` / `venueComparable()` / `eventComparable()`
  projections (fields the current schema stores AND can reconstruct).
- `canonical-hash.ts` — stable content hash over the comparable fields. Drives
  NEW / UPDATED / UNCHANGED without a `content_hash` column.
- `time-zone.ts` — local wall-clock → UTC instant (DST-aware, zero-dep), for
  `events.start_at` and for a stable event comparison basis.
- `supabase-store.ts` — **`SupabaseCanonicalStore`**. Reads
  countries/cities/venues/events; `apply()` performs explicit per-operation
  writes (insert / update / link-only) against the CURRENT schema. Idempotent
  on `(source_id, external_id)`. Updates set only positively-asserted fields
  (never nulls a value), bump `updated_at` / `last_synced_at`, and never delete.
  Every Supabase error halts `apply` with a context-rich `SyncApplyError`.
  Anything the current schema cannot represent (multi-source links,
  reconciliation lifecycle state, event-first unresolved venues, postponed /
  rescheduled) is recorded in `SyncApplyResult.deferred`, not forced.
- `engine.ts` — `planSync`: one source through the whole pipeline, reads only.
- `adapters/in-memory.ts` — a fixture `SourceAdapter` for tests.

Tests:
- `test/sync/zagreb.test.ts` — Croatia/Zagreb through the identical `planSync`
  path as Serbia/Belgrade; asserts the engine core has no geography branch.
- `test/sync/supabase-store.test.ts` — the real store against a deterministic
  fake PostgREST client (`fake-supabase.ts`): read/insert/update/link,
  idempotency, "UNCHANGED writes no content", no-delete, error surfacing.
- `test/sync/integration/*.integration.test.ts` — OPT-IN real-Supabase
  read-after-write (NEW → UPDATED → UNCHANGED). Skipped unless
  `SYNC_INTEGRATION=1`. Fully isolated: only touches rows under its own
  `sync-int-test` data source and hard-cleans them (incl. the source row) in
  `after`. Run: `SYNC_INTEGRATION=1 npm test`.

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
