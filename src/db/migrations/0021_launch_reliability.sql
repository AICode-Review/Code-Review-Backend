-- Atomic monthly admission and explicit recovery boundaries.
alter table review_runs
  add column quota_limit integer check (quota_limit >= -1),
  add column quota_reserved_at timestamptz,
  add column delivery_started_at timestamptz;

-- Preserve historical usage; queued work has not yet consumed model capacity.
update review_runs set quota_reserved_at = started_at
where blocked_reason is null and status <> 'queued'
  and (status <> 'failed' or llm_cost_usd > 0);
create index review_runs_quota_idx on review_runs (quota_reserved_at, pr_id)
  where quota_reserved_at is not null;

create function reserve_review_quota() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  org_uuid uuid;
  used bigint;
  month_start timestamptz;
begin
  if new.status <> 'running' or new.quota_reserved_at is not null then return new; end if;
  if new.quota_limit is null then raise exception 'quota_configuration_missing'; end if;
  select r.org_id into strict org_uuid from pull_requests p join repos r on r.id=p.repo_id where p.id=new.pr_id;
  -- Every admission for an organization takes this lock, including unlimited plans.
  -- The subsequent count sees earlier admissions committed while we waited.
  perform 1 from orgs where id=org_uuid for update;
  month_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  select count(*) into used from review_runs rr
    join pull_requests p on p.id=rr.pr_id join repos r on r.id=p.repo_id
    where r.org_id=org_uuid and rr.id<>new.id and rr.blocked_reason is null
      and rr.quota_reserved_at >= month_start and rr.quota_reserved_at < ((month_start at time zone 'UTC') + interval '1 month') at time zone 'UTC'
      and (rr.status<>'failed' or rr.llm_cost_usd>0 or rr.delivery_started_at is not null);
  if new.quota_limit >= 0 and used >= new.quota_limit then
    raise exception 'monthly_quota_exceeded' using errcode='P0001';
  end if;
  new.quota_reserved_at := now();
  return new;
end $$;
revoke all on function reserve_review_quota() from public, anon, authenticated;
create trigger review_quota_reservation before insert or update of status on review_runs
for each row execute function reserve_review_quota();

-- Backend-only operational heartbeat. Never exposes process/queue metadata through RLS.
create table worker_heartbeats (id text primary key, updated_at timestamptz not null default now());
alter table worker_heartbeats enable row level security;
revoke all on worker_heartbeats from anon, authenticated;
grant all on worker_heartbeats to service_role;
