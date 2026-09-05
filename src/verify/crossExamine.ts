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
 *
 * `otherFiles` and `repoContextText` close a matching blind spot for cross-file claims (most
 * commonly `contracts` findings: "this breaks callers X and Y elsewhere"). Before this, the
 * skeptic only ever saw `candidate.path` in isolation — it had no way to confirm OR refute a
 * claim about a caller in a different file, so it had to default to "uncertain" even when the
 * originating pass had real evidence, which the precision-first policy then rejects outright.
 * `otherFiles` is other files from THIS review's own file set (real source, when the caller
 * happens to be part of the PR); `repoContextText` is the same best-effort
 * `buildRepoContextBlock` text the pass itself saw (symbol-level, when the caller lives
 * elsewhere in the indexed repo). Both optional and additive — omitting them just returns to
 * the original single-file behavior.
 */
export async function crossExamine(
  router: LlmRouter,
  candidate: Candidate,
  fileContent: string,
  diffText?: string,
  otherFiles?: Map<string, string>,
  repoContextText?: string,
): Promise<CrossExamCallResult> {
  const system = await loadPrompt();
  const otherFileBlocks =
    otherFiles && otherFiles.size > 0
      ? [...otherFiles.entries()]
          .filter(([path]) => path !== candidate.path)
          .map(([path, content]) => `### FILE: ${path}\n\`\`\`\n${content}\n\`\`\``)
      : [];
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
    ...(otherFileBlocks.length > 0
      ? ["", "## Other files from this PR (for checking a claim about a caller/consumer elsewhere)", ...otherFileBlocks]
      : []),
    ...(repoContextText ? ["", repoContextText] : []),
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
