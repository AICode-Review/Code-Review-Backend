import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRouter } from "../llm/types.js";
import { PrWalkthroughOutputSchema, type PrWalkthroughOutput } from "./schemas.js";
import { prDiffToPromptText } from "./contextAssembly.js";
import type { PrDiff } from "./diff.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "prompts/pr_walkthrough.v1.md");

let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

export interface WalkthroughCallResult {
  data: PrWalkthroughOutput | null;
  costUsd: number;
  anthropicCostUsd: number;
  openaiCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A short, plain-English "what does this diff do" orientation shown at the top of the summary
 * comment — DESIGN.md §10 gap vs. competitors' "plain-English walkthrough" (see
 * engine/schemas.ts's PrWalkthroughOutputSchema doc comment). One call per run, routed to the
 * mid model tier (llm/router.ts) since this doesn't need frontier-level reasoning — it's a
 * summary, not a judgment. `data: null` on a schema-validation failure (same fail-soft pattern
 * as every other pass) just means the summary section is omitted; it never blocks the run.
 */
export async function generateWalkthrough(router: LlmRouter, prDiff: PrDiff): Promise<WalkthroughCallResult> {
  const system = await loadPrompt();
  const user = ["## Diff", prDiffToPromptText(prDiff)].join("\n");

  const result = await router.complete({
    task: "pass.walkthrough",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schema: PrWalkthroughOutputSchema,
    maxTokens: 512,
  });

  return {
    data: result.data,
    costUsd: result.costUsd,
    anthropicCostUsd: result.provider === "anthropic" ? result.costUsd : 0,
    openaiCostUsd: result.provider === "openai" ? result.costUsd : 0,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
