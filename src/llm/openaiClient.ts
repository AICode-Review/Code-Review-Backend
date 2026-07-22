import type { LlmMessage } from "./types.js";
import type { ProviderResult } from "./anthropicClient.js";
import { getOpenAiClient } from "./openaiClientFactory.js";

export async function callOpenAI(model: string, messages: LlmMessage[], maxTokens: number): Promise<ProviderResult> {
  const res = await getOpenAiClient().chat.completions.create({
    model,
    // `max_tokens` is deprecated on OpenAI's Chat Completions API — newer models (including
    // gpt-5, this router's MODEL_SKEPTIC/fallback model) reject it outright and require
    // max_completion_tokens instead.
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const text = res.choices[0]?.message?.content ?? "";
  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
}
