import type { z } from "zod";
import { env } from "../config.js";
import { callAnthropic, type ProviderResult } from "./anthropicClient.js";
import { callOpenAI } from "./openaiClient.js";
import { costUsd } from "./pricing.js";
import type { CompleteRequest, CompleteResult, LlmMessage, LlmRouter, TaskKind } from "./types.js";

interface ModelChoice {
  provider: "anthropic" | "openai";
  model: string;
}

function modelFor(task: TaskKind): ModelChoice {
  switch (task) {
    case "pass.logic":
    case "pass.security":
    case "pass.contracts":
      return { provider: "anthropic", model: env().MODEL_FRONTIER };
    case "pass.concurrency":
    case "pass.errors":
    case "pass.tests":
    case "pass.style":
    case "rulebook.compile":
    case "chat.reply":
    case "verify.repro_gen":
      return { provider: "anthropic", model: env().MODEL_MID };
    case "verify.cross_exam":
      return { provider: "openai", model: env().MODEL_SKEPTIC };
  }
}

async function callProvider(choice: ModelChoice, messages: LlmMessage[], maxTokens: number): Promise<ProviderResult> {
  return choice.provider === "anthropic"
    ? callAnthropic(choice.model, messages, maxTokens)
    : callOpenAI(choice.model, messages, maxTokens);
}

/** Retries transient provider errors (network, 5xx, rate limit) with jittered backoff. Never retries validation failures — those go through the repair prompt instead. */
async function withRetry(fn: () => Promise<ProviderResult>, attempts = 3): Promise<ProviderResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const backoffMs = 300 * 2 ** i + Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastErr;
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  return JSON.parse(candidate.trim());
}

function tryParse<T>(schema: z.ZodType<T>, text: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const json = extractJson(text);
    const result = schema.safeParse(json);
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Real LLM-backed router. All calls go through here so cost metering and zod validation are uniform across every pass, verification, and the rulebook compiler. */
export function createLlmRouter(): LlmRouter {
  return {
    async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
      const choice = modelFor(req.task);

      const first = await withRetry(() => callProvider(choice, req.messages, req.maxTokens));
      const firstParsed = tryParse(req.schema, first.text);
      if (firstParsed.ok) {
        return {
          data: firstParsed.data,
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
          costUsd: costUsd(choice.model, first.inputTokens, first.outputTokens, first),
          model: choice.model,
          provider: choice.provider,
        };
      }

      // One repair-prompt retry, then drop the pass rather than crash the run.
      const repairMessages: LlmMessage[] = [
        ...req.messages,
        {
          role: "user",
          content: `Your previous response failed schema validation: ${firstParsed.error}\n\nRe-emit ONLY the corrected JSON — no prose, no markdown fences.\n\nPrevious response:\n${first.text}`,
        },
      ];
      const second = await withRetry(() => callProvider(choice, repairMessages, req.maxTokens));
      const secondParsed = tryParse(req.schema, second.text);

      const inputTokens = first.inputTokens + second.inputTokens;
      const outputTokens = first.outputTokens + second.outputTokens;
      const cacheCreationInputTokens = (first.cacheCreationInputTokens ?? 0) + (second.cacheCreationInputTokens ?? 0);
      const cacheReadInputTokens = (first.cacheReadInputTokens ?? 0) + (second.cacheReadInputTokens ?? 0);

      return {
        data: secondParsed.ok ? secondParsed.data : null,
        inputTokens,
        outputTokens,
        costUsd: costUsd(choice.model, inputTokens, outputTokens, { cacheCreationInputTokens, cacheReadInputTokens }),
        model: choice.model,
        provider: choice.provider,
        raw: secondParsed.ok ? undefined : second.text,
      };
    },
  };
}
