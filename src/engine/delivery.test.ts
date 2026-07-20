import { describe, expect, it } from "vitest";
import {
  buildLineCommentBody,
  buildSummaryMarkdown,
  computeCheckState,
  computeRiskLevel,
  selectForDelivery,
  type DeliverableFinding,
} from "./delivery.js";

let counter = 0;
function finding(overrides: Partial<DeliverableFinding> = {}): DeliverableFinding {
  counter++;
  return {
    category: "logic",
    path: `src/file${counter}.ts`,
    startLine: 10,
    endLine: 10,
    title: `Finding ${counter}`,
    explanation: "explanation",
    whyItMatters: "matters",
    impact: "impact",
    fixSteps: ["fix it"],
    severity: "major",
    confidence: 0.8,
    needsExecution: false,
    evidence: ["evidence"],
    fingerprint: `fp-${counter}`,
    score: 1.6,
    passes: ["logic"],
    verificationStatus: "verified",
    verificationMethod: "cross_exam",
    verifiedHow: "Confirmed by cross-exam.",
    codeSnippet: "const x = 1;",
    ...overrides,
  };
}

describe("selectForDelivery", () => {
  it("posts critical/major verified findings up to the budget, rest go to digest", () => {
    const findings = [
      finding({ severity: "critical", score: 3 }),
      finding({ severity: "critical", score: 2.9 }),
      finding({ severity: "major", score: 1.6 }),
      finding({ severity: "major", score: 1.5 }),
    ];
    const { posted, digest } = selectForDelivery(findings, 2);
    expect(posted).toHaveLength(2);
    expect(posted.map((f) => f.score)).toEqual([3, 2.9]);
    expect(digest).toHaveLength(2);
  });

  it("never posts minor findings as line comments, even under budget", () => {
    const findings = [finding({ severity: "minor" })];
    const { posted, digest } = selectForDelivery(findings, 7);
    expect(posted).toHaveLength(0);
    expect(digest).toHaveLength(1);
  });

  it("puts rejected findings in their own bucket, never posted or digested", () => {
    const findings = [finding({ verificationStatus: "rejected", severity: "critical" })];
    const { posted, digest, rejected } = selectForDelivery(findings, 7);
    expect(posted).toHaveLength(0);
    expect(digest).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });
});

describe("computeRiskLevel", () => {
  it("is high when any posted finding is critical", () => {
    expect(computeRiskLevel([finding({ severity: "critical" })])).toBe("high");
  });
  it("is medium when the highest posted severity is major", () => {
    expect(computeRiskLevel([finding({ severity: "major" })])).toBe("medium");
  });
  it("is none when nothing was posted", () => {
    expect(computeRiskLevel([])).toBe("none");
  });
});

describe("computeCheckState", () => {
  it("fails when failOnCritical and a critical verified finding exists", () => {
    const state = computeCheckState([finding({ severity: "critical", verificationStatus: "verified" })], true);
    expect(state).toBe("failure");
  });
  it("does not fail when failOnCritical is false, even with a critical verified finding", () => {
    const state = computeCheckState([finding({ severity: "critical", verificationStatus: "verified" })], false);
    expect(state).toBe("neutral");
  });
  it("does not fail on a critical REJECTED finding", () => {
    const state = computeCheckState([finding({ severity: "critical", verificationStatus: "rejected" })], true);
    expect(state).toBe("success");
  });
  it("is success when there are no verified findings at all", () => {
    expect(computeCheckState([], true)).toBe("success");
  });
});

describe("buildSummaryMarkdown", () => {
  it("includes the summary marker for update-in-place, risk level, and stats footer", () => {
    const posted = [finding({ severity: "critical" })];
    const md = buildSummaryMarkdown({
      prStats: { files: 3, additions: 10, deletions: 2 },
      posted,
      digest: [finding({ severity: "minor" })],
      rejected: [finding({ verificationStatus: "rejected" })],
      skippedPasses: ["tests"],
      costUsd: 0.1234,
    });
    expect(md).toContain("codeferret:summary");
    expect(md).toContain("🔴 high");
    expect(md).toContain("+10/-2");
    expect(md).toContain("skipped tests (cost cap)");
    expect(md).toContain("$0.123");
    expect(md).toContain("all verified before posting");
  });

  it("says no high-severity findings when nothing was posted", () => {
    const md = buildSummaryMarkdown({
      prStats: { files: 1, additions: 1, deletions: 0 },
      posted: [],
      digest: [],
      rejected: [],
      skippedPasses: [],
      costUsd: 0,
    });
    expect(md).toContain("No high-severity verified findings this run.");
  });
});

describe("buildLineCommentBody", () => {
  it("includes the fix steps, verification note, and feedback prompt", () => {
    const body = buildLineCommentBody(finding({ suggestedFix: "const x = 2;" }));
    expect(body).toContain("Why it matters:");
    expect(body).toContain("If ignored:");
    expect(body).toContain("- fix it");
    expect(body).toContain("```suggestion");
    expect(body).toContain("Verified via cross-model examination");
    expect(body).toContain("👍 helpful");
  });

  it("omits the suggestion block when there is no suggestedFix", () => {
    const body = buildLineCommentBody(finding({ suggestedFix: undefined }));
    expect(body).not.toContain("```suggestion");
  });
});
