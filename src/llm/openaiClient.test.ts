import { describe, expect, it, vi } from "vitest";

const createMock = vi.fn((_params: unknown) =>
  Promise.resolve({
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
);
vi.mock("./openaiClientFactory.js", () => ({
  getOpenAiClient: () => ({ chat: { completions: { create: (params: unknown) => createMock(params) } } }),
}));

describe("callOpenAI", () => {
  it("sends max_completion_tokens, never the deprecated max_tokens — newer OpenAI models reject max_tokens outright", async () => {
    const { callOpenAI } = await import("./openaiClient.js");
    await callOpenAI("gpt-5", [{ role: "user", content: "hi" }], 500);

    const params = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params["max_completion_tokens"]).toBe(500);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("parses the response into text/inputTokens/outputTokens", async () => {
    const { callOpenAI } = await import("./openaiClient.js");
    const result = await callOpenAI("gpt-5", [{ role: "user", content: "hi" }], 500);
    expect(result).toEqual({ text: '{"ok":true}', inputTokens: 10, outputTokens: 5 });
  });
});
