import { z } from "zod";

/**
 * DESIGN.md §12 — one benchmark case is a diff to review plus the file contents a reviewer
 * would need, and the ground-truth location(s) of the bug it should catch. `source`
 * distinguishes a real mined OSS PR (has a verifiable `prUrl`) from a hand-authored
 * synthetic case (DESIGN.md's "injected-bug PRs for controlled recall tests") — never
 * present a synthetic case as if it were a real one.
 */
export const BenchmarkCaseSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["real_pr", "synthetic"]),
  prUrl: z.string().url().optional(),
  repo: z.string().min(1),
  language: z.string().min(1),
  description: z.string().min(1),
  /** Unified diff text for the change under review. */
  diff: z.string().min(1),
  /** Head-version file contents the reviewer needs, keyed by path — mirrors what engine/contextAssembly.ts fetches for changed files. Include an unaffected caller file too when the case specifically tests cross-file awareness (the contracts pass / repo-index context). */
  files: z.record(z.string(), z.string()),
  expectedFindings: z
    .array(
      z.object({
        path: z.string().min(1),
        lineRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        category: z.enum(["logic", "security", "contracts", "concurrency", "errors", "tests", "style"]),
        severity: z.enum(["critical", "major", "minor"]),
        description: z.string().min(1),
      }),
    )
    .min(1),
});
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

/** What the harness expects back from whatever's under test — deliberately narrower than the backend's full Candidate shape, since scoring only needs location + category. */
export interface ReportedFinding {
  path: string;
  startLine: number;
  endLine: number;
  category: string;
}

export interface CaseResult {
  caseId: string;
  reportedFindings: ReportedFinding[];
  caught: boolean;
  falsePositiveCount: number;
}

export interface BenchmarkSummary {
  totalCases: number;
  caughtCases: number;
  catchRate: number;
  totalFalsePositives: number;
  falsePositivesPerRun: number;
}
