-- 0015_contact_submissions.sql — public marketing site "Contact us" form.
-- Written only by the backend's service-role client (POST /api/contact, unauthenticated
-- route) — no anon/authenticated policies are added, so RLS blocks every other client.

create table contact_submissions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null,
  message    text not null,
  created_at timestamptz not null default now()
);

alter table contact_submissions enable row level security;
