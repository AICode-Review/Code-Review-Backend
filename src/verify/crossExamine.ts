import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRouter } from "../llm/types.js";
import { CrossExamOutputSchema, type Candidate, type CrossExamOutput } from "../engine/schemas.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../engine/prompts/cross_exam.v1.md");

let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

export interface CrossExamCallResult {
  data: CrossExamOutput | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** DESIGN.md §6.5 step 2 — a different vendor model acts as skeptic with full-file context. */
export async function crossExamine(router: LlmRouter, candidate: Candidate, fileContent: string): Promise<CrossExamCallResult> {
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
    task: "verify.cross_exam",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schema: CrossExamOutputSchema,
    maxTokens: 1024,
  });

  return { data: result.data, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
