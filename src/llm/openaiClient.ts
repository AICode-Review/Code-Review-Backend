import type { LlmMessage } from "./types.js";
import type { ProviderResult } from "./anthropicClient.js";
import { getOpenAiClient } from "./openaiClientFactory.js";

// Confirmed in production (2026-09-14): with no per-call timeout set, a single stuck OpenAI
// request falls back to the SDK's own ~10-minute default, and withRetry's 3 attempts can
// stack that to ~30 minutes for one complete() call — a whole review run hangs with zero
// cost/error recorded the entire time. This bounds a single attempt so withRetry's backoff
// loop actually gets to retry (or drop the call) instead of waiting out the SDK default.
const LLM_CALL_TIMEOUT_MS = 90_000;

export async function callOpenAI(model: string, messages: LlmMessage[], maxTokens: number): Promise<ProviderResult> {
  const res = await getOpenAiClient().chat.completions.create(
    {
      model,
      // `max_tokens` is deprecated on OpenAI's Chat Completions API — newer models (including
      // gpt-5, this router's MODEL_SKEPTIC/fallback model) reject it outright and require
      // max_completion_tokens instead.
      max_completion_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
    { timeout: LLM_CALL_TIMEOUT_MS },
  );

  const text = res.choices[0]?.message?.content ?? "";
  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
}
