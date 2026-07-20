-- Per-provider LLM cost breakdown for admin console tracking (Anthropic passes vs OpenAI skeptic).
-- llm_cost_usd remains the authoritative total (anthropic + openai); new columns default 0 for backfill.
alter table review_runs
  add column if not exists anthropic_cost_usd numeric(10, 4) not null default 0,
  add column if not exists openai_cost_usd numeric(10, 4) not null default 0;
