import { describe, expect, it } from "vitest";
import { validateSuggestedFix } from "./suggestedFix.js";

describe("validateSuggestedFix", () => {
  it("accepts a concrete, different replacement", () => {
    const result = validateSuggestedFix("if (!session) throw new NotFoundError();", "if (session) return session;");
    expect(result.valid).toBe(true);
  });

  it("rejects an empty suggestion", () => {
    const result = validateSuggestedFix("   ", "for (let i = 0; i <= arr.length; i++)");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it("rejects a suggestion identical to the original (whitespace/case-insensitive)", () => {
    const original = "for (let i = 0; i <= arr.length; i++) {";
    const result = validateSuggestedFix("  FOR (let i = 0;   i <= arr.length; i++) {  ", original);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/identical/i);
  });

  it.each([
    "if (!session) { ... }",
    "// TODO: fix this properly",
    "// rest of the function unchanged",
    "<existing code>",
    "// same as above",
  ])("rejects a placeholder-style suggestion: %s", (fix) => {
    const result = validateSuggestedFix(fix, "if (!session) throw new Error();");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/placeholder/i);
  });

  it("rejects a suggestion wildly larger than the cited range", () => {
    const original = "return x;";
    const bloated = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const result = validateSuggestedFix(bloated, original);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/larger/i);
  });

  it("allows a reasonably larger multi-line fix for a multi-line original", () => {
    const original = "if (x) {\n  doThing();\n}";
    const fix = "if (x) {\n  doThing();\n  logAudit(x);\n}";
    const result = validateSuggestedFix(fix, original);
    expect(result.valid).toBe(true);
  });
});
