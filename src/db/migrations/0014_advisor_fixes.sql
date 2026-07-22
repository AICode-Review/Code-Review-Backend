-- 0014_advisor_fixes.sql — Supabase Security/Performance advisor findings, triaged:
-- the "RLS enabled, no policy" findings on platform_tokens/symbols/chunks/
-- bitbucket_connect_installations/webhook_deliveries are intentional (backend/service-role
-- only) and are NOT touched here — this migration only addresses genuine gaps.

-- ---------------------------------------------------------------- 1. schema_migrations (CRITICAL)
-- Our own hand-rolled migration tracker (db/migrate.ts) had no RLS at all, so it was
-- readable/writable through the PostgREST API by anon/authenticated. It's created by the
-- migration runner itself before any migration file runs, so it always exists by this point.
-- No policies needed — the runner connects directly via DATABASE_URL as the table owner,
-- which bypasses RLS regardless; this only blocks the exposed PostgREST roles.
alter table if exists schema_migrations enable row level security;

-- ---------------------------------------------------------------- 2. match_chunks search_path
-- Function Search Path Mutable — an unpinned search_path lets a schema earlier in the
-- caller's search_path shadow objects this function references (chunks, in this case).
create or replace function match_chunks(
  p_repo_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 12
)
returns table (
  id uuid,
  path text,
  start_line int,
  end_line int,
  similarity float
)
language sql stable
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.path,
    c.start_line,
    c.end_line,
    1 - (c.embedding <=> p_query_embedding) as similarity
  from chunks c
  where c.repo_id = p_repo_id
    and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- ---------------------------------------------------------------- 3. Auth RLS Initialization Plan
-- Bare auth.uid() in a policy/function is re-evaluated per row; wrapping it as
-- (select auth.uid()) lets Postgres hoist it into a one-time InitPlan instead. Same fix
-- applied both where the advisor flagged it directly (users_select_self) and in
-- app.is_org_member(), since every other table's RLS policy routes through that function.
create or replace function app.is_org_member(target_org uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
begin
  return exists (
    select 1
    from public.org_members m
    join public.users u on u.id = m.user_id
    where m.org_id = target_org
      and u.auth_user_id = (select auth.uid())
  );
end;
$$;

alter policy users_select_self on users
  using (auth_user_id = (select auth.uid()));

-- ---------------------------------------------------------------- 4. Unindexed foreign keys
create index if not exists learning_events_repo_idx on learning_events (repo_id);
create index if not exists learning_events_finding_idx on learning_events (finding_id);
create index if not exists org_invites_invited_by_idx on org_invites (invited_by);
create index if not exists org_members_user_idx on org_members (user_id);
create index if not exists rulebook_rules_repo_idx on rulebook_rules (repo_id);
create index if not exists review_runs_source_run_idx on review_runs (source_run_id);
