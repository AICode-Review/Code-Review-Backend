-- 0011_platform_admin.sql — platform-admin flag for the cross-org admin console.
-- No RLS policy needed: admin reads go through the service-role client (getDb()),
-- which already bypasses RLS everywhere else in this codebase.
alter table users add column if not exists is_platform_admin boolean not null default false;
