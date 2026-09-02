-- Widen venues.latitude/longitude to double precision and populate known
-- coordinates.
--
-- latitude/longitude already exist on public.venues (numeric(9,6), added in
-- 20260901161117_initial_schema.sql) and are NULL for every current row, so
-- widening the type here is lossless. double precision gives full floating
-- point precision for later distance/routing calculations, instead of the
-- numeric(9,6) cap of 6 digits after the decimal point.
--
-- Only venues with reliably known coordinates are populated here (Drugstore
-- and KST, both in Belgrade). Every other venue (20/44, GIGS, The Quarter,
-- Paradise Garage) is intentionally left with latitude/longitude NULL rather
-- than guessed.
--
-- Idempotent: ALTER COLUMN ... TYPE is safe to re-run (a no-op once the
-- column is already double precision), and the UPDATEs target rows by
-- name/city, so re-running this migration after a successful run just
-- re-applies the same values.

alter table public.venues
  alter column latitude type double precision,
  alter column longitude type double precision;

update public.venues v
set latitude = 44.8185264,
    longitude = 20.4883570
from public.cities c
where v.city_id = c.id
  and c.country_id = 'RS'
  and c.name = 'Belgrade'
  and v.name = 'Drugstore';

update public.venues v
set latitude = 44.8055631,
    longitude = 20.4762304
from public.cities c
where v.city_id = c.id
  and c.country_id = 'RS'
  and c.name = 'Belgrade'
  and v.name = 'KST';
