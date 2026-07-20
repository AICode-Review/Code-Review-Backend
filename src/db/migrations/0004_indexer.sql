-- 0004_indexer.sql — pgvector similarity search RPC for the repo indexer
-- (DESIGN.md §7). Supabase-js has no query-builder support for the pgvector
-- `<=>` operator, so cosine-similarity search goes through this function via
-- `db.rpc('match_chunks', {...})` instead.

create or replace function match_chunks(
  p_repo_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 12
)
returns table (
  id uuid,
  path text,
  start_line int,
  end_line int,
  similarity float
)
language sql stable
as $$
  select
    c.id,
    c.path,
    c.start_line,
    c.end_line,
    1 - (c.embedding <=> p_query_embedding) as similarity
  from chunks c
  where c.repo_id = p_repo_id
    and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;
