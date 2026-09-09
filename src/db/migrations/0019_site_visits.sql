-- 0019_site_visits.sql — anonymous visit counter for the public marketing site
-- (console's Visitors panel: Today / Last 7 days / Last 30 days). visitor_id is a
-- client-generated UUID stored in localStorage (frontend/src/lib/tracking.ts) — never tied
-- to an account, so this table carries no PII beyond a path and a random identifier.
-- Written only by the backend's service-role client (POST /api/track/visit, unauthenticated
-- route, same posture as contact_submissions) — no anon/authenticated policies needed.

create table site_visits (
  id         uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  path       text not null,
  created_at timestamptz not null default now()
);

create index site_visits_created_at_idx on site_visits (created_at);
create index site_visits_visitor_created_idx on site_visits (visitor_id, created_at);

alter table site_visits enable row level security;
