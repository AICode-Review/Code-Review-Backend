import { describe, expect, it } from "vitest";
import { buildPrDiff, parseUnifiedDiff } from "./diff.js";

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..89abcde 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,7 +10,8 @@ export function authenticate(token: string) {
   if (!token) {
     throw new Error("missing token");
   }
-  const user = lookupUser(token);
+  const user = lookupUser(token.trim());
+  logAccess(user);
   return user;
 }

diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,2 @@
+export const FOO = 1;
+export const BAR = 2;
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const GONE = true;
-// bye
`;

describe("parseUnifiedDiff", () => {
  it("parses a modified file with correct line numbers and kinds", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const auth = files.find((f) => f.path === "src/auth.ts");
    expect(auth).toBeDefined();
    expect(auth?.additions).toBe(2);
    expect(auth?.deletions).toBe(1);

    const del = auth?.lines.find((l) => l.kind === "del");
    expect(del).toMatchObject({ kind: "del", oldNo: 13, newNo: null, text: "  const user = lookupUser(token);" });

    const adds = auth?.lines.filter((l) => l.kind === "add") ?? [];
    expect(adds).toHaveLength(2);
    expect(adds[0]).toMatchObject({ kind: "add", oldNo: null, newNo: 13 });
    expect(adds[1]).toMatchObject({ kind: "add", oldNo: null, newNo: 14 });

    const context = auth?.lines.filter((l) => l.kind === "context") ?? [];
    expect(context.length).toBeGreaterThan(0);
    expect(context[0]).toMatchObject({ kind: "context", oldNo: 10, newNo: 10 });
  });

  it("handles a new file (no old line numbers)", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const created = files.find((f) => f.path === "src/new-file.ts");
    expect(created?.additions).toBe(2);
    expect(created?.deletions).toBe(0);
    expect(created?.lines.every((l) => l.oldNo === null)).toBe(true);
  });

  it("handles a deleted file (no new line numbers, path from --- since +++ is /dev/null)", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const removed = files.find((f) => f.path === "(deleted)");
    expect(removed?.deletions).toBe(2);
    expect(removed?.additions).toBe(0);
    expect(removed?.lines.every((l) => l.newNo === null)).toBe(true);
  });

  it("returns an empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("buildPrDiff", () => {
  it("aggregates stats and applies default labels", () => {
    const diff = buildPrDiff({ baseSha: "aaaaaaaaaaaa", headSha: "bbbbbbbbbbbb", diffText: SAMPLE_DIFF });
    expect(diff.stats.files).toBe(3);
    expect(diff.stats.additions).toBe(4);
    expect(diff.stats.deletions).toBe(3);
    expect(diff.baseLabel).toContain("aaaaaaa");
    expect(diff.headLabel).toContain("bbbbbbb");
  });

  it("honors explicit labels", () => {
    const diff = buildPrDiff({
      baseSha: "a",
      headSha: "b",
      baseLabel: "main",
      headLabel: "feature",
      diffText: "",
    });
    expect(diff.baseLabel).toBe("main");
    expect(diff.headLabel).toBe("feature");
    expect(diff.files).toEqual([]);
  });
});
