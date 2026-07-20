-- Platform admin write actions: org suspend kill-switch + platform-scoped audit rows.
alter table orgs
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text;

-- Platform-scoped actions (e.g. grant/revoke is_platform_admin) have no org.
alter table audit_log alter column org_id drop not null;
