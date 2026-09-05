import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../adapters/types.js";
import type { RepoRef } from "../types/domain.js";
import type { CompleteRequest, LlmRouter } from "../llm/types.js";

vi.mock("../indexer/embeddings.js", () => ({
  embedTexts: vi.fn(async () => ({ vectors: [[0.1, 0.2, 0.3]], costUsd: 0.0001 })),
}));

const { answerRepoChat } = await import("./repoChat.js");

const REPO: RepoRef = {
  platform: "github",
  externalId: "1",
  owner: "acme",
  name: "widgets",
  orgExternalId: "9",
  orgName: "acme",
};

function fakeDb(chunkRows: Record<string, unknown>[]): SupabaseClient {
  return {
    from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) }),
    rpc: async () => ({ data: chunkRows, error: null }),
  } as unknown as SupabaseClient;
}

function fakeAdapter(files: Record<string, string>): PlatformAdapter {
  return {
    getFile: async (_repo: RepoRef, path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`no fixture for ${path}`);
      return content;
    },
  } as unknown as PlatformAdapter;
}

/** Captures every request the module under test sends, unlike llm/fakeRouter.ts which only keys off req.task — this test needs to inspect req.messages to prove the retrieved code actually reached the prompt. */
function capturingRouter(answer: string | null): { router: LlmRouter; calls: CompleteRequest<unknown>[] } {
  const calls: CompleteRequest<unknown>[] = [];
  const router: LlmRouter = {
    async complete(req) {
      calls.push(req as CompleteRequest<unknown>);
      const parsed = answer === null ? { success: false as const } : req.schema.safeParse({ answer });
      return {
        data: parsed.success ? parsed.data : null,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.0025,
        model: "fake-model",
        provider: "anthropic",
      };
    },
  };
  return { router, calls };
}

const AUTH_FILE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

describe("answerRepoChat", () => {
  it("returns a canned 'not indexed' answer at zero cost when no chunks match, without calling the LLM", async () => {
    const { router, calls } = capturingRouter("should never be reached");
    const result = await answerRepoChat(router, fakeDb([]), fakeAdapter({}), REPO, "repo-1", "how does auth work?");
    expect(result).toEqual({ answer: expect.stringMatching(/couldn't find any indexed code/), sources: [], costUsd: 0 });
    expect(calls).toHaveLength(0);
  });

  it("fetches each matched chunk's real content and includes it in the prompt sent to the LLM", async () => {
    const { router, calls } = capturingRouter("Auth is checked in verifyUser.");
    const chunkRows = [{ path: "src/auth.ts", start_line: 10, end_line: 12, sha: "sha-1", similarity: 0.91 }];
    const result = await answerRepoChat(router, fakeDb(chunkRows), fakeAdapter({ "src/auth.ts": AUTH_FILE }), REPO, "repo-1", "how does auth work?");

    expect(result?.answer).toBe("Auth is checked in verifyUser.");
    expect(result?.sources).toEqual([{ path: "src/auth.ts", startLine: 10, endLine: 12, similarity: 0.91 }]);
    expect(result?.costUsd).toBe(0.0025);

    expect(calls).toHaveLength(1);
    const userMessage = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("how does auth work?");
    expect(userMessage).toContain("src/auth.ts:10-12");
    expect(userMessage).toContain("line 8"); // padding pulls in a couple of lines before/after the cited range
    expect(userMessage).toContain("line 14");
  });

  it("skips a chunk whose file fetch fails but still answers using the others", async () => {
    const { router } = capturingRouter("Answer built from the one file that worked.");
    const chunkRows = [
      { path: "src/deleted.ts", start_line: 1, end_line: 3, sha: "sha-gone", similarity: 0.95 },
      { path: "src/auth.ts", start_line: 10, end_line: 12, sha: "sha-1", similarity: 0.8 },
    ];
    const result = await answerRepoChat(router, fakeDb(chunkRows), fakeAdapter({ "src/auth.ts": AUTH_FILE }), REPO, "repo-1", "how does auth work?");
    expect(result?.answer).toBe("Answer built from the one file that worked.");
    expect(result?.sources).toEqual([{ path: "src/auth.ts", startLine: 10, endLine: 12, similarity: 0.8 }]);
  });

  it("returns a canned 'couldn't fetch content' answer when every matched file's fetch fails", async () => {
    const { router, calls } = capturingRouter("should never be reached");
    const chunkRows = [{ path: "src/gone.ts", start_line: 1, end_line: 3, sha: "sha-gone", similarity: 0.9 }];
    const result = await answerRepoChat(router, fakeDb(chunkRows), fakeAdapter({}), REPO, "repo-1", "how does auth work?");
    expect(result).toEqual({ answer: expect.stringMatching(/couldn't fetch its current content/), sources: [], costUsd: 0 });
    expect(calls).toHaveLength(0);
  });

  it("returns null (never throws) when the LLM call is dropped", async () => {
    const { router } = capturingRouter(null);
    const chunkRows = [{ path: "src/auth.ts", start_line: 10, end_line: 12, sha: "sha-1", similarity: 0.8 }];
    const result = await answerRepoChat(router, fakeDb(chunkRows), fakeAdapter({ "src/auth.ts": AUTH_FILE }), REPO, "repo-1", "how does auth work?");
    expect(result).toBeNull();
  });

  it("caps retrieval at 8 sources even when more chunks match", async () => {
    const { router, calls } = capturingRouter("ok");
    const chunkRows = Array.from({ length: 12 }, (_, i) => ({
      path: `src/file${i}.ts`,
      start_line: 1,
      end_line: 2,
      sha: `sha-${i}`,
      similarity: 1 - i * 0.01,
    }));
    const files = Object.fromEntries(chunkRows.map((r) => [r.path, "a\nb\nc"]));
    const result = await answerRepoChat(router, fakeDb(chunkRows), fakeAdapter(files), REPO, "repo-1", "anything?");
    expect(result?.sources).toHaveLength(8);
    expect(calls).toHaveLength(1);
  });
});
