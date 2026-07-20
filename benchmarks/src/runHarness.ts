import { seedCases } from "./dataset/seed.js";
import { scoreCase, summarize } from "./scoring.js";
import type { BenchmarkCase, ReportedFinding } from "./types.js";

/**
 * Runs one case through whatever's under test and returns its findings in the harness's
 * narrow ReportedFinding shape. This is the one integration point NOT wired up yet —
 * deliberately: actually running a case means real Anthropic/OpenAI API spend per DESIGN.md
 * §6/§8's real pipeline, and this repo hasn't funded/run a real benchmark pass yet (see
 * README.md). Wire this to either:
 *   (a) a direct import of the backend's engine functions (runAllPasses + verifyFinding
 *       from ../../src/engine, ../../src/verify) against a fake ReviewContext
 *       built from `case.diff`/`case.files`, using the REAL LlmRouter (createLlmRouter()),
 *       or
 *   (b) a lightweight backend endpoint that runs the same engine functions server-side and
 *       returns findings as JSON, if running benchmarks from a machine without direct
 *       filesystem access to backend/ is a requirement later.
 * Route (a) needs no new backend code, just a cross-package import — the natural next step.
 */
async function reviewCase(_benchCase: BenchmarkCase): Promise<ReportedFinding[]> {
  throw new Error(
    "reviewCase() is not wired to the live engine yet — see the doc comment above runHarness.ts. " +
      "Running this for real means spending Anthropic/OpenAI API budget; that's a deliberate choice to make explicitly, not a default.",
  );
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
