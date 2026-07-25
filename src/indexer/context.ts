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

  // `symbols.ilike` names only identifier-safe characters can reach — protects the raw
  // `.or()` filter-string DSL below from a symbol name containing a comma/period/`%` etc.
  const safeNames = changedSymbolNames.filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));

  const { data: symbolRows } = await db
    .from("symbols")
    .select("path, name, kind, signature, start_line, end_line")
    .eq("repo_id", repoId)
    .in("name", changedSymbolNames.length > 0 ? changedSymbolNames : ["__none__"]);

  const rows = (symbolRows ?? []) as Record<string, unknown>[];
  const definitions = rows.filter((r) => !/test/i.test(r["path"] as string)).map(toSymbolContext);
  const relatedTests = rows.filter((r) => /test/i.test(r["path"] as string)).map(toSymbolContext);

  // Best-effort "callers": symbols ANYWHERE in the repo (not just ones sharing a
  // changed name) whose one-line declaration signature references a changed name —
  // e.g. a `class Handler extends BaseHandler`/`implements Foo` clause, or a
  // single-line arrow function whose expression body is a call
  // (`const validate = (x) => checkInput(x)`). indexer/symbols.ts only stores each
  // declaration's FIRST LINE, not its full body, so this can never see a call
  // buried inside a multi-line function — a real call graph needs the import-graph
  // edges in symbols.meta, not yet populated by v1. This MUST be its own query, not
  // a further filter over the name-matched rows above: a genuine caller almost
  // always has a *different* name than the symbol it calls, so pre-filtering to
  // `.in("name", changedSymbolNames)` would exclude it before this check ever runs.
  // A separate try/catch (rather than folding into the query above) so a failure
  // here — e.g. this being run against a client that doesn't support `.or()` — only
  // costs the callers portion, matching how an embedding/RPC failure below only
  // costs similarChunks, never definitions/relatedTests.
  let callers: SymbolContext[] = [];
  if (safeNames.length > 0) {
    try {
      const { data: callerRows } = await db
        .from("symbols")
        .select("path, name, kind, signature, start_line, end_line")
        .eq("repo_id", repoId)
        .or(safeNames.map((n) => `signature.ilike.%${n}%`).join(","))
        .limit(50);
      // A row whose own name is one of the changed names is already surfaced via
      // `definitions` above — exclude it here so the same declaration doesn't also
      // show up as its own "caller".
      callers = ((callerRows ?? []) as Record<string, unknown>[])
        .filter((r) => !safeNames.includes(r["name"] as string))
        .map(toSymbolContext);
    } catch {
      // Leave callers empty — definitions/relatedTests are still valid.
    }
  }

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
