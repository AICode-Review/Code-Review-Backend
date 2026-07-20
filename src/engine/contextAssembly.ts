import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlatformAdapter } from "../adapters/types.js";
import type { PrRef } from "../types/domain.js";
import { getContext, type RepoContext } from "../indexer/context.js";
import { buildPrDiff, type PrDiff } from "./diff.js";
import { isReviewableSourcePath } from "./binaryFiles.js";
import { extractChangedSymbols } from "./changedSymbols.js";

export interface ChangedFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface ReviewContext {
  prDiff: PrDiff;
  files: ChangedFile[];
  /** null when no index is available yet, the indexer query itself failed, or it timed out — never blocks the review. */
  repoContext: RepoContext | null;
  repoContextTimedOut: boolean;
}

const MAX_FILES = 25;
const MAX_FILE_CHARS = 20_000; // roughly caps per-file prompt size
const REPO_CONTEXT_TIMEOUT_MS = 60_000; // DESIGN.md §7: never block a review >60s waiting for the index

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

/**
 * DESIGN.md §6.2: diff + full head content of every changed file, plus
 * (when an indexed repo is available) cross-file context — definitions,
 * likely callers, related tests, and embedding-similar chunks for the
 * changed symbols. `index` is omitted for repos that haven't been indexed
 * yet or platforms where repoId isn't known; the review still runs fine
 * without it, just without the cross-file signal.
 */
export async function assembleContext(
  adapter: PlatformAdapter,
  pr: PrRef,
  baseSha: string,
  headSha: string,
  index?: { db: SupabaseClient; repoId: string },
): Promise<ReviewContext> {
  const diffText = await adapter.getDiff(pr);
  const prDiff = buildPrDiff({ baseSha, headSha, diffText });

  // Binary/generated files still show up in prDiff (accurate "N files changed" stats,
  // visible in the diff viewer) — they're just never fetched for the specialist
  // passes to read, since base64-decoding real binary content produces garbage
  // "text" that risks hallucinated findings rather than a genuine language gap.
  const changedPaths = prDiff.files
    .filter((f) => f.path !== "(deleted)" && isReviewableSourcePath(f.path))
    .map((f) => f.path)
    .slice(0, MAX_FILES);

  const files: ChangedFile[] = [];
  for (const path of changedPaths) {
    try {
      const content = await adapter.getFile(pr.repo, path, headSha);
      const truncated = content.length > MAX_FILE_CHARS;
      files.push({
        path,
        content: truncated ? `${content.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : content,
        truncated,
      });
    } catch {
      // Binary file, or renamed/removed between diff fetch and file fetch — skip it.
    }
  }

  let repoContext: RepoContext | null = null;
  let repoContextTimedOut = false;
  if (index) {
    try {
      const { names, similarityQueryText } = await extractChangedSymbols(prDiff, files);
      const result = await withTimeout(getContext(index.db, index.repoId, names, similarityQueryText), REPO_CONTEXT_TIMEOUT_MS);
      if (result === "timeout") {
        repoContextTimedOut = true;
      } else {
        repoContext = result;
      }
    } catch {
      // Repo never indexed, index query failed, embedding call failed, etc. — proceed
      // without cross-file context rather than fail the whole review over it.
    }
  }

  return { prDiff, files, repoContext, repoContextTimedOut };
}

export function prDiffToPromptText(prDiff: PrDiff): string {
  return prDiff.files
    .map((f) => {
      const lines = f.lines
        .map((l) => {
          const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
          const lineNo = l.newNo ?? l.oldNo ?? "";
          return `${marker}${lineNo}: ${l.text}`;
        })
        .join("\n");
      return `### DIFF: ${f.path} (+${f.additions}/-${f.deletions})\n${lines}`;
    })
    .join("\n\n");
}
