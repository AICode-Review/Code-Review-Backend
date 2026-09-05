-- 0017_repo_chat.sql — full-codebase chat ("ask a question about this repo, not just a
-- specific finding"). Reuses the existing indexer/embeddings pipeline entirely — this adds
-- only the persisted conversation history and a small extension to match_chunks so a chat
-- answer can quote the ACTUAL retrieved code, not just a path:line pointer (unlike the
-- review pipeline's lightweight repo-context block, a chat answer with no real code shown
-- to the model would be far more prone to hallucinating APIs that don't exist).

-- match_chunks needs the chunk's indexed `sha` back so engine/repoChat.ts can fetch the
-- exact file content the chunk was embedded from (adapter.getFile(repo, path, sha)) rather
-- than guessing at "current HEAD", which may have moved since the repo was last indexed.
-- Postgres requires DROP + CREATE (not CREATE OR REPLACE) when a `returns table` shape gains
-- a column.
drop function if exists match_chunks(uuid, vector(1536), int);

create function match_chunks(
  p_repo_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 12
)
returns table (
  id uuid,
  path text,
  start_line int,
  end_line int,
  sha text,
  similarity float
)
language sql stable
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.path,
    c.start_line,
    c.end_line,
    c.sha,
    1 - (c.embedding <=> p_query_embedding) as similarity
  from chunks c
  where c.repo_id = p_repo_id
    and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- Backend-only (RLS on, no policies — same posture as platform_tokens/webhook_deliveries):
-- reads and writes both go through POST/GET /api/repos/:id/chat (the write needs the
-- backend anyway, to run retrieval + the LLM call), so there's no reason to also expose a
-- direct-Supabase-read path here. Conversations are per-user, not shared across an org's
-- members — this is exploratory Q&A, not a review finding everyone needs to see.
create table repo_chat_messages (
  id         uuid primary key default gen_random_uuid(),
  repo_id    uuid not null references repos(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  sources    jsonb not null default '[]'::jsonb,
  cost_usd   numeric(10, 4) not null default 0,
  created_at timestamptz not null default now()
);
create index repo_chat_messages_repo_user_idx on repo_chat_messages (repo_id, user_id, created_at);
alter table repo_chat_messages enable row level security;
