import type { CompleteRequest, CompleteResult, LlmRouter, TaskKind } from "./types.js";

/** Deterministic in-memory router for tests — no network, no API keys. */
export function createFakeRouter(responses: Partial<Record<TaskKind, unknown>>): LlmRouter {
  return {
    async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
      const canned = responses[req.task];
      const parsed = req.schema.safeParse(canned ?? []);
      return {
        data: parsed.success ? parsed.data : null,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
        model: "fake-model",
        provider: req.task === "verify.cross_exam" ? "openai" : "anthropic",
        raw: parsed.success ? undefined : JSON.stringify(canned),
      };
    },
  };
}
