import { describe, expect, it } from "vitest";
import { createFakeRouter } from "../llm/fakeRouter.js";
import { verifyFinding } from "./index.js";
import type { Candidate } from "../engine/schemas.js";
import type { CompleteRequest, CompleteResult, LlmRouter } from "../llm/types.js";

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

  it("includes the PR diff in the cross-exam prompt when the caller has one, so a before/after claim (e.g. 'escaping was removed') is actually checkable", async () => {
    const capturedMessages: string[] = [];
    const router: LlmRouter = {
      async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
        capturedMessages.push(...req.messages.map((m) => m.content));
        const parsed = req.schema.safeParse({ verdict: "upheld", reasoning: "Confirmed via the diff." });
        return {
          data: parsed.success ? parsed.data : null,
          inputTokens: 10,
          outputTokens: 10,
          costUsd: 0.001,
          model: "fake-model",
          provider: "openai",
        };
      },
    };
    const diffText = "### DIFF: src/foo.ts (+1/-1)\n-2: const x = 2;\n+2: const x = 1;";
    await verifyFinding(router, candidate(), FILES, undefined, diffText);
    expect(capturedMessages.some((m) => m.includes(diffText))).toBe(true);
  });

  it("omits the diff section from the prompt when the caller has no diff for this path", async () => {
    const capturedMessages: string[] = [];
    const router: LlmRouter = {
      async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
        capturedMessages.push(...req.messages.map((m) => m.content));
        const parsed = req.schema.safeParse({ verdict: "upheld", reasoning: "Confirmed." });
        return { data: parsed.success ? parsed.data : null, inputTokens: 10, outputTokens: 10, costUsd: 0.001, model: "fake-model", provider: "openai" };
      },
    };
    await verifyFinding(router, candidate(), FILES);
    expect(capturedMessages.some((m) => m.includes("What changed in this PR"))).toBe(false);
  });
});

describe("verifyFinding — cross-file context for contracts findings", () => {
  function capturingRouter(capturedMessages: string[]): LlmRouter {
    return {
      async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
        capturedMessages.push(...req.messages.map((m) => m.content));
        const parsed = req.schema.safeParse({ verdict: "upheld", reasoning: "Confirmed via the caller." });
        return { data: parsed.success ? parsed.data : null, inputTokens: 10, outputTokens: 10, costUsd: 0.001, model: "fake-model", provider: "openai" };
      },
    };
  }

  const MULTI_FILES = new Map([
    ["src/lib/discount.ts", "export function applyDiscount(price, pct, cap) {\n  return price;\n}\n"],
    ["src/checkout/summary.ts", "import { applyDiscount } from '../lib/discount.js';\ncomputeTotal(price, pct) {\n  return applyDiscount(price, pct);\n}\n"],
  ]);

  it("shows the skeptic other files from this PR for a contracts finding, so a caller claim is actually checkable", async () => {
    const capturedMessages: string[] = [];
    const router = capturingRouter(capturedMessages);
    await verifyFinding(
      router,
      candidate({
        category: "contracts",
        path: "src/lib/discount.ts",
        explanation: "summary.ts calls applyDiscount with only 2 args",
        evidence: ["export function applyDiscount(price, pct, cap) {"],
      }),
      MULTI_FILES,
    );
    expect(capturedMessages.some((m) => m.includes("for checking a claim about a caller/consumer elsewhere"))).toBe(true);
    expect(capturedMessages.some((m) => m.includes("src/checkout/summary.ts"))).toBe(true);
    expect(capturedMessages.some((m) => m.includes("computeTotal"))).toBe(true);
  });

  it("includes repo-index context text for a contracts finding when provided", async () => {
    const capturedMessages: string[] = [];
    const router = capturingRouter(capturedMessages);
    const repoContextText = "## Repository index context (best-effort, may be stale — verify against the actual file before relying on it)\nLikely callers elsewhere in the repo:\n- computeTotal — src/checkout/summary.ts:3";
    await verifyFinding(
      router,
      candidate({
        category: "contracts",
        path: "src/lib/discount.ts",
        evidence: ["export function applyDiscount(price, pct, cap) {"],
      }),
      MULTI_FILES,
      undefined,
      undefined,
      repoContextText,
    );
    expect(capturedMessages.some((m) => m.includes("Likely callers elsewhere in the repo"))).toBe(true);
  });

  it("does NOT show other files or repo-index context for a non-contracts finding — not worth the extra tokens", async () => {
    const capturedMessages: string[] = [];
    const router = capturingRouter(capturedMessages);
    const repoContextText = "## Repository index context\nLikely callers elsewhere in the repo:\n- computeTotal — src/checkout/summary.ts:3";
    await verifyFinding(
      router,
      candidate({
        category: "logic",
        path: "src/lib/discount.ts",
        evidence: ["export function applyDiscount(price, pct, cap) {"],
      }),
      MULTI_FILES,
      undefined,
      undefined,
      repoContextText,
    );
    // Both headings appear verbatim in the system prompt's own instructions (describing when
    // they *might* show up for a contracts finding), so check for content that only exists in
    // the dynamically-built sections themselves, not the static heading text.
    expect(capturedMessages.some((m) => m.includes("src/checkout/summary.ts"))).toBe(false);
    expect(capturedMessages.some((m) => m.includes("computeTotal"))).toBe(false);
    expect(capturedMessages.some((m) => m.includes("Likely callers elsewhere in the repo"))).toBe(false);
  });

  it("also shows cross-file context for a tests finding — 'no test covers this' is a claim about a file it may not have been shown", async () => {
    const capturedMessages: string[] = [];
    const router = capturingRouter(capturedMessages);
    await verifyFinding(
      router,
      candidate({
        category: "tests",
        path: "src/lib/discount.ts",
        explanation: "No test exercises the new cap parameter",
        evidence: ["export function applyDiscount(price, pct, cap) {"],
      }),
      MULTI_FILES,
    );
    expect(capturedMessages.some((m) => m.includes("for checking a claim about a caller/consumer elsewhere"))).toBe(true);
    expect(capturedMessages.some((m) => m.includes("src/checkout/summary.ts"))).toBe(true);
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

  it("skips the sandbox when the model's self-reported language doesn't match the file's actual language", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed via file inspection." },
      // src/foo.ts -> sandboxLang "node", but the model reported "python" — a mismatch.
      "verify.repro_gen": { canGenerate: true, language: "python", testCode: "import sys; sys.exit(1)" },
    });
    let called = false;
    const runSandbox = async (): Promise<{ available: boolean; reproduced: boolean; output: string }> => {
      called = true;
      // Would report a false "reproduced" if this ever ran — proves the mismatch check
      // is what's actually preventing the sandbox call, not some other reason.
      return { available: true, reproduced: true, output: "" };
    };
    const outcome = await verifyFinding(router, candidate({ needsExecution: true }), FILES, runSandbox);
    expect(called).toBe(false);
    expect(outcome.method).toBe("cross_exam");
    expect(outcome.status).toBe("verified"); // still verified via cross-exam fallback, just not falsely via execution
  });

  it("still attempts the sandbox when the model omits the optional language field entirely", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "refuted", reasoning: "Looks fine to me." },
      "verify.repro_gen": { canGenerate: true, testCode: "process.exit(1)" }, // no `language` field
    });
    const runSandbox = async () => ({ available: true, reproduced: true, output: "AssertionError" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true }), FILES, runSandbox);
    expect(outcome.status).toBe("verified");
    expect(outcome.method).toBe("execution");
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

