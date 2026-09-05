import { describe, expect, it } from "vitest";
import { extractCodeSnippet } from "./snippet.js";
import { planFixApplication } from "./applyFix.js";

const FILE = ["function add(a, b) {", "  return a - b; // bug", "}", "", "module.exports = { add };"].join("\n");

describe("planFixApplication", () => {
  it("splices the suggested fix into the exact cited range when the snippet still matches", () => {
    const expectedSnippet = extractCodeSnippet(FILE, 2, 2, 1)!;
    const plan = planFixApplication(FILE, 2, 2, expectedSnippet, "  return a + b;");
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.newContent).toBe(
        ["function add(a, b) {", "  return a + b;", "}", "", "module.exports = { add };"].join("\n"),
      );
    }
  });

  it("replaces a multi-line range with a differently-sized suggested fix", () => {
    const multiline = ["if (x) {", "  doA();", "  doB();", "}", "done();"].join("\n");
    const expectedSnippet = extractCodeSnippet(multiline, 1, 4, 1)!;
    const plan = planFixApplication(multiline, 1, 4, expectedSnippet, "if (x) {\n  doSafe();\n}");
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.newContent).toBe(["if (x) {", "  doSafe();", "}", "done();"].join("\n"));
    }
  });

  it("rejects when the file content has drifted since the finding was posted", () => {
    const staleExpected = "  return a - b; // an older version of this line";
    const plan = planFixApplication(FILE, 2, 2, staleExpected, "  return a + b;");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/changed since this finding was posted/);
  });

  it("rejects when the cited line range no longer exists in the current (shorter) file", () => {
    const shorterFile = "only one line now";
    const plan = planFixApplication(shorterFile, 2, 2, "  return a - b; // bug", "  return a + b;");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/no longer exists/);
  });

  it("handles a fix at the very first line of the file", () => {
    const expectedSnippet = extractCodeSnippet(FILE, 1, 1, 1)!;
    const plan = planFixApplication(FILE, 1, 1, expectedSnippet, "function add(a, b) {\n  // annotated");
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.newContent.startsWith("function add(a, b) {\n  // annotated\n  return a - b;")).toBe(true);
  });

  it("handles a fix at the very last line of the file", () => {
    const expectedSnippet = extractCodeSnippet(FILE, 5, 5, 1)!;
    const plan = planFixApplication(FILE, 5, 5, expectedSnippet, "module.exports = { add, subtract };");
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.newContent.endsWith("module.exports = { add, subtract };")).toBe(true);
  });

  it("leaves every line outside the cited range byte-for-byte untouched", () => {
    const expectedSnippet = extractCodeSnippet(FILE, 2, 2, 1)!;
    const plan = planFixApplication(FILE, 2, 2, expectedSnippet, "  return a + b;");
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const newLines = plan.newContent.split("\n");
      expect(newLines[0]).toBe("function add(a, b) {");
      expect(newLines[2]).toBe("}");
      expect(newLines[3]).toBe("");
      expect(newLines[4]).toBe("module.exports = { add };");
    }
  });
});
