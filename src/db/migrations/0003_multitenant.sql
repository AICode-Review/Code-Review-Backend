-- 0003_multitenant.sql — individual vs team orgs, authoritative installer
-- identity for auto-linking, and an invite system for teammates who didn't
-- personally install the GitHub App.

alter table orgs
  add column if not exists kind text not null default 'individual' check (kind in ('individual', 'team')),
  add column if not exists installed_by_github_id bigint,
  add column if not exists installed_by_login text;

create index if not exists orgs_installed_by_idx on orgs (installed_by_github_id);

create table if not exists org_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  email       text not null,
  role        text not null default 'member' check (role in ('admin', 'member')),
  invited_by  uuid not null references users(id) on delete cascade,
  token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '14 days')
);
create index if not exists org_invites_org_idx on org_invites (org_id);
create index if not exists org_invites_email_idx on org_invites (lower(email));

alter table org_invites enable row level security;

-- Members can see pending invites for their own org (to show "invited, awaiting accept" in Settings).
-- All writes (create/accept/revoke) go through the backend service role.
create policy org_invites_select on org_invites
  for select to authenticated using (app.is_org_member(org_id));
