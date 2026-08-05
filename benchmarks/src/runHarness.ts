import { seedCases } from "./dataset/seed.js";
import { scoreCase, summarize } from "./scoring.js";
import type { BenchmarkCase, ReportedFinding } from "./types.js";
import { env } from "../../src/config.js";
import { createLlmRouter } from "../../src/llm/router.js";
import { buildPrDiff, diffTextForPath } from "../../src/engine/diff.js";
import type { ReviewContext } from "../../src/engine/contextAssembly.js";
import { runAllPasses } from "../../src/engine/passRunner.js";
import { mergeAndScore, type PassCandidates } from "../../src/engine/merge.js";
import { verifyFinding } from "../../src/verify/index.js";

/**
 * Runs one case through the real engine (route (a) from this function's former doc
 * comment) — a fake ReviewContext built directly from the case's diff/files (no adapter,
 * no db, no repo index: benchmark cases are self-contained), the real LlmRouter, the same
 * runAllPasses → mergeAndScore → verifyFinding pipeline jobs/reviewRun.ts uses. Only
 * VERIFIED findings are reported — this measures the *verified* catch rate DESIGN.md §1
 * targets (>70%), not raw candidate output before verification.
 */
async function reviewCase(benchCase: BenchmarkCase): Promise<ReportedFinding[]> {
  const router = createLlmRouter();

  const prDiff = buildPrDiff({ baseSha: "base", headSha: "head", diffText: benchCase.diff });
  const ctx: ReviewContext = {
    prDiff,
    files: Object.entries(benchCase.files).map(([path, content]) => ({ path, content, truncated: false })),
    repoContext: null,
    repoContextTimedOut: false,
  };

  const { results } = await runAllPasses(router, ctx, { rulebook: [], costCapUsd: env().RUN_COST_CAP_USD });
  const candidatesByPass: PassCandidates[] = results.map((r) => ({ pass: r.pass, candidates: r.candidates }));
  const merged = mergeAndScore(candidatesByPass);

  const filesMap = new Map(Object.entries(benchCase.files));
  const verified = await Promise.all(
    merged.map(async (finding) => ({
      finding,
      outcome: await verifyFinding(router, finding, filesMap, undefined, diffTextForPath(prDiff, finding.path) ?? undefined),
    })),
  );

  return verified
    .filter(({ outcome }) => outcome.status === "verified")
    .map(({ finding }) => ({
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      category: finding.category,
    }));
}

async function main(): Promise<void> {
  const results = [];
  for (const benchCase of seedCases) {
    const findings = await reviewCase(benchCase);
    results.push(scoreCase(benchCase, findings));
  }
  const summary = summarize(results);

  console.log(`\nCases: ${summary.totalCases}  Caught: ${summary.caughtCases}  Catch rate: ${(summary.catchRate * 100).toFixed(1)}%`);
  console.log(`False positives: ${summary.totalFalsePositives} total, ${summary.falsePositivesPerRun.toFixed(2)} per case\n`);
  for (const r of results) {
    console.log(`  ${r.caught ? "✓" : "✗"} ${r.caseId}${r.falsePositiveCount > 0 ? ` (+${r.falsePositiveCount} FP)` : ""}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
