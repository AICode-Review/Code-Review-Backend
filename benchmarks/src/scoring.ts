import type { BenchmarkCase, BenchmarkSummary, CaseResult, ReportedFinding } from "./types.js";

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * DESIGN.md §12/§1 — a case is "caught" if at least one reported finding overlaps an
 * expected finding's path+line-range; every reported finding that matches nothing counts
 * as a false positive for that case, operationalizing the ">70% catch rate, <2 false
 * positives per run" differentiation targets.
 */
export function scoreCase(benchCase: BenchmarkCase, reportedFindings: ReportedFinding[]): CaseResult {
  let caught = false;
  let falsePositiveCount = 0;
  for (const reported of reportedFindings) {
    const matchesExpected = benchCase.expectedFindings.some(
      (exp) => exp.path === reported.path && overlaps(exp.lineRange, [reported.startLine, reported.endLine]),
    );
    if (matchesExpected) caught = true;
    else falsePositiveCount++;
  }
  return { caseId: benchCase.id, reportedFindings, caught, falsePositiveCount };
}

export function summarize(results: CaseResult[]): BenchmarkSummary {
  const totalCases = results.length;
  const caughtCases = results.filter((r) => r.caught).length;
  const totalFalsePositives = results.reduce((sum, r) => sum + r.falsePositiveCount, 0);
  return {
    totalCases,
    caughtCases,
    catchRate: totalCases > 0 ? caughtCases / totalCases : 0,
    totalFalsePositives,
    falsePositivesPerRun: totalCases > 0 ? totalFalsePositives / totalCases : 0,
  };
}
