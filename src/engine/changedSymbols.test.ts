import { describe, expect, it } from "vitest";
import { buildPrDiff } from "./diff.js";
import { extractChangedSymbols } from "./changedSymbols.js";

const DIFF_TEXT = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..89abcde 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,6 @@
 export function untouched() {
   return 1;
 }
+export function authenticate(token: string) {
+  return token.trim();
+}
`;

describe("extractChangedSymbols", () => {
  it("only names symbols whose line range overlaps an added line", async () => {
    const prDiff = buildPrDiff({ baseSha: "a", headSha: "b", diffText: DIFF_TEXT });
    const files = [
      {
        path: "src/auth.ts",
        content: "export function untouched() {\n  return 1;\n}\nexport function authenticate(token: string) {\n  return token.trim();\n}\n",
        truncated: false,
      },
    ];
    const result = await extractChangedSymbols(prDiff, files);
    expect(result.names).toContain("authenticate");
    expect(result.names).not.toContain("untouched");
  });

  it("builds a similarity query text from the added lines", async () => {
    const prDiff = buildPrDiff({ baseSha: "a", headSha: "b", diffText: DIFF_TEXT });
    const files = [{ path: "src/auth.ts", content: "export function authenticate(token: string) {}\n", truncated: false }];
    const result = await extractChangedSymbols(prDiff, files);
    expect(result.similarityQueryText).toContain("authenticate");
  });

  it("returns no names and no similarity text for a diff with only deletions", async () => {
    const deletionOnly = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export function bye() {}
-const unused = 1;
`;
    const prDiff = buildPrDiff({ baseSha: "a", headSha: "b", diffText: deletionOnly });
    const result = await extractChangedSymbols(prDiff, []);
    expect(result.names).toEqual([]);
    expect(result.similarityQueryText).toBeUndefined();
  });

  it("caps the number of symbol names returned", async () => {
    const manyFns = Array.from({ length: 30 }, (_, i) => `+export function fn${i}() {}`).join("\n");
    const diffText = `diff --git a/src/many.ts b/src/many.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/many.ts
@@ -0,0 +1,30 @@
${manyFns}
`;
    const prDiff = buildPrDiff({ baseSha: "a", headSha: "b", diffText });
    const content = Array.from({ length: 30 }, (_, i) => `export function fn${i}() {}`).join("\n") + "\n";
    const result = await extractChangedSymbols(prDiff, [{ path: "src/many.ts", content, truncated: false }]);
    expect(result.names.length).toBeLessThanOrEqual(20);
  });
});
