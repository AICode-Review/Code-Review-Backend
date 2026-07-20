-- 0001_init.sql — full schema from DESIGN.md §5
-- Assumes Supabase Postgres (auth schema, authenticated role). Guards below let it
-- also run on bare Postgres for CI.

create extension if not exists pgcrypto;
create extension if not exists vector;

-- Roles that exist on Supabase; create no-login stand-ins on bare Postgres.
do $$ begin
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

-- ---------------------------------------------------------------- core tables

create table orgs (
  id          uuid primary key default gen_random_uuid(),
  platform    text not null check (platform in ('github', 'bitbucket')),
  external_id text not null,
  name        text not null,
  plan        text not null default 'free',
  seats       int  not null default 0,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (platform, external_id)
);

create table users (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,          -- links to Supabase auth.users(id)
  external_id  text unique,
  handle       text,
  seat_active  boolean not null default false,
  created_at   timestamptz not null default now()
);

create table org_members (
  org_id  uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role    text not null default 'member' check (role in ('owner', 'admin', 'member')),
  primary key (org_id, user_id)
);

create table repos (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  external_id    text not null,
  name           text not null,
  default_branch text not null default 'main',
  tier1_langs    text[] not null default '{}',
  config         jsonb not null default '{}'::jsonb,
  index_status   text not null default 'none' check (index_status in ('none', 'indexing', 'ready', 'stale', 'failed')),
  indexed_sha    text,
  created_at     timestamptz not null default now(),
  unique (org_id, external_id)
);

create table pull_requests (
  id           uuid primary key default gen_random_uuid(),
  repo_id      uuid not null references repos(id) on delete cascade,
  number       int  not null,
  head_sha     text,
  state        text not null default 'open',
  review_state text not null default 'idle' check (review_state in ('idle', 'queued', 'reviewing', 'reviewed', 'paused')),
  opened_by    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (repo_id, number)
);

create table review_runs (
  id           uuid primary key default gen_random_uuid(),
  pr_id        uuid not null references pull_requests(id) on delete cascade,
  head_sha     text not null,
  status       text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  candidates   int not null default 0,
  verified     int not null default 0,
  posted       int not null default 0,
  digest       int not null default 0,
  llm_cost_usd numeric(10, 4) not null default 0,
  latency_ms   int,
  error        text
);
create index review_runs_pr_idx on review_runs (pr_id, started_at desc);

create table findings (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references review_runs(id) on delete cascade,
  pass                text not null,
  category            text not null,
  severity            text not null check (severity in ('critical', 'major', 'minor')),
  confidence          numeric(4, 3) not null default 0,
  path                text not null,
  start_line          int not null,
  end_line            int not null,
  title               text not null,
  body_md             text not null,
  verification_method text,
  verification_status text not null default 'skipped' check (verification_status in ('verified', 'rejected', 'skipped')),
  posted              boolean not null default false,
  comment_external_id text,
  feedback            text check (feedback in ('accepted', 'dismissed', 'fixed', 'ignored')),
  fingerprint         text not null,
  created_at          timestamptz not null default now()
);
create index findings_run_idx on findings (run_id);
create index findings_fingerprint_idx on findings (fingerprint);

create table learning_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  repo_id      uuid references repos(id) on delete cascade,
  finding_id   uuid references findings(id) on delete set null,
  event_type   text not null,
  comment_text text,
  created_at   timestamptz not null default now()
);
create index learning_events_org_idx on learning_events (org_id, created_at desc);

create table rulebook_rules (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  repo_id        uuid references repos(id) on delete cascade,
  source         text not null check (source in ('learned', 'manual')),
  rule_text      text not null,
  category       text not null,
  weight         numeric(4, 3) not null default 1,
  active         boolean not null default false,
  evidence_count int not null default 0,
  created_at     timestamptz not null default now()
);
create index rulebook_rules_org_idx on rulebook_rules (org_id);

create table symbols (
  id         uuid primary key default gen_random_uuid(),
  repo_id    uuid not null references repos(id) on delete cascade,
  path       text not null,
  kind       text not null,
  name       text not null,
  signature  text,
  start_line int not null,
  end_line   int not null,
  sha        text not null,
  meta       jsonb not null default '{}'::jsonb
);
create index symbols_repo_path_idx on symbols (repo_id, path);
create index symbols_repo_name_idx on symbols (repo_id, name);

