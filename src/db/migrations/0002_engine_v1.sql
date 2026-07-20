-- 0002_engine_v1.sql — columns needed by the review engine, REST API, and the
-- frontend's DiffViewer/ReviewComment/RunDetail contracts.

alter table orgs  add column if not exists installation_id bigint;
alter table repos add column if not exists owner text not null default '';

alter table review_runs
  add column if not exists trigger text not null default 'automatic'
    check (trigger in ('automatic', 'manual')),
  add column if not exists summary text,
  add column if not exists source_run_id uuid references review_runs(id) on delete set null;

alter table findings
  add column if not exists why_it_matters text not null default '',
  add column if not exists impact         text not null default '',
  add column if not exists fix_steps      text[] not null default '{}',
  add column if not exists suggested_fix  text,
  add column if not exists code_snippet   text,
  add column if not exists verified_how   text not null default '',
  add column if not exists in_digest      boolean not null default false;

-- Health snapshots need a unique (repo_id, week) upsert target — already unique
-- from 0001, nothing to add there.

-- RLS: allow authenticated reads of the new columns implicitly (policies are
-- table-scoped, not column-scoped, so 0001's policies already cover these).
