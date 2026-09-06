import { describe, expect, it } from "vitest";
import { generateDiagram } from "./prDiagram.js";
import { buildPrDiff } from "./diff.js";
import { createFakeRouter } from "../llm/fakeRouter.js";
import type { CompleteRequest, CompleteResult, LlmRouter } from "../llm/types.js";

const SAMPLE_DIFF = buildPrDiff({
  baseSha: "base",
  headSha: "head",
  diffText: `diff --git a/src/discount.ts b/src/discount.ts
index 1111111..2222222 100644
--- a/src/discount.ts
+++ b/src/discount.ts
@@ -1,3 +1,3 @@
-export function applyDiscount(price, pct) {
-  return price - price * pct;
+export function applyDiscount(price, pct, cap) {
+  return Math.min(price * pct, cap);
 }
`,
});

const VALID_MERMAID = "flowchart TD\n  A[discount.ts] -->|modifies| B[applyDiscount()]";

describe("generateDiagram", () => {
  it("returns the model's mermaid source on a successful call", async () => {
    const router = createFakeRouter({ "pass.diagram": { mermaid: VALID_MERMAID } });
    const result = await generateDiagram(router, SAMPLE_DIFF);
    expect(result.data?.mermaid).toContain("applyDiscount()");
  });

  it("returns null data (never throws) when the model's response fails schema validation", async () => {
    const router = createFakeRouter({}); // no pass.diagram configured — fails validation, data: null
    const result = await generateDiagram(router, SAMPLE_DIFF);
    expect(result.data).toBeNull();
  });

  it("rejects a response that isn't a flowchart/graph declaration", async () => {
    const router = createFakeRouter({ "pass.diagram": { mermaid: "sequenceDiagram\n  A->>B: hello" } });
    const result = await generateDiagram(router, SAMPLE_DIFF);
    expect(result.data).toBeNull();
  });

  it("rejects a response containing a triple-backtick (fence-breakout guard)", async () => {
    const router = createFakeRouter({ "pass.diagram": { mermaid: "flowchart TD\n  A[x] --> B[```evil```]" } });
    const result = await generateDiagram(router, SAMPLE_DIFF);
    expect(result.data).toBeNull();
  });

  it("attributes cost to whichever provider actually served the call", async () => {
    const anthropicRouter: LlmRouter = {
      async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
        const parsed = req.schema.safeParse({ mermaid: VALID_MERMAID });
        return { data: parsed.success ? parsed.data : null, inputTokens: 10, outputTokens: 10, costUsd: 0.002, model: "fake", provider: "anthropic" };
      },
    };
    const result = await generateDiagram(anthropicRouter, SAMPLE_DIFF);
    expect(result.anthropicCostUsd).toBeCloseTo(0.002);
    expect(result.openaiCostUsd).toBe(0);
  });

  it("sends the diff text in the user message", async () => {
    const captured: string[] = [];
    const router: LlmRouter = {
      async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
        captured.push(...req.messages.map((m) => m.content));
        const parsed = req.schema.safeParse({ mermaid: VALID_MERMAID });
        return { data: parsed.success ? parsed.data : null, inputTokens: 10, outputTokens: 10, costUsd: 0.001, model: "fake", provider: "anthropic" };
      },
    };
    await generateDiagram(router, SAMPLE_DIFF);
    expect(captured.some((m) => m.includes("applyDiscount"))).toBe(true);
  });
});
