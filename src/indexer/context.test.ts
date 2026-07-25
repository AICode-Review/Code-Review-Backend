import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("./embeddings.js", () => ({
  embedTexts: vi.fn(async () => {
    throw new Error("embedding provider unavailable");
  }),
}));

const { getContext } = await import("./context.js");

/**
 * Realistic enough to actually filter, unlike a mock that echoes back every row
 * regardless of the query — that previously masked a real bug where the "callers"
 * heuristic could never fire in production (see the "actually finds a caller with a
 * different name" test below).
 */
function fakeDb(symbolRows: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: async (_col: string, names: string[]) => ({
            data: symbolRows.filter((r) => names.includes(r["name"] as string)),
            error: null,
          }),
          or: (filter: string) => ({
            limit: async () => {
              const needles = filter
                .split(",")
                .map((seg) => /%(.*)%/.exec(seg)?.[1]?.toLowerCase())
                .filter((n): n is string => Boolean(n));
              const data = symbolRows.filter((r) => {
                const sig = ((r["signature"] as string | null) ?? "").toLowerCase();
                return needles.some((n) => sig.includes(n));
              });
              return { data, error: null };
            },
          }),
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

  it("finds a caller with a DIFFERENT name whose one-line signature references the changed symbol", async () => {
    const rows = [
      { path: "src/auth.ts", name: "authenticate", kind: "function", signature: "function authenticate(token)", start_line: 10, end_line: 20 },
      { path: "src/handler.ts", name: "handleLogin", kind: "function", signature: "const handleLogin = (req) => authenticate(req.token)", start_line: 5, end_line: 15 },
      { path: "src/unrelated.ts", name: "sendEmail", kind: "function", signature: "function sendEmail(to)", start_line: 1, end_line: 3 },
      { path: "src/auth.test.ts", name: "authenticate", kind: "function", signature: null, start_line: 1, end_line: 8 },
    ];
    const result = await getContext(fakeDb(rows), "repo-1", ["authenticate"]);
    expect(result.definitions.map((d) => d.name)).toEqual(["authenticate"]);
    expect(result.callers.map((c) => c.name)).toEqual(["handleLogin"]);
    expect(result.relatedTests).toHaveLength(1);
    expect(result.relatedTests[0]?.path).toBe("src/auth.test.ts");
  });

  it("finds a related test with a DIFFERENT name whose signature calls the changed symbol (not just a same-named declaration)", async () => {
    const rows = [
      { path: "src/auth.ts", name: "authenticate", kind: "function", signature: "function authenticate(token)", start_line: 10, end_line: 20 },
      {
        path: "src/auth.test.ts",
        name: "shouldRejectExpiredToken",
        kind: "function",
        signature: "const shouldRejectExpiredToken = () => authenticate(expiredToken)",
        start_line: 1,
        end_line: 3,
      },
    ];
    const result = await getContext(fakeDb(rows), "repo-1", ["authenticate"]);
    expect(result.relatedTests.map((t) => t.name)).toEqual(["shouldRejectExpiredToken"]);
    expect(result.callers).toEqual([]); // it's in a test path, so it belongs in relatedTests, not callers
  });

  it("detects a .spec.ts test file, not just .test.ts (broadened path check)", async () => {
    const rows = [{ path: "src/auth.spec.ts", name: "authenticate", kind: "function", signature: null, start_line: 1, end_line: 3 }];
    const result = await getContext(fakeDb(rows), "repo-1", ["authenticate"]);
    expect(result.relatedTests).toHaveLength(1);
    expect(result.definitions).toEqual([]);
  });

  it("does not surface a changed symbol's own definition as its own caller", async () => {
    const rows = [{ path: "src/auth.ts", name: "authenticate", kind: "function", signature: "function authenticate(token)", start_line: 10, end_line: 20 }];
    const result = await getContext(fakeDb(rows), "repo-1", ["authenticate"]);
    expect(result.callers).toEqual([]);
  });

  it("keeps definitions/callers/relatedTests even when the embedding/similarity lookup fails", async () => {
    const rows = [{ path: "src/auth.ts", name: "authenticate", kind: "function", signature: null, start_line: 1, end_line: 5 }];
    const result = await getContext(fakeDb(rows), "repo-1", ["authenticate"], "some added code referencing authenticate()");
    expect(result.definitions).toHaveLength(1);
    expect(result.similarChunks).toEqual([]);
  });
});
