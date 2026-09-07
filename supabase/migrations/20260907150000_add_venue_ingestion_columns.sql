-- Additive schema changes for the first real-data ingestion pilot
-- (OpenStreetMap nightlife venues for Belgrade).
--
-- This migration ONLY adds nullable columns, one index, two data_sources
-- columns, and one reference row. It does not restructure or drop any table
-- or column, does not delete any row, and does not touch earlier migrations.
--
-- Idempotent: every statement is guarded (ADD COLUMN IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS / ON CONFLICT), so re-running after a successful
-- run is a no-op.

-- ── venues: matching + provenance columns ───────────────────────────────
alter table public.venues
  add column if not exists name_normalized    text,
  add column if not exists coordinates_source text,
  add column if not exists website            text,
  add column if not exists opening_hours      text,
  add column if not exists wikidata           text;

comment on column public.venues.name_normalized is
  'Deterministic lowercase / de-accented / transliterated form of name. Maintained by the ingestion pipeline and used only for within-city deterministic matching. NULL until first computed.';
comment on column public.venues.coordinates_source is
  'Origin of latitude/longitude: ''manual'' (hand-entered, never overwritten by a sync), ''source'' (from a data source such as OSM), ''geocoded'' (future). NULL = unknown / no coordinates.';
comment on column public.venues.website is
  'Venue website URL from the source when available.';
comment on column public.venues.opening_hours is
  'Raw opening-hours string from the source (e.g. OSM opening_hours syntax). Distinct from the structured opening_time/closing_time columns.';
comment on column public.venues.wikidata is
  'Wikidata QID from the source when available (e.g. OSM wikidata tag). Durable cross-reference key.';

-- Every row that currently has coordinates received them from
-- 20260902120000_venue_coordinates.sql, a hand-written seed. Mark those as
-- manually maintained so the ingestion pipeline never overwrites them.
update public.venues
   set coordinates_source = 'manual'
 where latitude is not null
   and longitude is not null
   and coordinates_source is null;

-- Within-city deterministic name-match lookup.
create index if not exists venues_city_name_normalized_idx
  on public.venues (city_id, name_normalized);

-- ── data_sources: attribution + licence ────────────────────────────────
alter table public.data_sources
  add column if not exists attribution text,
  add column if not exists license     text;

comment on column public.data_sources.attribution is
  'Human-readable credit string to display wherever this source''s data is shown (e.g. "© OpenStreetMap contributors").';
comment on column public.data_sources.license is
  'Short licence identifier for the source data (e.g. "ODbL", "CC0", "CC-BY-4.0").';

-- ── OpenStreetMap source row ──────────────────────────────────────────
-- One global row (not per-city). The ingestion runner references it by name.
insert into public.data_sources (name, type, base_url, attribution, license)
values (
  'OpenStreetMap',
  'api',
  'https://overpass-api.de/api/interpreter',
  '© OpenStreetMap contributors',
  'ODbL'
)
on conflict (name) do update
  set type        = excluded.type,
      base_url    = excluded.base_url,
      attribution = excluded.attribution,
      license     = excluded.license;
