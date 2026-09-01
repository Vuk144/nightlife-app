-- Grant the SQL-level privileges that PostgREST requires for public read access.
--
-- The initial schema migration (20260901161117_initial_schema.sql) enables RLS
-- and adds "Public can read ..." SELECT policies, but RLS policies only take
-- effect once the role also holds the underlying table privilege. Without these
-- GRANTs the API roles hit `42501 permission denied for table ...` before RLS
-- is ever evaluated.
--
-- This migration adds privileges only. It does not create, alter, or drop any
-- table, column, constraint, policy, or row of data.
--
-- Idempotent: GRANT / ALTER DEFAULT PRIVILEGES are no-ops when the privilege is
-- already present, so re-running this migration is safe.

-- Let the API roles resolve objects in the public schema.
grant usage on schema public to anon, authenticated;

-- Read access to every table that currently exists in public. Row visibility is
-- still governed by each table's RLS policies.
grant select on all tables in schema public to anon, authenticated;

-- Apply the same read grant automatically to tables created in public later,
-- when created by the current (migration) role.
alter default privileges in schema public grant select on tables to anon, authenticated;
