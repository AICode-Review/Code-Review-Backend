import { describe, expect, it } from "vitest";
import { format, formatGithub, formatJson, formatText } from "./formatters.js";
import type { LocalFinding } from "./review.js";

const CRITICAL: LocalFinding = {
  category: "security",
  path: "src/auth.ts",
  startLine: 5,
  endLine: 6,
  title: "SQL injection",
  explanation: "Unsanitized input reaches a query.",
  whyItMatters: "Data exposure.",
  impact: "Critical.",
  fixSteps: ["Use a parameterized query."],
  severity: "critical",
  verificationStatus: "verified",
  verifiedHow: "Cross-examined and upheld.",
};

const MINOR: LocalFinding = { ...CRITICAL, severity: "minor", path: "src/util.ts", title: "Minor nit", category: "style" };

describe("formatText", () => {
  it("reports a clean pass when there are no findings", () => {
    expect(formatText([])).toContain("No verified findings");
  });

  it("lists severity, location, and title for each finding", () => {
    const text = formatText([CRITICAL]);
    expect(text).toContain("[CRITICAL]");
    expect(text).toContain("src/auth.ts:5-6");
    expect(text).toContain("SQL injection");
  });

  it("sorts critical findings before minor ones", () => {
    const text = formatText([MINOR, CRITICAL]);
    expect(text.indexOf("SQL injection")).toBeLessThan(text.indexOf("Minor nit"));
  });
});

describe("formatJson", () => {
  it("round-trips the findings as an array", () => {
    const parsed = JSON.parse(formatJson([CRITICAL]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe("src/auth.ts");
  });
});

describe("formatGithub", () => {
  it("maps severity to the right workflow-command level", () => {
    const out = formatGithub([CRITICAL, MINOR]);
    expect(out).toContain("::error file=src/auth.ts,line=5,endLine=6");
    expect(out).toContain("::notice file=src/util.ts");
  });

  it("strips newlines from the message so the annotation stays on one line", () => {
    const withNewline: LocalFinding = { ...CRITICAL, explanation: "line one\nline two" };
    expect(formatGithub([withNewline])).not.toContain("\n\n");
  });
});

describe("format", () => {
  it("dispatches to the right formatter by name", () => {
    expect(format([CRITICAL], "json").startsWith("[")).toBe(true);
    expect(format([CRITICAL], "text")).toContain("[CRITICAL]");
    expect(format([CRITICAL], "github")).toContain("::error");
  });
});
