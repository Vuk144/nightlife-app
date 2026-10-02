-- Source lifecycle state for venues (OSM venue reconciliation).
--
-- The sync engine already models a source record's lifecycle as
-- active → stale → missing → gone (ingestion/src/sync/reconcile.ts), counting
-- consecutive misses from HEALTHY, COMPLETE source snapshots. Until now the
-- schema could not persist that state, so every run restarted at "1 miss".
-- These two columns persist it for the venue's owning source
-- (venues.source_id / external_id).
--
-- Purely additive: two new NOT NULL columns with constant defaults (every
-- existing row becomes 'active' with 0 misses — exactly the state the pipeline
-- assumed so far) and two CHECK constraints. No row is deleted or rewritten
-- beyond receiving the defaults, no existing column changes, and the events
-- table (including events.venue_id ON DELETE CASCADE) is untouched — the
-- lifecycle deactivates a venue (is_active = false), it never deletes one.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS and guarded constraint creation.

alter table public.venues
  add column if not exists source_status      text    not null default 'active',
  add column if not exists consecutive_misses integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'venues_source_status_check') then
    alter table public.venues
      add constraint venues_source_status_check
      check (source_status in ('active', 'stale', 'missing', 'gone'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_consecutive_misses_check') then
    alter table public.venues
      add constraint venues_consecutive_misses_check
      check (consecutive_misses >= 0);
  end if;
end $$;

comment on column public.venues.source_status is
  'Lifecycle of this venue in its owning source (source_id): ''active'' (in the latest healthy complete snapshot), ''stale'' (missed 1×), ''missing'' (missed 2×), ''gone'' (missed 3×; the sync sets is_active = false). Reset to ''active'' when the source returns the venue again. Only changed by healthy, complete sync runs.';
comment on column public.venues.consecutive_misses is
  'Consecutive healthy, complete source snapshots that did not contain this venue. Reset to 0 when the source returns it. Frozen once source_status = ''gone''.';
