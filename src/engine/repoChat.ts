import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlatformAdapter } from "../adapters/types.js";
import type { RepoRef } from "../types/domain.js";
import type { LlmRouter } from "../llm/types.js";
import { getContext } from "../indexer/context.js";
import { RepoChatOutputSchema } from "./schemas.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "prompts/repo_chat.v1.md");
let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

/** How many extra lines of surrounding context to show around each matched chunk — a chunk boundary rarely lines up with a whole function, so a little padding usually avoids handing the model a snippet that starts or ends mid-statement. */
const SNIPPET_PADDING = 2;
/** Caps both retrieval breadth and prompt size — this is a single Q&A turn, not a full-repo dump. */
const MAX_SOURCES = 8;

export interface RepoChatSource {
  path: string;
  startLine: number;
  endLine: number;
  similarity: number;
}

export interface RepoChatResult {
  answer: string;
  sources: RepoChatSource[];
  costUsd: number;
}

/**
 * "Ask a question about this whole repo," not just a specific finding — Greptile's core
 * differentiator, built entirely on top of the indexer/embeddings pipeline that already backs
 * cross-file review context (indexer/context.ts's similarChunks). The one real difference from
 * that review-time usage: `engine/contextAssembly.ts`'s buildRepoContextBlock deliberately only
 * ever shows a specialist pass a path:line POINTER for similarChunks (kept lightweight since
 * it runs across 8 parallel passes every single review) — a chat answer needs the model to
 * actually SEE the code it's talking about, or it's far more likely to hallucinate an API that
 * doesn't exist. So this fetches each matched chunk's real content (adapter.getFile, using the
 * chunk's own indexed `sha` — not "current HEAD", which may have moved since the repo was last
 * indexed) and hands the model real, verifiable snippets instead of pointers.
 *
 * Returns `null` only when the LLM call itself is dropped (schema validation failed twice, or
 * every retry of the provider call failed) — never throws. A repo with no indexed matches at
 * all, or where every matched file fails to fetch, still returns a real (non-null) answer that
 * says so plainly, rather than either crashing or silently calling the LLM with zero grounding.
 */
export async function answerRepoChat(
  router: LlmRouter,
  db: SupabaseClient,
  adapter: PlatformAdapter,
  repo: RepoRef,
  repoId: string,
  question: string,
): Promise<RepoChatResult | null> {
  const ctx = await getContext(db, repoId, [], question);
  const candidates = ctx.similarChunks.slice(0, MAX_SOURCES);

  if (candidates.length === 0) {
    return {
      answer:
        "I couldn't find any indexed code related to that question — this repository may not be indexed yet, or try rephrasing with more specific terms (a function, file, or feature name).",
      sources: [],
      costUsd: 0,
    };
  }

  const blocks: string[] = [];
  const sources: RepoChatSource[] = [];
  for (const chunk of candidates) {
    try {
      const content = await adapter.getFile(repo, chunk.path, chunk.sha);
      const lines = content.split("\n");
      const from = Math.max(1, chunk.startLine - SNIPPET_PADDING);
      const to = Math.min(lines.length, chunk.endLine + SNIPPET_PADDING);
      const snippet = lines.slice(from - 1, to).join("\n");
      blocks.push(`### ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n\`\`\`\n${snippet}\n\`\`\``);
      sources.push({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, similarity: chunk.similarity });
    } catch {
      // This one chunk's file couldn't be fetched (deleted since indexed, transient network
      // error) — skip it and keep going with whatever else was retrieved, same "one failure
      // shouldn't cost the whole answer" policy as everywhere else cross-file context is used.
    }
  }

  if (blocks.length === 0) {
    return {
      answer: "I found some potentially related code, but couldn't fetch its current content to answer confidently — please try again.",
      sources: [],
      costUsd: 0,
    };
  }

  const system = await loadPrompt();
  const user = [`## Question`, question, "", `## Retrieved code from this repository`, blocks.join("\n\n")].join("\n");

  const result = await router.complete({
    task: "chat.repo",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schema: RepoChatOutputSchema,
    maxTokens: 1024,
  });
  if (!result.data) return null;

  return { answer: result.data.answer, sources, costUsd: result.costUsd };
}
