import { describe, expect, it } from "vitest";
import { createFakeRouter } from "../llm/fakeRouter.js";
import { verifyFinding } from "./index.js";
import type { Candidate } from "../engine/schemas.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    category: "logic",
    path: "src/foo.ts",
    startLine: 2,
    endLine: 2,
    title: "Bug",
    explanation: "explanation",
    whyItMatters: "matters",
    impact: "impact",
    fixSteps: ["fix it"],
    severity: "major",
    confidence: 0.7,
    needsExecution: false,
    evidence: ["const x = 1;"],
    ...overrides,
  };
}

const FILES = new Map([["src/foo.ts", "line one\nconst x = 1;\nline three\n"]]);

describe("verifyFinding", () => {
  it("rejects at the static check stage without calling the LLM (hallucinated file)", async () => {
    const router = createFakeRouter({}); // no cross-exam response configured — would return null/dropped if called
    const outcome = await verifyFinding(router, candidate({ path: "src/missing.ts" }), FILES);
    expect(outcome.status).toBe("rejected");
    expect(outcome.method).toBe("static");
    expect(outcome.costUsd).toBe(0);
    expect(outcome.anthropicCostUsd).toBe(0);
    expect(outcome.openaiCostUsd).toBe(0);
  });

  it("attributes cross-exam cost to OpenAI and zero Anthropic when no repro-gen runs", async () => {
    const router = createFakeRouter({ "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed the bug is real." } });
    const outcome = await verifyFinding(router, candidate(), FILES);
    expect(outcome.status).toBe("verified");
    expect(outcome.openaiCostUsd).toBeGreaterThan(0);
    expect(outcome.anthropicCostUsd).toBe(0);
    expect(outcome.costUsd).toBeCloseTo(outcome.openaiCostUsd);
  });

  it("verifies only when cross-exam explicitly upholds the claim", async () => {
    const router = createFakeRouter({ "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed the bug is real." } });
    const outcome = await verifyFinding(router, candidate(), FILES);
    expect(outcome.status).toBe("verified");
    expect(outcome.method).toBe("cross_exam");
  });

  it("rejects when cross-exam refutes the claim", async () => {
    const router = createFakeRouter({ "verify.cross_exam": { verdict: "refuted", reasoning: "The condition is actually correct." } });
    const outcome = await verifyFinding(router, candidate(), FILES);
    expect(outcome.status).toBe("rejected");
    expect(outcome.method).toBe("cross_exam");
  });

  it("rejects (fails closed) when cross-exam is uncertain — precision-first policy", async () => {
    const router = createFakeRouter({ "verify.cross_exam": { verdict: "uncertain", reasoning: "Depends on runtime state not shown." } });
    const outcome = await verifyFinding(router, candidate(), FILES);
    expect(outcome.status).toBe("rejected");
    expect(outcome.verifiedHow).toContain("runtime state");
  });

  it("rejects (fails closed) an unparseable cross-exam response rather than crashing or guessing", async () => {
    const router = createFakeRouter({ "verify.cross_exam": { garbage: true } });
    const outcome = await verifyFinding(router, candidate(), FILES);
    expect(outcome.status).toBe("rejected");
    expect(outcome.method).toBe("cross_exam");
  });
});

describe("verifyFinding — sandbox execution (needsExecution)", () => {
  it("verifies via execution when the sandbox reproduces the defect, regardless of cross-exam", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "refuted", reasoning: "Looks fine to me." },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "process.exit(1)" },
    });
    const runSandbox = async () => ({ available: true, reproduced: true, output: "AssertionError" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true }), FILES, runSandbox);
    expect(outcome.status).toBe("verified");
    expect(outcome.method).toBe("execution");
  });

  it("rejects when the sandbox runs but does not reproduce, and cross-exam isn't high-confidence upheld", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "uncertain", reasoning: "Can't be sure." },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "process.exit(0)" },
    });
    const runSandbox = async () => ({ available: true, reproduced: false, output: "" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true }), FILES, runSandbox);
    expect(outcome.status).toBe("rejected");
    expect(outcome.method).toBe("execution");
  });

  it("falls back to a high-confidence cross-exam upheld when the sandbox doesn't reproduce", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed via file inspection." },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "process.exit(0)" },
    });
    const runSandbox = async () => ({ available: true, reproduced: false, output: "" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true, confidence: 0.9 }), FILES, runSandbox);
    expect(outcome.status).toBe("verified");
    expect(outcome.method).toBe("cross_exam");
  });

  it("does not let a low-confidence cross-exam upheld override a sandbox non-reproduction", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed via file inspection." },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "process.exit(0)" },
    });
    const runSandbox = async () => ({ available: true, reproduced: false, output: "" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true, confidence: 0.4 }), FILES, runSandbox);
    expect(outcome.status).toBe("rejected");
    expect(outcome.method).toBe("execution");
  });

  it("falls back to cross-exam-only when Docker is unavailable, without penalizing the finding", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed via file inspection." },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "process.exit(1)" },
    });
    const runSandbox = async () => ({ available: false, reproduced: false, output: "" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true }), FILES, runSandbox);
    expect(outcome.status).toBe("verified");
    expect(outcome.method).toBe("cross_exam");
  });

  it("skips the sandbox entirely when the model can't generate a real repro", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed via file inspection." },
      "verify.repro_gen": { canGenerate: false },
    });
    let called = false;
    const runSandbox = async (): Promise<{ available: boolean; reproduced: boolean; output: string }> => {
      called = true;
      return { available: true, reproduced: true, output: "" };
    };
    const outcome = await verifyFinding(router, candidate({ needsExecution: true }), FILES, runSandbox);
    expect(called).toBe(false);
    expect(outcome.method).toBe("cross_exam");
  });

  it("skips the sandbox entirely for a language it doesn't cover", async () => {
    const router = createFakeRouter({ "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed." } });
    let called = false;
    const runSandbox = async (): Promise<{ available: boolean; reproduced: boolean; output: string }> => {
      called = true;
      return { available: true, reproduced: true, output: "" };
    };
    const outcome = await verifyFinding(
      router,
      candidate({ needsExecution: true, path: "src/foo.rb" }),
      new Map([["src/foo.rb", "line one\nconst x = 1;\nline three\n"]]),
      runSandbox,
    );
    expect(called).toBe(false);
    expect(outcome.method).toBe("cross_exam");
  });

  it("never attempts the sandbox when needsExecution is false", async () => {
    const router = createFakeRouter({ "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed." } });
    let called = false;
    const runSandbox = async (): Promise<{ available: boolean; reproduced: boolean; output: string }> => {
      called = true;
      return { available: true, reproduced: true, output: "" };
    };
    const outcome = await verifyFinding(router, candidate({ needsExecution: false }), FILES, runSandbox);
    expect(called).toBe(false);
    expect(outcome.method).toBe("cross_exam");
  });
});
