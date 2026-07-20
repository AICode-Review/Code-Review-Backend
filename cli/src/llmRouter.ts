import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import type { CompleteRequest, CompleteResult, LlmMessage, LlmRouter, TaskKind } from "../../src/llm/types.js";
import { costUsd } from "../../src/llm/pricing.js";

/**
 * A standalone LlmRouter for the CLI — deliberately NOT backend/src/llm/router.ts's
 * createLlmRouter(), which reads env() against the FULL backend .env schema (Supabase,
 * GitHub App, etc.) that a locally-installed CLI has no business requiring. This only
 * needs the two model API keys. engine/passRunner.ts and verify/*.ts take an injected
 * LlmRouter and have no env() dependency of their own, so this plugs in cleanly.
 */
export interface CliRouterConfig {
  anthropicApiKey: string;
  openaiApiKey: string;
  frontierModel: string;
  midModel: string;
  skepticModel: string;
}

function modelFor(task: TaskKind, cfg: CliRouterConfig): { provider: "anthropic" | "openai"; model: string } {
  switch (task) {
    case "pass.logic":
    case "pass.security":
    case "pass.contracts":
      return { provider: "anthropic", model: cfg.frontierModel };
    case "pass.concurrency":
    case "pass.errors":
    case "pass.tests":
    case "pass.style":
    case "rulebook.compile":
    case "chat.reply":
    case "verify.repro_gen":
      return { provider: "anthropic", model: cfg.midModel };
    case "verify.cross_exam":
      return { provider: "openai", model: cfg.skepticModel };
  }
}

interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function callAnthropic(client: Anthropic, model: string, messages: LlmMessage[], maxTokens: number): Promise<ProviderResult> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const userMessages = messages.filter((m) => m.role === "user").map((m) => ({ role: "user" as const, content: m.content }));
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: userMessages,
  });
  const text = res.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
}

async function callOpenAI(client: OpenAI, model: string, messages: LlmMessage[], maxTokens: number): Promise<ProviderResult> {
  const res = await client.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  const text = res.choices[0]?.message?.content ?? "";
  return { text, inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 };
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  return JSON.parse(candidate.trim());
}

function tryParse<T>(schema: z.ZodType<T>, text: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const result = schema.safeParse(extractJson(text));
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** i + Math.random() * 200));
    }
  }
  throw lastErr;
}

/** Same shape as backend/src/llm/router.ts's createLlmRouter(): one repair-prompt retry on schema-validation failure, then the caller drops that pass rather than crash. */
export function createCliRouter(cfg: CliRouterConfig): LlmRouter {
  const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const openai = new OpenAI({ apiKey: cfg.openaiApiKey });

  async function callProvider(choice: { provider: "anthropic" | "openai"; model: string }, messages: LlmMessage[], maxTokens: number) {
    return choice.provider === "anthropic"
      ? callAnthropic(anthropic, choice.model, messages, maxTokens)
      : callOpenAI(openai, choice.model, messages, maxTokens);
  }

  return {
    async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
      const choice = modelFor(req.task, cfg);
      const first = await withRetry(() => callProvider(choice, req.messages, req.maxTokens));
      const firstParsed = tryParse(req.schema, first.text);
      if (firstParsed.ok) {
        return {
          data: firstParsed.data,
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
          costUsd: costUsd(choice.model, first.inputTokens, first.outputTokens),
          model: choice.model,
          provider: choice.provider,
        };
      }

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

      return {
        data: secondParsed.ok ? secondParsed.data : null,
        inputTokens,
        outputTokens,
        costUsd: costUsd(choice.model, inputTokens, outputTokens),
        model: choice.model,
        provider: choice.provider,
        raw: secondParsed.ok ? undefined : second.text,
      };
    },
  };
}
