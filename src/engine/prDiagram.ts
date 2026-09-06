import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRouter } from "../llm/types.js";
import { PrDiagramOutputSchema, type PrDiagramOutput } from "./schemas.js";
import { prDiffToPromptText } from "./contextAssembly.js";
import type { PrDiff } from "./diff.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "prompts/pr_diagram.v1.md");

let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

export interface DiagramCallResult {
  data: PrDiagramOutput | null;
  costUsd: number;
  anthropicCostUsd: number;
  openaiCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A small Mermaid flowchart of the PR's changed files/functions and their relationships,
 * shown alongside the plain-English walkthrough in the summary comment — DESIGN.md §10 gap
 * vs. competitors' PR-summary diagrams (see engine/schemas.ts's PrDiagramOutputSchema doc
 * comment for why this is GitHub-only). One call per run, routed to the mid model tier
 * (llm/router.ts) — same reasoning as the walkthrough, this is a summary, not a judgment.
 * `data: null` on a schema-validation failure (same fail-soft pattern as every other pass,
 * including the triple-backtick/flowchart-shape checks in the schema) just omits the
 * diagram section; it never blocks the run.
 */
export async function generateDiagram(router: LlmRouter, prDiff: PrDiff): Promise<DiagramCallResult> {
  const system = await loadPrompt();
  const user = ["## Diff", prDiffToPromptText(prDiff)].join("\n");

  const result = await router.complete({
    task: "pass.diagram",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schema: PrDiagramOutputSchema,
    maxTokens: 600,
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
