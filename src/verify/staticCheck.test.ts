import { describe, expect, it } from "vitest";
import { staticExistenceCheck } from "./staticCheck.js";
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

describe("staticExistenceCheck", () => {
  it("passes when lines exist and evidence text is found in the file", () => {
    const result = staticExistenceCheck(candidate(), FILES);
    expect(result.passed).toBe(true);
  });

  it("fails when the cited file was never fetched", () => {
    const result = staticExistenceCheck(candidate({ path: "src/nope.ts" }), FILES);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/not among the files fetched/);
  });

  it("fails when cited lines exceed the file's length", () => {
    const result = staticExistenceCheck(candidate({ startLine: 99, endLine: 99 }), FILES);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/beyond the file's/);
  });

  it("fails when startLine is after endLine", () => {
    const result = staticExistenceCheck(candidate({ startLine: 5, endLine: 2 }), FILES);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/after endLine/);
  });

  it("fails when none of the evidence text appears in the file (hallucination)", () => {
    const result = staticExistenceCheck(candidate({ evidence: ["this code does not exist anywhere"] }), FILES);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/hallucinated/);
  });

  it("is whitespace/case insensitive when matching evidence", () => {
    const result = staticExistenceCheck(candidate({ evidence: ["  CONST   X = 1;  "] }), FILES);
    expect(result.passed).toBe(true);
  });

  it("fails when evidence is too short/vague to be meaningful, even if it technically appears in the file", () => {
    // "x =" appears literally inside "const x = 1;" but is not specific enough to prove anything.
    const result = staticExistenceCheck(candidate({ evidence: ["x ="] }), FILES);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/specific enough/);
  });

  it("accepts a second evidence entry even when the first is too short", () => {
    const result = staticExistenceCheck(candidate({ evidence: ["x =", "const x = 1;"] }), FILES);
    expect(result.passed).toBe(true);
  });
});
