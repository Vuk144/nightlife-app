-- Grant the server-side ingestion role (service_role) the privileges it needs.
--
-- Context: this project's schema was built by hand. 20260901180000_grant_public_read.sql
-- granted SELECT to anon/authenticated only; `service_role` -- the privileged,
-- RLS-bypassing role that Supabase's secret/service key authenticates as -- was
-- never granted SELECT/INSERT/UPDATE/DELETE on any public table, so a server-side
-- client (the ingestion runner) gets `42501 permission denied` on its first query.
-- The project's default privileges are also skewed (service_role currently gets
-- only TRUNCATE/REFERENCES/TRIGGER on new tables).
--
-- This migration restores service_role to Supabase's standard access model:
--   * full table + sequence privileges in schema public, now;
--   * default privileges so tables/sequences added by later migrations are covered.
--
-- It does NOT change anon or authenticated in any way. They keep SELECT-only,
-- still enforced by the existing "Public can read ..." RLS policies. No INSERT,
-- UPDATE, DELETE, or other write privilege is granted to anon or authenticated,
-- and no RLS policy is added, altered, or dropped.
--
-- service_role already has BYPASSRLS, so RLS policies are unaffected. The secret
-- key is used only by the server-side ingestion runner, never the Expo app.
--
-- Idempotent: GRANT / ALTER DEFAULT PRIVILEGES are no-ops when already present.

grant usage on schema public to service_role;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

alter default privileges in schema public
  grant all on tables to service_role;

alter default privileges in schema public
  grant all on sequences to service_role;
