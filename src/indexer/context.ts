import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts } from "./embeddings.js";

export interface SymbolContext {
  path: string;
  name: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
}

export interface SimilarChunk {
  path: string;
  startLine: number;
  endLine: number;
  similarity: number;
}

export interface RepoContext {
  definitions: SymbolContext[];
  callers: SymbolContext[];
  relatedTests: SymbolContext[];
  similarChunks: SimilarChunk[];
}

function toSymbolContext(row: Record<string, unknown>): SymbolContext {
  return {
    path: row["path"] as string,
    name: row["name"] as string,
    kind: row["kind"] as string,
    signature: (row["signature"] as string | null) ?? null,
    startLine: row["start_line"] as number,
    endLine: row["end_line"] as number,
  };
}

/**
 * DESIGN.md §7 query API: for a set of changed symbol names, find their
 * definitions elsewhere in the repo, likely callers (best-effort — same
 * name referenced in a different file), and related tests (path heuristic),
 * plus embedding-similar chunks for one representative snippet of changed
 * code. Wired into the review pipeline via engine/contextAssembly.ts, which
 * enforces the 60s timeout (DESIGN.md §7) and treats any failure here as
 * "proceed without cross-file context," never a review-blocking error.
 */
export async function getContext(
  db: SupabaseClient,
  repoId: string,
  changedSymbolNames: string[],
  similarityQueryText?: string,
): Promise<RepoContext> {
  if (changedSymbolNames.length === 0 && !similarityQueryText) {
    return { definitions: [], callers: [], relatedTests: [], similarChunks: [] };
  }

  const { data: symbolRows } = await db
    .from("symbols")
    .select("path, name, kind, signature, start_line, end_line")
    .eq("repo_id", repoId)
    .in("name", changedSymbolNames.length > 0 ? changedSymbolNames : ["__none__"]);

  const rows = (symbolRows ?? []) as Record<string, unknown>[];
  const definitions = rows.filter((r) => !/test/i.test(r["path"] as string)).map(toSymbolContext);
  const relatedTests = rows.filter((r) => /test/i.test(r["path"] as string)).map(toSymbolContext);
  // Best-effort "callers": any symbol row whose signature text mentions one of the changed names
  // (a real call-graph needs the import-graph edges in symbols.meta, not yet populated by v1).
  const callers = rows.filter((r) => {
    const sig = (r["signature"] as string | null) ?? "";
    return changedSymbolNames.some((name) => sig.includes(name) && r["name"] !== name);
  }).map(toSymbolContext);

  // Symbol-based results above come from a separate, already-succeeded query — an
  // embedding/RPC failure here (e.g. no OpenAI key, transient API error) should only
  // cost the similarity portion, not discard definitions/callers/relatedTests too.
  let similarChunks: SimilarChunk[] = [];
  if (similarityQueryText) {
    try {
      const { vectors } = await embedTexts([similarityQueryText]);
      const queryEmbedding = vectors[0];
      if (queryEmbedding) {
        const { data: matchRows, error } = await db.rpc("match_chunks", {
          p_repo_id: repoId,
          p_query_embedding: queryEmbedding,
          p_match_count: 12,
        });
        if (!error) {
          similarChunks = ((matchRows ?? []) as Record<string, unknown>[]).map((r) => ({
            path: r["path"] as string,
            startLine: r["start_line"] as number,
            endLine: r["end_line"] as number,
            similarity: r["similarity"] as number,
          }));
        }
      }
    } catch {
      // Leave similarChunks empty — definitions/callers/relatedTests are still valid.
    }
  }

  return { definitions, callers, relatedTests, similarChunks };
}
