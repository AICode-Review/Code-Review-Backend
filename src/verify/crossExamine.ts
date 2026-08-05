import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRouter } from "../llm/types.js";
import { CrossExamOutputSchema, type Candidate, type CrossExamOutput } from "../engine/schemas.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../engine/prompts/cross_exam.v2.md");

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

/**
 * DESIGN.md §6.5 step 2 — a different vendor model acts as skeptic with full-file context.
 * `diffText` (this PR's diff for `candidate.path`, when available) is what lets the skeptic
 * verify a claim about what CHANGED (e.g. "escaping was removed") — without it, the skeptic
 * only sees the current file and has no way to confirm a before/after claim, which showed up
 * as a real missed catch in the benchmark harness (a security pass caught a stored-XSS
 * regression at 0.99 confidence; cross-exam rejected it as unverifiable because it had never
 * been shown that escaping used to be there). Optional because not every caller has diff
 * context on hand (e.g. a candidate whose path fell outside the fetched diff for some reason)
 * — verification still runs, just back to file-content-only reasoning in that case.
 */
export async function crossExamine(
  router: LlmRouter,
  candidate: Candidate,
  fileContent: string,
  diffText?: string,
): Promise<CrossExamCallResult> {
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
    ...(diffText
      ? ["## What changed in this PR (this finding's file)", "```", diffText, "```", ""]
      : []),
    `## File: ${candidate.path}${diffText ? " (full content, after the PR)" : ""}`,
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
