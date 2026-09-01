-- Initial schema for the Nightlife App
-- Core entities: venues, events, plus supporting lookup/reference tables
-- (countries, cities, music_genres, data_sources) and their join tables.

create extension if not exists pgcrypto;

-- ── countries ────────────────────────────────────────────────────────────
create table public.countries (
  id text primary key,               -- ISO 3166-1 alpha-2, e.g. "RS"
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── cities ───────────────────────────────────────────────────────────────
create table public.cities (
  id uuid primary key default gen_random_uuid(),
  country_id text not null references public.countries(id),
  name text not null,
  latitude numeric(9,6),
  longitude numeric(9,6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (country_id, name)
);

create index cities_country_id_idx on public.cities(country_id);

-- ── music_genres ─────────────────────────────────────────────────────────
create table public.music_genres (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- ── data_sources ─────────────────────────────────────────────────────────
create table public.data_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null,                -- 'manual' | 'api' | 'scraper'
  base_url text,
  created_at timestamptz not null default now()
);

-- ── venues ───────────────────────────────────────────────────────────────
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id),
  name text not null,
  description text,
  address text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  opening_time time,
  closing_time time,
  is_active boolean not null default true,
  source_id uuid references public.data_sources(id),
  external_id text,
  source_url text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id)
);

create index venues_city_id_idx on public.venues(city_id);

-- ── venue_music_genres (many-to-many) ───────────────────────────────────
create table public.venue_music_genres (
  venue_id uuid not null references public.venues(id) on delete cascade,
  genre_id uuid not null references public.music_genres(id) on delete cascade,
  primary key (venue_id, genre_id)
);

create index venue_music_genres_genre_id_idx on public.venue_music_genres(genre_id);

-- ── events ───────────────────────────────────────────────────────────────
create table public.events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  title text not null,
  description text,
  start_at timestamptz not null,
  end_at timestamptz,
  cover_image_url text,
  ticket_url text,
  is_cancelled boolean not null default false,
  source_id uuid references public.data_sources(id),
  external_id text,
  source_url text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id)
);

create index events_venue_id_idx on public.events(venue_id);
create index events_start_at_idx on public.events(start_at);

-- ── event_music_genres (many-to-many) ───────────────────────────────────
create table public.event_music_genres (
  event_id uuid not null references public.events(id) on delete cascade,
  genre_id uuid not null references public.music_genres(id) on delete cascade,
  primary key (event_id, genre_id)
);

create index event_music_genres_genre_id_idx on public.event_music_genres(genre_id);

-- ── Row Level Security ───────────────────────────────────────────────────
-- Public (anon + authenticated) can read everything; no insert/update/delete
-- policies are defined, so only the service role (which bypasses RLS) can
-- write. This is the intended path for future automated ingestion jobs.

alter table public.countries enable row level security;
alter table public.cities enable row level security;
alter table public.music_genres enable row level security;
alter table public.data_sources enable row level security;
alter table public.venues enable row level security;
alter table public.venue_music_genres enable row level security;
alter table public.events enable row level security;
alter table public.event_music_genres enable row level security;

create policy "Public can read countries" on public.countries
  for select using (true);

create policy "Public can read cities" on public.cities
  for select using (true);

create policy "Public can read music_genres" on public.music_genres
  for select using (true);

create policy "Public can read data_sources" on public.data_sources
  for select using (true);

create policy "Public can read venues" on public.venues
  for select using (true);

create policy "Public can read venue_music_genres" on public.venue_music_genres
  for select using (true);

create policy "Public can read events" on public.events
  for select using (true);

create policy "Public can read event_music_genres" on public.event_music_genres
  for select using (true);
