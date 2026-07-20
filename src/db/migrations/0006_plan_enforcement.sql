-- Plan-tier enforcement (DESIGN.md pricing tiers): Free = public repos only, seat limits
-- on invites, Team-only analytics/health/audit. `is_private` is needed to gate reviews on
-- private repos for free-plan orgs; captured from the platform webhook payload going forward
-- (GitHub's `repository.private`, Bitbucket's `repository.is_private`) — existing rows default
-- to false (public) since that's the safe/permissive direction for repos connected before this
-- column existed.
alter table repos add column if not exists is_private boolean not null default false;
