import { describe, expect, it } from "vitest";
import { scoreCase, summarize } from "./scoring.js";
import { BenchmarkCaseSchema, type BenchmarkCase, type CaseResult } from "./types.js";
import { seedCases } from "./dataset/seed.js";

const BASE_CASE: BenchmarkCase = {
  id: "test-case",
  source: "synthetic",
  repo: "seed/synthetic",
  language: "typescript",
  description: "test",
  diff: "diff --git a/x.ts b/x.ts",
  files: { "x.ts": "content" },
  expectedFindings: [{ path: "x.ts", lineRange: [10, 12], category: "logic", severity: "major", description: "the bug" }],
};

describe("scoreCase", () => {
  it("is caught when a reported finding overlaps the expected range", () => {
    const result = scoreCase(BASE_CASE, [{ path: "x.ts", startLine: 11, endLine: 11, category: "logic" }]);
    expect(result.caught).toBe(true);
    expect(result.falsePositiveCount).toBe(0);
  });

  it("is not caught when nothing was reported", () => {
    const result = scoreCase(BASE_CASE, []);
    expect(result.caught).toBe(false);
    expect(result.falsePositiveCount).toBe(0);
  });

  it("counts a finding on a different path as a false positive, not a catch", () => {
    const result = scoreCase(BASE_CASE, [{ path: "other.ts", startLine: 11, endLine: 11, category: "logic" }]);
    expect(result.caught).toBe(false);
    expect(result.falsePositiveCount).toBe(1);
  });

  it("counts a finding on the right path but a non-overlapping range as a false positive", () => {
    const result = scoreCase(BASE_CASE, [{ path: "x.ts", startLine: 50, endLine: 52, category: "logic" }]);
    expect(result.caught).toBe(false);
    expect(result.falsePositiveCount).toBe(1);
  });

  it("counts each unmatched finding separately when several are reported", () => {
    const result = scoreCase(BASE_CASE, [
      { path: "x.ts", startLine: 11, endLine: 11, category: "logic" }, // matches
      { path: "x.ts", startLine: 1, endLine: 1, category: "style" }, // noise
      { path: "other.ts", startLine: 5, endLine: 5, category: "logic" }, // noise
    ]);
    expect(result.caught).toBe(true);
    expect(result.falsePositiveCount).toBe(2);
  });

  it("treats a range that merely touches the boundary as overlapping", () => {
    const result = scoreCase(BASE_CASE, [{ path: "x.ts", startLine: 12, endLine: 20, category: "logic" }]);
    expect(result.caught).toBe(true);
  });
});

describe("summarize", () => {
  function result(overrides: Partial<CaseResult>): CaseResult {
    return { caseId: "c", reportedFindings: [], caught: false, falsePositiveCount: 0, ...overrides };
  }

  it("computes catch rate and average false positives across cases", () => {
    const summary = summarize([
      result({ caught: true, falsePositiveCount: 0 }),
      result({ caught: true, falsePositiveCount: 2 }),
      result({ caught: false, falsePositiveCount: 1 }),
      result({ caught: false, falsePositiveCount: 0 }),
    ]);
    expect(summary.totalCases).toBe(4);
    expect(summary.caughtCases).toBe(2);
    expect(summary.catchRate).toBe(0.5);
    expect(summary.totalFalsePositives).toBe(3);
    expect(summary.falsePositivesPerRun).toBe(0.75);
  });

  it("returns zeroes rather than dividing by zero for an empty result set", () => {
    const summary = summarize([]);
    expect(summary).toEqual({ totalCases: 0, caughtCases: 0, catchRate: 0, totalFalsePositives: 0, falsePositivesPerRun: 0 });
  });
});

describe("seed dataset", () => {
  it("every case parses against BenchmarkCaseSchema", () => {
    for (const c of seedCases) {
      const parsed = BenchmarkCaseSchema.safeParse(c);
      expect(parsed.success, `case "${c.id}" failed schema validation: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
  });

  it("has unique case ids", () => {
    const ids = seedCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only marks a case real_pr when it actually has a prUrl", () => {
    for (const c of seedCases) {
      if (c.source === "real_pr") expect(c.prUrl, `case "${c.id}" is source:real_pr but has no prUrl`).toBeDefined();
    }
  });

  it("every expected finding's file is present in that case's files map", () => {
    for (const c of seedCases) {
      for (const finding of c.expectedFindings) {
        expect(Object.keys(c.files), `case "${c.id}" expects a finding in ${finding.path}, which isn't in files`).toContain(finding.path);
      }
    }
  });

  it("every expected finding's line range is within its file's actual line count", () => {
    for (const c of seedCases) {
      for (const finding of c.expectedFindings) {
        const content = c.files[finding.path];
        if (!content) continue; // covered by the previous test
        const lineCount = content.split("\n").length;
        expect(finding.lineRange[1], `case "${c.id}": ${finding.path} only has ${lineCount} lines`).toBeLessThanOrEqual(lineCount);
      }
    }
  });

  it("covers more than one finding category (a real spread, not all logic bugs)", () => {
    const categories = new Set(seedCases.flatMap((c) => c.expectedFindings.map((f) => f.category)));
    expect(categories.size).toBeGreaterThanOrEqual(4);
  });
});
