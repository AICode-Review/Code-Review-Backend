import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const callAnthropicMock = vi.fn((_model: string, _messages: unknown, _maxTokens: number) =>
  Promise.resolve({ text: '{"ok":true}', inputTokens: 10, outputTokens: 5 }),
);
const callOpenAIMock = vi.fn((_model: string, _messages: unknown, _maxTokens: number) =>
  Promise.resolve({ text: '{"ok":true}', inputTokens: 10, outputTokens: 5 }),
);
vi.mock("./anthropicClient.js", () => ({
  callAnthropic: (model: string, messages: unknown, maxTokens: number) => callAnthropicMock(model, messages, maxTokens),
}));
vi.mock("./openaiClient.js", () => ({
  callOpenAI: (model: string, messages: unknown, maxTokens: number) => callOpenAIMock(model, messages, maxTokens),
}));

const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_REGION", "AZURE_OPENAI_ENDPOINT"] as const;
const ORIGINAL_ENV = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of KEY_VARS) delete process.env[k];
  vi.resetModules(); // config.ts memoizes env() at module scope — force a fresh read per test.
  callAnthropicMock.mockClear();
  callOpenAIMock.mockClear();
});
afterEach(() => {
  for (const k of KEY_VARS) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const SCHEMA = z.object({ ok: z.boolean() });

async function freshRouter() {
  const { createLlmRouter } = await import("./router.js");
  return createLlmRouter();
}

describe("createLlmRouter provider fallback", () => {
  it("routes passes to Anthropic and cross-exam to OpenAI when both keys are configured (default behavior)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";
    process.env["OPENAI_API_KEY"] = "sk-oai";
    const router = await freshRouter();

    const pass = await router.complete({ task: "pass.security", messages: [], schema: SCHEMA, maxTokens: 100 });
    expect(pass.provider).toBe("anthropic");
    expect(callAnthropicMock).toHaveBeenCalledTimes(1);
    expect(callOpenAIMock).not.toHaveBeenCalled();

    const crossExam = await router.complete({ task: "verify.cross_exam", messages: [], schema: SCHEMA, maxTokens: 100 });
    expect(crossExam.provider).toBe("openai");
    expect(callOpenAIMock).toHaveBeenCalledTimes(1);
  });

  it("falls back every task to OpenAI when only OPENAI_API_KEY is configured", async () => {
    process.env["OPENAI_API_KEY"] = "sk-oai";
    const router = await freshRouter();

    const pass = await router.complete({ task: "pass.security", messages: [], schema: SCHEMA, maxTokens: 100 });
    expect(pass.provider).toBe("openai");

    const crossExam = await router.complete({ task: "verify.cross_exam", messages: [], schema: SCHEMA, maxTokens: 100 });
    expect(crossExam.provider).toBe("openai"); // no independent second vendor available — degrades rather than failing outright

    expect(callAnthropicMock).not.toHaveBeenCalled();
    expect(callOpenAIMock).toHaveBeenCalledTimes(2);
  });

  it("falls back cross-exam to Anthropic when only Anthropic is configured", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";
    const router = await freshRouter();

    const crossExam = await router.complete({ task: "verify.cross_exam", messages: [], schema: SCHEMA, maxTokens: 100 });
    expect(crossExam.provider).toBe("anthropic");
    expect(callAnthropicMock).toHaveBeenCalledTimes(1);
    expect(callOpenAIMock).not.toHaveBeenCalled();
  });

  it("treats Bedrock (AWS_REGION) as Anthropic availability even without ANTHROPIC_API_KEY", async () => {
    process.env["AWS_REGION"] = "us-east-1";
    const router = await freshRouter();

    const pass = await router.complete({ task: "pass.logic", messages: [], schema: SCHEMA, maxTokens: 100 });
    expect(pass.provider).toBe("anthropic");
  });

  it("treats Azure OpenAI (AZURE_OPENAI_ENDPOINT) as OpenAI availability even without OPENAI_API_KEY", async () => {
    process.env["AZURE_OPENAI_ENDPOINT"] = "https://example.openai.azure.com";
    const router = await freshRouter();

    const crossExam = await router.complete({ task: "verify.cross_exam", messages: [], schema: SCHEMA, maxTokens: 100 });
    expect(crossExam.provider).toBe("openai");
  });
});
