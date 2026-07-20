import { describe, expect, it } from "vitest";
import { buildPrDiff } from "../../src/engine/diff.js";
import { createFakeRouter } from "../../src/llm/fakeRouter.js";
import { runLocalReview } from "./review.js";
import type { LocalReviewContext } from "./localDiff.js";

const DIFF_TEXT = `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
 export function untouched() {}
+export function authenticate(token: string) {
+}
`;

const CANDIDATE = {
  category: "security",
  path: "src/auth.ts",
  startLine: 2,
  endLine: 2,
  title: "Token used without validation",
  explanation: "The token parameter is accepted but never checked for presence or format.",
  whyItMatters: "An attacker can send an empty or malformed token and reach downstream logic unauthenticated.",
  impact: "Potential auth bypass.",
  fixSteps: ["Validate the token before using it."],
  severity: "critical" as const,
  confidence: 0.9,
  needsExecution: false,
  evidence: ["export function authenticate(token: string) {"],
};

function makeLocal(): LocalReviewContext {
  return {
    prDiff: buildPrDiff({ baseSha: "base", headSha: "head", diffText: DIFF_TEXT }),
    files: [{ path: "src/auth.ts", content: "export function untouched() {}\nexport function authenticate(token: string) {\n}\n", truncated: false }],
  };
}

describe("runLocalReview", () => {
  it("returns only verified findings, wired through passes -> merge -> verify", async () => {
    const router = createFakeRouter({
      "pass.security": { candidates: [CANDIDATE] },
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed: no validation on the token parameter." },
    });
    const findings = await runLocalReview(router, makeLocal(), { costCapUsd: 10 });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("src/auth.ts");
    expect(findings[0]?.verificationStatus).toBe("verified");
  });

  it("drops a candidate the cross-examiner refutes", async () => {
    const router = createFakeRouter({
      "pass.security": { candidates: [CANDIDATE] },
      "verify.cross_exam": { verdict: "refuted", reasoning: "Token is validated by an upstream middleware not shown here." },
    });
    const findings = await runLocalReview(router, makeLocal(), { costCapUsd: 10 });
    expect(findings).toHaveLength(0);
  });

  it("returns nothing when no pass reports a candidate", async () => {
    const router = createFakeRouter({ "pass.security": { candidates: [] } });
    const findings = await runLocalReview(router, makeLocal(), { costCapUsd: 10 });
    expect(findings).toEqual([]);
  });

  it("stops before spending past the cost cap", async () => {
    const router = createFakeRouter({
      "pass.security": { candidates: [CANDIDATE] },
      "verify.cross_exam": { verdict: "upheld", reasoning: "x" },
    });
    // fakeRouter costs 0.001/call; a cap of 0 means even the required passes exceed it immediately.
    const findings = await runLocalReview(router, makeLocal(), { costCapUsd: 0 });
    expect(findings).toEqual([]);
  });
});
