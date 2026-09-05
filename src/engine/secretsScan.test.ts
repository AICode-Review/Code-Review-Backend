import { describe, expect, it } from "vitest";
import { scanForSecrets, SECRET_PATTERNS, type SecretPattern } from "./secretsScan.js";
import { buildPrDiff } from "./diff.js";

function diffAdding(path: string, ...addedLines: string[]): ReturnType<typeof buildPrDiff> {
  const hunk = addedLines.map((l) => `+${l}`).join("\n");
  const diffText = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${addedLines.length} @@\n${hunk}\n`;
  return buildPrDiff({ baseSha: "base", headSha: "head", diffText });
}

describe("scanForSecrets", () => {
  it("flags a hardcoded AWS access key on an added line", () => {
    const prDiff = diffAdding("src/config.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";');
    const found = scanForSecrets(prDiff);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ category: "security", path: "src/config.ts", startLine: 1, severity: "critical" });
    expect(found[0]!.evidence[0]).toBe("AKIAABCDEFGHIJKLMNOP");
  });

  it("flags a GitHub personal access token", () => {
    const prDiff = diffAdding("src/ci.ts", `const token = "ghp_${"a".repeat(36)}";`);
    const found = scanForSecrets(prDiff);
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toContain("GitHub personal access / app token");
  });

  it("flags a private key PEM block", () => {
    const prDiff = diffAdding("id_rsa.txt", "-----BEGIN RSA PRIVATE KEY-----");
    const found = scanForSecrets(prDiff);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("critical");
  });

  it("flags a Stripe live secret key", () => {
    const prDiff = diffAdding("src/billing.ts", `const stripeKey = "sk_live_${"x".repeat(30)}";`);
    const found = scanForSecrets(prDiff);
    expect(found).toHaveLength(1);
  });

  it("does not flag a deleted line — only what this diff introduces", () => {
    const diffText = [
      "diff --git a/src/config.ts b/src/config.ts",
      "index 1111111..2222222 100644",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,1 +1,1 @@",
      '-const key = "AKIAABCDEFGHIJKLMNOP";',
      '+const key = process.env.AWS_KEY;',
      "",
    ].join("\n");
    const prDiff = buildPrDiff({ baseSha: "base", headSha: "head", diffText });
    expect(scanForSecrets(prDiff)).toHaveLength(0);
  });

  it("does not flag an unchanged context line", () => {
    const diffText = [
      "diff --git a/src/config.ts b/src/config.ts",
      "index 1111111..2222222 100644",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,2 +1,3 @@",
      ' const key = "AKIAABCDEFGHIJKLMNOP";',
      "+const other = 1;",
      " const unrelated = true;",
      "",
    ].join("\n");
    const prDiff = buildPrDiff({ baseSha: "base", headSha: "head", diffText });
    expect(scanForSecrets(prDiff)).toHaveLength(0);
  });

  it("does not flag ordinary code with no secret-shaped content", () => {
    const prDiff = diffAdding("src/app.ts", "export function add(a: number, b: number) { return a + b; }");
    expect(scanForSecrets(prDiff)).toHaveLength(0);
  });

  it("skips non-reviewable paths (lockfiles, binaries) even if the pattern would match", () => {
    const prDiff = diffAdding("package-lock.json", '"resolved": "AKIAABCDEFGHIJKLMNOP"');
    expect(scanForSecrets(prDiff)).toHaveLength(0);
  });

  it("reports one candidate per match when multiple secrets appear across files", () => {
    const diffText = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -0,0 +1,1 @@",
      '+const k = "AKIAABCDEFGHIJKLMNOP";',
      "diff --git a/b.ts b/b.ts",
      "index 1111111..2222222 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -0,0 +1,1 @@",
      `+const t = "ghp_${"b".repeat(36)}";`,
      "",
    ].join("\n");
    const prDiff = buildPrDiff({ baseSha: "base", headSha: "head", diffText });
    const found = scanForSecrets(prDiff);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("every candidate satisfies CandidateSchema's shape expectations (non-empty required fields)", () => {
    const prDiff = diffAdding("src/config.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";');
    const [found] = scanForSecrets(prDiff);
    expect(found!.title.length).toBeGreaterThan(0);
    expect(found!.title.length).toBeLessThanOrEqual(120);
    expect(found!.explanation.length).toBeGreaterThan(0);
    expect(found!.fixSteps.length).toBeGreaterThan(0);
    expect(found!.evidence.length).toBeGreaterThan(0);
    expect(found!.confidence).toBeGreaterThan(0);
    expect(found!.confidence).toBeLessThanOrEqual(1);
  });

  it("supports an overridden pattern set for isolated testing without touching the real curated list", () => {
    const custom: SecretPattern[] = [{ id: "test-only", description: "test marker", regex: /TESTSECRET\d+/, severity: "minor" }];
    const prDiff = diffAdding("src/x.ts", "const v = 'TESTSECRET123';");
    expect(scanForSecrets(prDiff)).toHaveLength(0); // real patterns don't match this
    expect(scanForSecrets(prDiff, { patterns: custom })).toHaveLength(1);
  });

  it("has no duplicate pattern ids in the curated list", () => {
    const ids = SECRET_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
