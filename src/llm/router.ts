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

/** Bedrock (AWS_REGION) authenticates via AWS credentials, not ANTHROPIC_API_KEY — see anthropicClient.ts. */
function anthropicAvailable(): boolean {
  const e = env();
  return Boolean(e.ANTHROPIC_API_KEY) || Boolean(e.AWS_REGION);
}

/** Azure OpenAI (AZURE_OPENAI_ENDPOINT) is a distinct auth path from a direct OPENAI_API_KEY — see openaiClientFactory.ts. */
function openaiAvailable(): boolean {
  const e = env();
  return Boolean(e.OPENAI_API_KEY) || Boolean(e.AZURE_OPENAI_ENDPOINT);
}

/**
 * Preferred provider per task, falling back to whichever provider is actually configured
 * when the preferred one isn't — "run on whatever key/credits are available" rather than
 * hard-failing a whole review because one of the two providers is unset. The one real
 * quality tradeoff: verify.cross_exam's whole point is an independent second opinion from
 * a *different* vendor than whatever wrote the passes; falling back to the same provider
 * for both loses that independence (still better than no verification at all). Reuses
 * MODEL_SKEPTIC for every OpenAI-fallback task — there's no separate "OpenAI frontier/mid"
 * tier configured, unlike Anthropic's two-tier MODEL_FRONTIER/MODEL_MID split.
 */
function modelFor(task: TaskKind): ModelChoice {
  switch (task) {
    case "pass.logic":
    case "pass.security":
    case "pass.contracts":
      return anthropicAvailable()
        ? { provider: "anthropic", model: env().MODEL_FRONTIER }
        : { provider: "openai", model: env().MODEL_SKEPTIC };
    case "pass.concurrency":
    case "pass.errors":
    case "pass.tests":
    case "pass.style":
    case "rulebook.compile":
    case "chat.reply":
    case "verify.repro_gen":
      return anthropicAvailable()
        ? { provider: "anthropic", model: env().MODEL_MID }
        : { provider: "openai", model: env().MODEL_SKEPTIC };
    case "verify.cross_exam":
      return openaiAvailable()
        ? { provider: "openai", model: env().MODEL_SKEPTIC }
        : { provider: "anthropic", model: env().MODEL_FRONTIER };
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
