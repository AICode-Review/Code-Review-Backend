import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("./embeddings.js", () => ({
  embedTexts: vi.fn(async () => {
    throw new Error("embedding provider unavailable");
  }),
}));

const { getContext } = await import("./context.js");

function fakeDb(symbolRows: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: async () => ({ data: symbolRows, error: null }),
        }),
      }),
    }),
    rpc: async () => ({ data: [], error: null }),
  } as unknown as SupabaseClient;
}

describe("getContext", () => {
  it("returns all-empty immediately when there are no changed symbol names and no similarity text", async () => {
    const result = await getContext(fakeDb([]), "repo-1", []);
    expect(result).toEqual({ definitions: [], callers: [], relatedTests: [], similarChunks: [] });
  });

  it("splits matched symbol rows into definitions, callers (signature mentions a changed name), and related tests (path heuristic)", async () => {
    const rows = [
      { path: "src/auth.ts", name: "authenticate", kind: "function", signature: "function authenticate(token)", start_line: 10, end_line: 20 },
      { path: "src/handler.ts", name: "handleLogin", kind: "function", signature: "calls authenticate(req.token)", start_line: 5, end_line: 15 },
      { path: "src/auth.test.ts", name: "authenticate test", kind: "function", signature: null, start_line: 1, end_line: 8 },
    ];
    const result = await getContext(fakeDb(rows), "repo-1", ["authenticate"]);
    expect(result.definitions.map((d) => d.name)).toContain("authenticate");
    expect(result.callers.map((c) => c.name)).toContain("handleLogin");
    expect(result.relatedTests).toHaveLength(1);
    expect(result.relatedTests[0]?.path).toBe("src/auth.test.ts");
  });

  it("keeps definitions/callers/relatedTests even when the embedding/similarity lookup fails", async () => {
    const rows = [{ path: "src/auth.ts", name: "authenticate", kind: "function", signature: null, start_line: 1, end_line: 5 }];
    const result = await getContext(fakeDb(rows), "repo-1", ["authenticate"], "some added code referencing authenticate()");
    expect(result.definitions).toHaveLength(1);
    expect(result.similarChunks).toEqual([]);
  });
});