describe("verifyFinding — executing the suggested fix, not just checking its syntax", () => {
  it("marks fixVerified 'confirmed' when the same repro re-run with the fix applied passes", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "refuted", reasoning: "n/a" },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "BUGGY", fixedTestCode: "FIXED" },
    });
    const runSandbox = async (_lang: unknown, testCode: string) =>
      testCode === "FIXED" ? { available: true, reproduced: false, output: "" } : { available: true, reproduced: true, output: "AssertionError" };
    const outcome = await verifyFinding(router, candidate({ needsExecution: true, suggestedFix: "return fixed;" }), FILES, runSandbox);
    expect(outcome.status).toBe("verified");
    expect(outcome.fixVerified).toBe("confirmed");
    expect(outcome.verifiedHow).toContain("confirmed to resolve it");
  });

  it("marks fixVerified 'failed' when the same repro re-run with the fix applied still reproduces", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "refuted", reasoning: "n/a" },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "BUGGY", fixedTestCode: "STILL_BUGGY" },
    });
    const runSandbox = async () => ({ available: true, reproduced: true, output: "AssertionError" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true, suggestedFix: "return notActuallyFixed;" }), FILES, runSandbox);
    expect(outcome.status).toBe("verified"); // the original defect is still confirmed real
    expect(outcome.fixVerified).toBe("failed");
    expect(outcome.verifiedHow).toContain("did NOT resolve it");
  });

  it("leaves fixVerified unset when repro-gen produced no fixedTestCode", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "refuted", reasoning: "n/a" },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "BUGGY" },
    });
    const runSandbox = async () => ({ available: true, reproduced: true, output: "" });
    const outcome = await verifyFinding(router, candidate({ needsExecution: true, suggestedFix: "return fixed;" }), FILES, runSandbox);
    expect(outcome.fixVerified).toBeUndefined();
    expect(outcome.verifiedHow).not.toContain("resolve it");
  });

  it("never attempts the fix check when the candidate has no suggestedFix, even if fixedTestCode is somehow present", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "refuted", reasoning: "n/a" },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "BUGGY", fixedTestCode: "FIXED" },
    });
    let sandboxCalls = 0;
    const runSandbox = async (_lang: unknown, testCode: string) => {
      sandboxCalls++;
      return testCode === "FIXED" ? { available: true, reproduced: false, output: "" } : { available: true, reproduced: true, output: "" };
    };
    const outcome = await verifyFinding(router, candidate({ needsExecution: true, suggestedFix: undefined }), FILES, runSandbox);
    expect(sandboxCalls).toBe(1); // only the original repro ran, never the fix
    expect(outcome.fixVerified).toBeUndefined();
  });

  it("never attempts the fix check when the original defect didn't reproduce", async () => {
    const router = createFakeRouter({
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed via file inspection." },
      "verify.repro_gen": { canGenerate: true, language: "node", testCode: "BUGGY", fixedTestCode: "FIXED" },
    });
    let sandboxCalls = 0;
    const runSandbox = async () => {
      sandboxCalls++;
      return { available: true, reproduced: false, output: "" };
    };
    const outcome = await verifyFinding(router, candidate({ needsExecution: true, suggestedFix: "return fixed;", confidence: 0.9 }), FILES, runSandbox);
    expect(sandboxCalls).toBe(1); // the fix check never runs when there's nothing confirmed to fix
    expect(outcome.fixVerified).toBeUndefined();
  });
});
