import { describe, expect, it } from "vitest";
import { computeFingerprint, mergeAndScore, MIN_CANDIDATE_CONFIDENCE, suppressPreviouslyDismissed, type PassCandidates } from "./merge.js";
import type { Candidate } from "./schemas.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    category: "logic",
    path: "src/foo.ts",
    startLine: 10,
    endLine: 12,
    title: "Off-by-one in loop bound",
    explanation: "Loop should be < length, not <= length.",
    whyItMatters: "Reads one element past the end of the array.",
    impact: "Off-by-one access, likely undefined or a crash.",
    fixSteps: ["Change <= to <"],
    severity: "major",
    confidence: 0.7,
    needsExecution: false,
    evidence: ["for (let i = 0; i <= arr.length; i++)"],
    ...overrides,
  };
}

describe("mergeAndScore", () => {
  it("keeps distinct findings that don't overlap", () => {
    const byPass: PassCandidates[] = [
      { pass: "logic", candidates: [candidate({ startLine: 10, endLine: 12 })] },
      { pass: "security", candidates: [candidate({ category: "security", startLine: 40, endLine: 42, severity: "critical" })] },
    ];
    const result = mergeAndScore(byPass);
    expect(result).toHaveLength(2);
  });

  it("dedupes overlapping same-category findings, keeping the higher-confidence one and merging evidence/passes", () => {
    const low = candidate({ confidence: 0.3, evidence: ["weak signal"] });
    const high = candidate({ confidence: 0.8, evidence: ["strong signal"] });
    const byPass: PassCandidates[] = [
      { pass: "logic", candidates: [low] },
      { pass: "concurrency", candidates: [high] },
    ];
    const result = mergeAndScore(byPass);
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe(0.8);
    expect(result[0]?.evidence).toEqual(expect.arrayContaining(["weak signal", "strong signal"]));
    expect(result[0]?.passes).toEqual(expect.arrayContaining(["logic", "concurrency"]));
  });

  it("does not merge findings in different categories even if lines overlap", () => {
    const byPass: PassCandidates[] = [
      { pass: "logic", candidates: [candidate({ category: "logic" })] },
      { pass: "security", candidates: [candidate({ category: "security" })] },
    ];
    expect(mergeAndScore(byPass)).toHaveLength(2);
  });

  it("scores critical higher than major at equal confidence, and sorts descending", () => {
    const byPass: PassCandidates[] = [
      { pass: "logic", candidates: [candidate({ severity: "minor", confidence: 0.9, startLine: 1, endLine: 1 })] },
      { pass: "security", candidates: [candidate({ category: "security", severity: "critical", confidence: 0.9, startLine: 50, endLine: 50 })] },
    ];
    const result = mergeAndScore(byPass);
    expect(result[0]?.severity).toBe("critical");
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score);
  });

  it("drops a finding entirely when the rulebook boost is 0 (active suppression)", () => {
    const byPass: PassCandidates[] = [{ pass: "style", candidates: [candidate({ category: "style" })] }];
    const result = mergeAndScore(byPass, (category) => (category === "style" ? 0 : 1));
    expect(result).toHaveLength(0);
  });

  it("applies a rulebook boost > 1 to raise score", () => {
    const byPass: PassCandidates[] = [{ pass: "logic", candidates: [candidate()] }];
    const boosted = mergeAndScore(byPass, () => 2);
    const unboosted = mergeAndScore(byPass, () => 1);
    expect(boosted[0]!.score).toBeCloseTo(unboosted[0]!.score * 2, 5);
  });

  it("drops a candidate below the minimum confidence floor entirely", () => {
    const byPass: PassCandidates[] = [
      { pass: "logic", candidates: [candidate({ confidence: MIN_CANDIDATE_CONFIDENCE - 0.01 })] },
    ];
    expect(mergeAndScore(byPass)).toHaveLength(0);
  });

  it("keeps a candidate exactly at the minimum confidence floor", () => {
    const byPass: PassCandidates[] = [{ pass: "logic", candidates: [candidate({ confidence: MIN_CANDIDATE_CONFIDENCE })] }];
    expect(mergeAndScore(byPass)).toHaveLength(1);
  });

  it("a below-floor candidate never suppresses a real one it would have deduped with", () => {
    const weak = candidate({ confidence: MIN_CANDIDATE_CONFIDENCE - 0.05, evidence: ["weak"] });
    const real = candidate({ confidence: 0.8, evidence: ["strong signal"] });
    const byPass: PassCandidates[] = [
      { pass: "logic", candidates: [weak] },
      { pass: "security", candidates: [real] },
    ];
    const result = mergeAndScore(byPass);
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe(0.8);
    expect(result[0]?.evidence).not.toContain("weak");
  });
});

describe("computeFingerprint", () => {
  it("is stable for identical category/path/evidence", () => {
    const a = computeFingerprint(candidate());
    const b = computeFingerprint(candidate());
    expect(a).toBe(b);
  });

  it("is insensitive to whitespace/case differences in evidence", () => {
    const a = computeFingerprint(candidate({ evidence: ["  For (let I = 0; ...)  "] }));
    const b = computeFingerprint(candidate({ evidence: ["for (let i = 0; ...)"] }));
    expect(a).toBe(b);
  });

  it("differs across categories or paths for otherwise-identical evidence", () => {
    const a = computeFingerprint(candidate({ category: "logic" }));
    const b = computeFingerprint(candidate({ category: "security" }));
    const c = computeFingerprint(candidate({ path: "src/bar.ts" }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("is stable across evidence-array reordering — a re-run with the same evidence in a different order must not break dismiss/ignore carry-forward", () => {
    const a = computeFingerprint(candidate({ evidence: ["first quote", "second quote"] }));
    const b = computeFingerprint(candidate({ evidence: ["second quote", "first quote"] }));
    expect(a).toBe(b);
  });

  it("still differs when the evidence set itself is actually different", () => {
    const a = computeFingerprint(candidate({ evidence: ["first quote", "second quote"] }));
    const b = computeFingerprint(candidate({ evidence: ["first quote", "a different quote"] }));
    expect(a).not.toBe(b);
  });
});

describe("suppressPreviouslyDismissed", () => {
  it("filters out findings whose fingerprint was dismissed or ignored before", () => {
    const findings = [{ fingerprint: "fp1" }, { fingerprint: "fp2" }, { fingerprint: "fp3" }];
    const priorFeedback = new Map<string, "accepted" | "dismissed" | "fixed" | "ignored">([
      ["fp1", "dismissed"],
      ["fp2", "accepted"],
      ["fp3", "ignored"],
    ]);
    const result = suppressPreviouslyDismissed(findings, priorFeedback);
    expect(result).toEqual([{ fingerprint: "fp2" }]);
  });

  it("keeps findings with no prior feedback history", () => {
    const findings = [{ fingerprint: "new-fp" }];
    const result = suppressPreviouslyDismissed(findings, new Map());
    expect(result).toEqual(findings);
  });
});
