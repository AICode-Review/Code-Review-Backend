import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../adapters/types.js";

// The diff fixtures below always produce a non-empty similarity query text, which would
// otherwise make a real OpenAI embeddings call (this repo's .env has a real key loaded via
// config.ts's `import "dotenv/config"`). Mock it so these stay fast, offline unit tests.
vi.mock("../indexer/embeddings.js", () => ({
  embedTexts: vi.fn(async () => ({ vectors: [], costUsd: 0 })),
}));

const { assembleContext } = await import("./contextAssembly.js");

const DIFF_TEXT = `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
 export function untouched() {}
+export function authenticate(token: string) {
+}
`;

const FILE_CONTENT = "export function untouched() {}\nexport function authenticate(token: string) {\n}\n";

function fakeAdapter(): PlatformAdapter {
  return {
    getDiff: async () => DIFF_TEXT,
    getFile: async () => FILE_CONTENT,
  } as unknown as PlatformAdapter;
}

const PR_REF = { repo: { platform: "github", externalId: "1", owner: "acme", name: "widgets" }, number: 1 } as never;

describe("assembleContext", () => {
  it("leaves repoContext null when no index is supplied", async () => {
    const ctx = await assembleContext(fakeAdapter(), PR_REF, "base", "head");
    expect(ctx.repoContext).toBeNull();
    expect(ctx.repoContextTimedOut).toBe(false);
    expect(ctx.files).toHaveLength(1);
  });

  it("populates repoContext from the indexer when a matching symbol exists", async () => {
    const fakeDb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: async () => ({
              data: [{ path: "src/other.ts", name: "authenticate", kind: "function", signature: null, start_line: 1, end_line: 3 }],
              error: null,
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: [], error: null }),
    } as unknown as SupabaseClient;

    const ctx = await assembleContext(fakeAdapter(), PR_REF, "base", "head", { db: fakeDb, repoId: "repo-1" });
    expect(ctx.repoContext?.definitions.map((d) => d.name)).toContain("authenticate");
    expect(ctx.repoContextTimedOut).toBe(false);
  });

  it("never fails the review when the indexer query throws", async () => {
    const throwingDb = {
      from: () => {
        throw new Error("db unreachable");
      },
    } as unknown as SupabaseClient;

    const ctx = await assembleContext(fakeAdapter(), PR_REF, "base", "head", { db: throwingDb, repoId: "repo-1" });
    expect(ctx.repoContext).toBeNull();
    expect(ctx.files).toHaveLength(1); // diff/file fetch still succeeded
  });
});
