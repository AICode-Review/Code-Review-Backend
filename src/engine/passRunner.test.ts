import { describe, expect, it } from "vitest";
import { createFakeRouter } from "../llm/fakeRouter.js";
import type { TaskKind } from "../llm/types.js";
import { runAllPasses, runPass } from "./passRunner.js";
import type { ReviewContext } from "./contextAssembly.js";
import { buildPrDiff } from "./diff.js";

const DIFF_TEXT = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;
`;

function makeContext(): ReviewContext {
  return {
    prDiff: buildPrDiff({ baseSha: "a", headSha: "b", diffText: DIFF_TEXT }),
    files: [{ path: "src/foo.ts", content: "const x = 2;\n", truncated: false }],
    repoContext: null,
    repoContextTimedOut: false,
  };
}

const CANDIDATE = {
  category: "logic",
  path: "src/foo.ts",
  startLine: 1,
  endLine: 1,
  title: "Suspicious constant change",
  explanation: "x changed from 1 to 2 with no explanation.",
  whyItMatters: "Downstream code may assume x is 1.",
  impact: "Could silently change behavior for callers.",
  fixSteps: ["Confirm the new value is intentional", "Add a comment explaining why"],
  severity: "minor" as const,
  confidence: 0.4,
  needsExecution: false,
  evidence: ["const x = 2;"],
};

describe("runPass", () => {
  it("returns candidates from a valid model response", async () => {
    const router = createFakeRouter({ "pass.logic": { candidates: [CANDIDATE] } });
    const result = await runPass(router, "logic", makeContext());
    expect(result.dropped).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.category).toBe("logic");
  });

  it("returns dropped:true with empty candidates when the model response fails schema validation", async () => {
    const router = createFakeRouter({ "pass.logic": { candidates: [{ bad: "shape" }] } });
    const result = await runPass(router, "logic", makeContext());
    expect(result.dropped).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it("returns empty candidates (not dropped) when the model legitimately finds nothing", async () => {
    const router = createFakeRouter({ "pass.logic": { candidates: [] } });
    const result = await runPass(router, "logic", makeContext());
    expect(result.dropped).toBe(false);
    expect(result.candidates).toEqual([]);
  });
});

describe("runAllPasses", () => {
  it("always runs the 3 required passes even with zero cost cap", async () => {
    const responses: Partial<Record<TaskKind, unknown>> = {
      "pass.logic": { candidates: [CANDIDATE] },
      "pass.security": { candidates: [] },
      "pass.contracts": { candidates: [] },
    };
    const router = createFakeRouter(responses);
    const { results, skippedPasses } = await runAllPasses(router, makeContext(), {
      rulebook: [],
      costCapUsd: 0,
    });
    const passNames = results.map((r) => r.pass).sort();
    expect(passNames).toEqual(["contracts", "logic", "security"]);
    expect(skippedPasses).toEqual(["concurrency", "errors", "tests"]);
  });

  it("runs optional passes while under the cost cap, skips the rest once exceeded", async () => {
    const responses: Partial<Record<TaskKind, unknown>> = {
      "pass.logic": { candidates: [] },
      "pass.security": { candidates: [] },
      "pass.contracts": { candidates: [] },
      "pass.concurrency": { candidates: [] },
    };
    const router = createFakeRouter(responses);
    // fakeRouter costs 0.001 per call; cap of 0.0035 allows the 3 required (0.003) + 1 optional (0.004) to trip the cap after concurrency.
    const { results, skippedPasses, totalCostUsd } = await runAllPasses(router, makeContext(), {
      rulebook: [],
      costCapUsd: 0.0035,
    });
    expect(results.map((r) => r.pass)).toContain("concurrency");
    expect(skippedPasses).toEqual(["errors", "tests"]);
    expect(totalCostUsd).toBeCloseTo(0.004, 5);
  });

  it("only runs the style-lite pass when a rulebook is present", async () => {
    const router = createFakeRouter({
      "pass.logic": { candidates: [] },
      "pass.security": { candidates: [] },
      "pass.contracts": { candidates: [] },
      "pass.concurrency": { candidates: [] },
      "pass.errors": { candidates: [] },
      "pass.tests": { candidates: [] },
      "pass.style": { candidates: [] },
    });
    const withoutRulebook = await runAllPasses(router, makeContext(), { rulebook: [], costCapUsd: 10 });
    expect(withoutRulebook.results.map((r) => r.pass)).not.toContain("style");

    const withRulebook = await runAllPasses(router, makeContext(), {
      rulebook: [{ ruleText: "Don't flag console.log in scripts/", category: "style" }],
      costCapUsd: 10,
    });
    expect(withRulebook.results.map((r) => r.pass)).toContain("style");
  });
});
