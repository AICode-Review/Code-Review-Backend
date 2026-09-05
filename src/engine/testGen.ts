import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRouter } from "../llm/types.js";
import { extensionOf, TREE_SITTER_LANGUAGES } from "../indexer/languages.js";
import { loadLanguage } from "../indexer/parser.js";
import { PLACEHOLDER_PATTERNS } from "./suggestedFix.js";
import { TestGenOutputSchema } from "./schemas.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "prompts/test_gen.v1.md");
let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

export interface TestGenPlan {
  ok: true;
  testFilePath: string;
}
export interface TestGenRejection {
  ok: false;
  reason: string;
}

/**
 * Deterministic, per-language filename convention — computed here rather than left to the
 * LLM, matching the codebase's standing rule that anything we can compute ourselves is never
 * left to a model's self-report (engine/snippet.ts's evidence, apply-fix's file paths). Rust
 * is deliberately excluded: its idiomatic tests live in a `#[cfg(test)] mod tests` block
 * INSIDE the same file, not a separate one — generating a whole new file for it would be
 * wrong, not just non-idiomatic, and "append inside an existing file" is a different (and
 * riskier) operation than this feature does. Any other unrecognized extension is rejected the
 * same way, rather than guessing at a convention that might not match the project at all.
 */
export function conventionalTestPath(sourcePath: string): TestGenPlan | TestGenRejection {
  const ext = extensionOf(sourcePath);
  const lastSlash = sourcePath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : sourcePath.slice(0, lastSlash + 1);
  const base = (lastSlash === -1 ? sourcePath : sourcePath.slice(lastSlash + 1)).replace(/\.[^.]+$/, "");

  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { ok: true, testFilePath: `${dir}${base}.test.${ext}` };
    case "py":
      return { ok: true, testFilePath: `${dir}test_${base}.py` };
    case "go":
      return { ok: true, testFilePath: `${dir}${base}_test.go` };
    case "java":
      return { ok: true, testFilePath: `${dir}${base}Test.java` };
    case "kt":
      return { ok: true, testFilePath: `${dir}${base}Test.kt` };
    case "swift":
      return { ok: true, testFilePath: `${dir}${base}Tests.swift` };
    default:
      return {
        ok: false,
        reason: `Automatic test-file generation isn't supported for ".${ext || "unknown"}" files yet — use the suggested test snippet in the finding directly.`,
      };
  }
}

export interface GeneratedTest {
  fileContent: string;
  costUsd: number;
}

/**
 * Generates a complete test file for a "tests"-category finding's missing coverage — the full
 * content of `testFilePath`, whether that path already exists (in which case the model is
 * shown its current content and asked to add to it, output as the complete new file) or is
 * brand new. Mid-tier model: this is well-scoped generation from real context, not open-ended
 * judgment. `null` only when the LLM call itself is dropped (schema validation failed twice,
 * every provider retry failed) — never throws.
 */
export async function generateTestFile(
  router: LlmRouter,
  sourcePath: string,
  sourceContent: string,
  testFilePath: string,
  existingTestContent: string | null,
  finding: { title: string; bodyMd: string; whyItMatters: string; impact: string; suggestedFix?: string | null },
): Promise<GeneratedTest | null> {
  const system = await loadPrompt();
  const parts = [
    `## Finding — missing test coverage`,
    `**${finding.title}**`,
    finding.bodyMd,
    "",
    `Why it matters: ${finding.whyItMatters}`,
    `If ignored: ${finding.impact}`,
    ...(finding.suggestedFix ? ["", "A rough test sketch from the original review (use it as a starting point, not verbatim):", "```", finding.suggestedFix, "```"] : []),
    "",
    `## Source file being tested: ${sourcePath}`,
    "```",
    sourceContent,
    "```",
    "",
    `## Target test file: ${testFilePath}`,
    existingTestContent
      ? `This file already exists — add to it. Its current content:\n\`\`\`\n${existingTestContent}\n\`\`\``
      : "This file does not exist yet — write it from scratch, including all necessary imports.",
  ];

  const result = await router.complete({
    task: "pass.test_gen",
    messages: [
      { role: "system", content: system },
      { role: "user", content: parts.join("\n") },
    ],
    schema: TestGenOutputSchema,
    maxTokens: 3000,
  });
  if (!result.data) return null;

  return { fileContent: result.data.fileContent, costUsd: result.costUsd };
}

export interface TestFileCheck {
  valid: boolean;
  reason?: string;
}

/**
 * Sanity-checks the generated file on its own terms — parsed standalone (never spliced into
 * anything, unlike engine/suggestedFix.ts's validateSuggestedFixSyntax, since this IS the
 * whole file), so a genuine syntax error here is unambiguous. Same placeholder-marker check
 * as a same-location suggestedFix, since a model can produce the same "...", "rest of the
 * tests", TODO-style non-answer here too. Never a correctness proof — it can't know whether
 * the generated assertions are actually right — only that the file isn't empty, isn't a
 * placeholder, and parses.
 */
export async function validateGeneratedTestFile(testFilePath: string, fileContent: string): Promise<TestFileCheck> {
  const trimmed = fileContent.trim();
  if (trimmed.length === 0) return { valid: false, reason: "generated test file was empty" };

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: "generated test file contains a placeholder marker rather than a concrete test" };
    }
  }

  const cfg = TREE_SITTER_LANGUAGES[extensionOf(testFilePath)];
  if (!cfg) return { valid: true }; // no grammar available for this extension — can't check further, don't block on it

  try {
    const { parser } = await loadLanguage(cfg);
    const hasError = parser.parse(fileContent)?.rootNode.hasError ?? false;
    if (hasError) return { valid: false, reason: "generated test file has a syntax error" };
    return { valid: true };
  } catch {
    return { valid: true }; // parsing itself failed (unrelated to the content) — don't block on a checker failure
  }
}
