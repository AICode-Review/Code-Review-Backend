import { describe, expect, it } from "vitest";
import {
  collectPreFixTouchedRanges,
  guessCategory,
  guessLanguage,
  guessSeverity,
  parseFixCommits,
  tallyBlameShas,
} from "./mine.js";

describe("parseFixCommits", () => {
  const US = "\x1f";

  it("extracts fix/closes/resolves references with their issue number", () => {
    const log = [
      `aaa1${US}parent1${US}Fix #42: null check in parser`,
      `bbb2${US}parent2${US}Closes #7 — race condition on shutdown`,
      `ccc3${US}parent3${US}resolved #100`,
      `ddd4${US}parent4${US}Just a regular refactor commit`,
    ].join("\n");

    const result = parseFixCommits(log);
    expect(result).toEqual([
      { sha: "aaa1", parentSha: "parent1", subject: "Fix #42: null check in parser", issueNumber: "42" },
      { sha: "bbb2", parentSha: "parent2", subject: "Closes #7 — race condition on shutdown", issueNumber: "7" },
      { sha: "ccc3", parentSha: "parent3", subject: "resolved #100", issueNumber: "100" },
    ]);
  });

  it("skips root commits (no parent to diff/blame against)", () => {
    const log = `aaa1${US}${US}Fixes #1 initial import`;
    expect(parseFixCommits(log)).toEqual([]);
  });

  it("keeps only the first parent of a merge-ish log line", () => {
    const log = `aaa1${US}parent1 parent2${US}Fixes #3`;
    expect(parseFixCommits(log)[0]?.parentSha).toBe("parent1");
  });

  it("ignores blank lines", () => {
    const log = `\n\naaa1${US}p1${US}Fixes #5\n\n`;
    expect(parseFixCommits(log)).toHaveLength(1);
  });
});

describe("guessCategory", () => {
  it.each([
    ["Fix XSS in comment renderer", "security"],
    ["Fixes #9: SQL injection via search field", "security"],
    ["Fix race condition in worker pool", "concurrency"],
    ["Fixes breaking API signature change", "contracts"],
    ["Fix unhandled exception on empty response", "errors"],
    ["Fix flaky test assertion", "tests"],
    ["Fix lint whitespace issue", "style"],
    ["Fix incorrect total calculation", "logic"],
  ] as const)("classifies %j as %s", (message, expected) => {
    expect(guessCategory(message)).toBe(expected);
  });
});

describe("guessSeverity", () => {
  it("flags security/crash/data-loss language as critical", () => {
    expect(guessSeverity("Fix critical security vulnerability in auth")).toBe("critical");
    expect(guessSeverity("Fix crash on startup")).toBe("critical");
  });

  it("flags cosmetic language as minor", () => {
    expect(guessSeverity("Fix typo in error message")).toBe("minor");
  });

  it("defaults to major otherwise", () => {
    expect(guessSeverity("Fix off-by-one in pagination")).toBe("major");
  });
});

describe("guessLanguage", () => {
  it("picks the language of the first recognized extension", () => {
    expect(guessLanguage(["src/index.ts", "README.md"])).toBe("typescript");
    expect(guessLanguage(["lib/util.py"])).toBe("python");
  });

  it("falls back to unknown for unrecognized extensions", () => {
    expect(guessLanguage(["Dockerfile", "Makefile"])).toBe("unknown");
  });
});

describe("collectPreFixTouchedRanges", () => {
  it("finds the old-side line range touched per file", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -10,3 +10,3 @@
 context
-bad line
+good line
 context
`;
    const ranges = collectPreFixTouchedRanges(diff);
    expect(ranges.get("src/x.ts")).toEqual([11, 11]);
  });

  it("spans multiple deleted lines into one min/max range", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -5,4 +5,2 @@
 context
-removed one
-removed two
 context
`;
    expect(collectPreFixTouchedRanges(diff).get("src/x.ts")).toEqual([6, 7]);
  });

  it("omits a file with no deleted lines (pure addition)", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,2 @@
 context
+added line
`;
    expect(collectPreFixTouchedRanges(diff).size).toBe(0);
  });
});

describe("tallyBlameShas", () => {
  it("counts one occurrence per porcelain header line", () => {
    const porcelain = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 10 10 1",
      "author Someone",
      "\tsome content",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 11 11 1",
      "author Someone Else",
      "\tother content",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12 12 1",
      "author Someone",
      "\tmore content",
    ].join("\n");

    const tally = tallyBlameShas(porcelain);
    expect(tally.get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(2);
    expect(tally.get("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(1);
  });

  it("never mistakes a content line for a header", () => {
    const porcelain = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1\nauthor x\n\tconst sha = 'looks like a header but is content';";
    expect(tallyBlameShas(porcelain).size).toBe(1);
  });
});
