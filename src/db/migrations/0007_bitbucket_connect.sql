-- Atlassian Connect app scaffolding (DESIGN.md §4) — additive alongside the existing
-- manual-workspace-token Bitbucket flow, not a replacement. One row per Connect
-- installation (`clientKey` is Atlassian's stable identifier for an install, distinct from
-- our own `orgs` table); `shared_secret` is encrypted at rest with the same AES-256-GCM
-- scheme as `platform_tokens` (security/tokenCrypto.ts).
create table bitbucket_connect_installations (
  client_key       text primary key,
  encrypted_secret text not null,
  base_url         text not null,
  display_url      text,
  product_type     text,
  installed_at     timestamptz not null default now()
);

-- Backend-only infra, same posture as platform_tokens/webhook_deliveries: RLS on, no
-- policies, so only service_role (which bypasses RLS) can ever touch it.
alter table bitbucket_connect_installations enable row level security;
