-- 0005_grants.sql — explicit role grants.
--
-- Tables created via a direct `psql`/`pg` connection (as our migration
-- runner does) don't automatically pick up the privilege grants Supabase's
-- own tooling normally applies on table creation. RLS policies restrict
-- which ROWS a role can see; they don't substitute for the base GRANT a
-- role needs on the table itself. `service_role` bypasses RLS (a role
-- attribute, set by Supabase outside this migration) but still needs
-- ordinary object grants — that's what was missing.

grant usage on schema public to service_role, authenticated, anon;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

-- authenticated only ever needs to SELECT — RLS policies from 0001 already
-- restrict that to org-scoped rows; writes always go through the backend's
-- service_role.
grant select on all tables in schema public to authenticated;

-- Keep future tables (from later migrations) covered automatically too.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant select on tables to authenticated;
