import { runAllPasses } from "../../src/engine/passRunner.js";
import { mergeAndScore, type PassCandidates } from "../../src/engine/merge.js";
import { verifyFinding } from "../../src/verify/index.js";
import type { ReviewContext } from "../../src/engine/contextAssembly.js";
import type { LlmRouter } from "../../src/llm/types.js";
import type { LocalReviewContext } from "./localDiff.js";

export interface LocalFinding {
  category: string;
  path: string;
  startLine: number;
  endLine: number;
  title: string;
  explanation: string;
  whyItMatters: string;
  impact: string;
  fixSteps: string[];
  suggestedFix?: string;
  severity: "critical" | "major" | "minor";
  verificationStatus: "verified" | "rejected";
  verifiedHow: string;
}

export interface RunReviewOptions {
  costCapUsd: number;
}

/**
 * DESIGN.md §6 core loop, run locally: specialist passes -> merge/score -> verification.
 * Deliberately excludes the delivery/posting step (DESIGN.md §6.6) — there's no PR to
 * comment on locally; the CLI's job ends at "here's what we found," left to the caller
 * to print or serialize.
 */
export async function runLocalReview(router: LlmRouter, local: LocalReviewContext, opts: RunReviewOptions): Promise<LocalFinding[]> {
  const ctx: ReviewContext = { prDiff: local.prDiff, files: local.files, repoContext: null, repoContextTimedOut: false };

  const { results } = await runAllPasses(router, ctx, { rulebook: [], costCapUsd: opts.costCapUsd });
  const candidatesByPass: PassCandidates[] = results.map((r) => ({ pass: r.pass, candidates: r.candidates }));
  const merged = mergeAndScore(candidatesByPass);

  const filesByPath = new Map(local.files.map((f) => [f.path, f.content]));
  const findings: LocalFinding[] = [];
  let spentUsd = results.reduce((sum, r) => sum + r.costUsd, 0);

  for (const candidate of merged) {
    if (spentUsd >= opts.costCapUsd) break;
    const outcome = await verifyFinding(router, candidate, filesByPath);
    spentUsd += outcome.costUsd;
    if (outcome.status !== "verified") continue; // precision-first — same policy as the PR bot (DESIGN.md §6.5)
    findings.push({
      category: candidate.category,
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      title: candidate.title,
      explanation: candidate.explanation,
      whyItMatters: candidate.whyItMatters,
      impact: candidate.impact,
      fixSteps: candidate.fixSteps,
      suggestedFix: candidate.suggestedFix,
      severity: candidate.severity,
      verificationStatus: outcome.status,
      verifiedHow: outcome.verifiedHow,
    });
  }

  return findings;
}