create table chunks (
  id           uuid primary key default gen_random_uuid(),
  repo_id      uuid not null references repos(id) on delete cascade,
  path         text not null,
  start_line   int not null,
  end_line     int not null,
  content_hash text not null,
  embedding    vector(1536),
  sha          text not null
);
create index chunks_repo_path_idx on chunks (repo_id, path);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

create table health_snapshots (
  id      uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos(id) on delete cascade,
  week    date not null,
  metrics jsonb not null default '{}'::jsonb,
  unique (repo_id, week)
);

create table subscriptions (
  org_id             uuid primary key references orgs(id) on delete cascade,
  stripe_customer_id text,
  stripe_sub_id      text,
  status             text not null default 'none',
  seats              int not null default 0,
  tier               text not null default 'free'
);

create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  actor      text not null,
  action     text not null,
  target     text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_idx on audit_log (org_id, created_at desc);

create table platform_tokens (
  org_id          uuid not null references orgs(id) on delete cascade,
  platform        text not null check (platform in ('github', 'bitbucket')),
  encrypted_token text not null,
  expires_at      timestamptz,
  primary key (org_id, platform)
);

-- Webhook idempotency by delivery id (DESIGN.md §9); rows older than 24h are prunable.
create table webhook_deliveries (
  platform    text not null,
  delivery_id text not null,
  received_at timestamptz not null default now(),
  primary key (platform, delivery_id)
);
create index webhook_deliveries_age_idx on webhook_deliveries (received_at);

-- --------------------------------------------------------------------- RLS

-- Membership helper. security definer so per-table policies don't recurse into
-- org_members' own RLS. plpgsql so it also *creates* cleanly on bare Postgres
-- (auth.uid() is only resolved at call time).
create schema if not exists app;
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
      and u.auth_user_id = auth.uid()
  );
end;
$$;

alter table orgs               enable row level security;
alter table users              enable row level security;
alter table org_members        enable row level security;
alter table repos              enable row level security;
alter table pull_requests      enable row level security;
alter table review_runs        enable row level security;
alter table findings           enable row level security;
alter table learning_events    enable row level security;
alter table rulebook_rules     enable row level security;
alter table symbols            enable row level security;
alter table chunks             enable row level security;
alter table health_snapshots   enable row level security;
alter table subscriptions      enable row level security;
alter table audit_log          enable row level security;
alter table platform_tokens    enable row level security;
alter table webhook_deliveries enable row level security;

-- Frontend (authenticated) may SELECT org-scoped rows only. All writes go through
-- the backend service role, which bypasses RLS. platform_tokens, symbols, chunks,
-- and webhook_deliveries get no policy at all: backend-only.

create policy orgs_select on orgs
  for select to authenticated using (app.is_org_member(id));

create policy users_select_self on users
  for select to authenticated using (auth_user_id = auth.uid());

create policy org_members_select on org_members
  for select to authenticated using (app.is_org_member(org_id));

create policy repos_select on repos
  for select to authenticated using (app.is_org_member(org_id));

create policy pull_requests_select on pull_requests
  for select to authenticated using (
    exists (select 1 from repos r where r.id = repo_id and app.is_org_member(r.org_id))
  );

create policy review_runs_select on review_runs
  for select to authenticated using (
    exists (
      select 1 from pull_requests p
      join repos r on r.id = p.repo_id
      where p.id = pr_id and app.is_org_member(r.org_id)
    )
  );

create policy findings_select on findings
  for select to authenticated using (
    exists (
      select 1 from review_runs rr
      join pull_requests p on p.id = rr.pr_id
      join repos r on r.id = p.repo_id
      where rr.id = run_id and app.is_org_member(r.org_id)
    )
  );

create policy learning_events_select on learning_events
  for select to authenticated using (app.is_org_member(org_id));

create policy rulebook_rules_select on rulebook_rules
  for select to authenticated using (app.is_org_member(org_id));

create policy health_snapshots_select on health_snapshots
  for select to authenticated using (
    exists (select 1 from repos r where r.id = repo_id and app.is_org_member(r.org_id))
  );

create policy subscriptions_select on subscriptions
  for select to authenticated using (app.is_org_member(org_id));

create policy audit_log_select on audit_log
  for select to authenticated using (app.is_org_member(org_id));

-- Realtime: frontend subscribes to review_runs changes (no-op outside Supabase).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.review_runs;
  end if;
exception
  when duplicate_object then null;
end $$;
