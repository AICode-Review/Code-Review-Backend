import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmRouter, TaskKind } from "../llm/types.js";
import { PassOutputSchema, type Candidate } from "./schemas.js";
import { prDiffToPromptText, type ReviewContext } from "./contextAssembly.js";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export const REQUIRED_PASSES = ["logic", "security", "contracts"] as const;
export const OPTIONAL_PASSES = ["concurrency", "errors", "tests"] as const;
export type PassName = (typeof REQUIRED_PASSES)[number] | (typeof OPTIONAL_PASSES)[number] | "style";

const PASS_TASK: Record<PassName, TaskKind> = {
  logic: "pass.logic",
  security: "pass.security",
  contracts: "pass.contracts",
  concurrency: "pass.concurrency",
  errors: "pass.errors",
  tests: "pass.tests",
  style: "pass.style",
};

export interface RulebookRuleInput {
  ruleText: string;
  category: string;
}

export interface PassResult {
  pass: PassName;
  candidates: Candidate[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Specialist passes always route to Anthropic (DESIGN.md §8). */
  provider: "anthropic";
  /** true when the model's output failed schema validation even after a repair retry — pass contributed nothing, run continues. */
  dropped: boolean;
}

const promptCache = new Map<PassName, string>();

async function loadPrompt(pass: PassName): Promise<string> {
  const cached = promptCache.get(pass);
  if (cached) return cached;
  const text = await readFile(join(promptsDir, `${pass}.v1.md`), "utf8");
  promptCache.set(pass, text);
  return text;
}

/**
 * Diff + full file contents — byte-identical for every pass run against the
 * same ReviewContext, so this is the block marked `cacheable`. An Anthropic
 * prompt-cache hit here means later passes in a run only pay the cheap
 * cache-read rate for this (often large) block instead of full input price
 * (DESIGN.md §8).
 */
/**
 * Best-effort cross-file signal from the repo index (DESIGN.md §6.2 step 2)
 * — never authoritative, so the block itself tells the model to verify
 * before relying on it rather than presenting these as established facts.
 */
function buildRepoContextBlock(ctx: ReviewContext): string | null {
  const rc = ctx.repoContext;
  if (!rc) return null;
  const parts: string[] = [];
  if (rc.definitions.length > 0) {
    parts.push(
      `Definitions elsewhere in the repo:\n${rc.definitions.map((d) => `- ${d.kind} ${d.name} — ${d.path}:${d.startLine}${d.signature ? ` — ${d.signature}` : ""}`).join("\n")}`,
    );
  }
  if (rc.callers.length > 0) {
    parts.push(`Likely callers elsewhere in the repo:\n${rc.callers.map((c) => `- ${c.name} — ${c.path}:${c.startLine}`).join("\n")}`);
  }
  if (rc.relatedTests.length > 0) {
    parts.push(`Related tests:\n${rc.relatedTests.map((t) => `- ${t.name} — ${t.path}:${t.startLine}`).join("\n")}`);
  }
  if (rc.similarChunks.length > 0) {
    parts.push(
      `Similar code elsewhere in the repo:\n${rc.similarChunks.map((s) => `- ${s.path}:${s.startLine}-${s.endLine} (similarity ${s.similarity.toFixed(2)})`).join("\n")}`,
    );
  }
  if (parts.length === 0) return null;
  return `## Repository index context (best-effort, may be stale — verify against the actual file before relying on it)\n${parts.join("\n\n")}`;
}

function buildSharedContextBlock(ctx: ReviewContext): string {
  const diffSummary = ctx.prDiff.files
    .map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`)
    .join("\n");

  const diffText = prDiffToPromptText(ctx.prDiff);

  const fileBlocks = ctx.files
    .map((f) => `### FILE: ${f.path}${f.truncated ? " (truncated)" : ""}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  const repoContextBlock = buildRepoContextBlock(ctx);

  return [
    `## Changed files\n${diffSummary}`,
    `## Diff (line numbers refer to the NEW file for additions/context, OLD for deletions)\n${diffText}`,
    `## Full file contents (head)\n${fileBlocks}`,
    ...(repoContextBlock ? [repoContextBlock] : []),
  ].join("\n\n");
}

function buildRulebookBlock(rulebook: RulebookRuleInput[]): string {
  return `## Rulebook rules\n${rulebook.map((r) => `- [${r.category}] ${r.ruleText}`).join("\n")}`;
}

export async function runPass(
  router: LlmRouter,
  pass: PassName,
  ctx: ReviewContext,
  rulebook?: RulebookRuleInput[],
): Promise<PassResult> {
  const passPrompt = await loadPrompt(pass);
  const sharedContext = buildSharedContextBlock(ctx);

  const result = await router.complete({
    task: PASS_TASK[pass],
    messages: [
      { role: "system", content: sharedContext, cacheable: true },
      ...(rulebook && rulebook.length > 0 ? [{ role: "system" as const, content: buildRulebookBlock(rulebook) }] : []),
      { role: "system", content: passPrompt },
      { role: "user", content: "Produce your JSON response now, following the schema and rules in the system prompt above." },
    ],
    schema: PassOutputSchema,
    maxTokens: 4096,
  });

  return {
    pass,
    candidates: result.data?.candidates ?? [],
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    provider: "anthropic",
    dropped: result.data === null,
  };
}

export interface RunAllPassesResult {
  results: PassResult[];
  totalCostUsd: number;
  anthropicCostUsd: number;
  openaiCostUsd: number;
  skippedPasses: PassName[];
}

/**
 * Required passes (logic/security/contracts) always run, in parallel.
 * Optional passes (+ style-lite when a rulebook exists) run sequentially so
 * we can check the running cost between them and skip the rest once
 * RUN_COST_CAP_USD is exceeded (DESIGN.md §8).
 */
export async function runAllPasses(
  router: LlmRouter,
  ctx: ReviewContext,
  opts: { rulebook: RulebookRuleInput[]; costCapUsd: number },
): Promise<RunAllPassesResult> {
  const results: PassResult[] = [];
  let totalCostUsd = 0;
  let anthropicCostUsd = 0;
  const skippedPasses: PassName[] = [];

  const required = await Promise.all(REQUIRED_PASSES.map((pass) => runPass(router, pass, ctx)));
  for (const r of required) {
    results.push(r);
    totalCostUsd += r.costUsd;
    anthropicCostUsd += r.costUsd;
  }

  const optional: PassName[] = [...OPTIONAL_PASSES, ...(opts.rulebook.length > 0 ? (["style"] as const) : [])];
  for (const pass of optional) {
    if (totalCostUsd >= opts.costCapUsd) {
      skippedPasses.push(pass);
      continue;
    }
    const r = await runPass(router, pass, ctx, pass === "style" ? opts.rulebook : undefined);
    results.push(r);
    totalCostUsd += r.costUsd;
    anthropicCostUsd += r.costUsd;
  }

  // Passes never call OpenAI — openaiCostUsd is always 0 here (skeptic costs land in verify/).
  return { results, totalCostUsd, anthropicCostUsd, openaiCostUsd: 0, skippedPasses };
}
