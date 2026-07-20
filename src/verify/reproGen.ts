import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRouter } from "../llm/types.js";
import { ReproGenOutputSchema, type Candidate, type ReproGenOutput } from "../engine/schemas.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../engine/prompts/repro_gen.v1.md");

let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

export interface ReproGenCallResult {
  data: ReproGenOutput | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** DESIGN.md §6.5/§7.3 — asks the model for a minimal, self-contained repro test to run in the sandbox. */
export async function generateRepro(router: LlmRouter, candidate: Candidate, fileContent: string): Promise<ReproGenCallResult> {
  const system = await loadPrompt();
  const user = [
    "## Finding",
    `Category: ${candidate.category}`,
    `Severity: ${candidate.severity}`,
    `Title: ${candidate.title}`,
    `Explanation: ${candidate.explanation}`,
    `Cited lines: ${candidate.startLine}-${candidate.endLine}`,
    "Evidence:",
    ...candidate.evidence.map((e) => `- ${e}`),
    "",
    `## File: ${candidate.path}`,
    "```",
    fileContent,
    "```",
  ].join("\n");

  const result = await router.complete({
    task: "verify.repro_gen",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schema: ReproGenOutputSchema,
    maxTokens: 2048,
  });

  return { data: result.data, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
