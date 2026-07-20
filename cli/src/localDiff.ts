import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPrDiff, type PrDiff } from "../../src/engine/diff.js";
import { isReviewableSourcePath } from "../../src/engine/binaryFiles.js";

const MAX_FILE_CHARS = 20_000;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export interface LocalReviewContext {
  prDiff: PrDiff;
  files: { path: string; content: string; truncated: boolean }[];
}

/** DESIGN.md §6.2 context assembly, sourced from the local git working tree instead of a PlatformAdapter — the CLI reviews what's actually on disk, not what's been pushed anywhere. */
export async function assembleLocalContext(repoRoot: string, base: string): Promise<LocalReviewContext> {
  const baseSha = git(["rev-parse", base], repoRoot).trim();
  const headSha = git(["rev-parse", "HEAD"], repoRoot).trim();
  const diffText = git(["diff", "--no-color", `${base}...HEAD`], repoRoot);
  const prDiff = buildPrDiff({ baseSha, headSha, diffText });

  const changedPaths = prDiff.files.filter((f) => f.path !== "(deleted)" && isReviewableSourcePath(f.path)).map((f) => f.path);

  const files: LocalReviewContext["files"] = [];
  for (const path of changedPaths) {
    try {
      const content = await readFile(join(repoRoot, path), "utf8");
      const truncated = content.length > MAX_FILE_CHARS;
      files.push({ path, content: truncated ? `${content.slice(0, MAX_FILE_CHARS)}\n… (truncated)` : content, truncated });
    } catch {
      // Deleted in this diff, or genuinely unreadable (binary despite the extension filter) — skip it.
    }
  }

  return { prDiff, files };
}

export function findGitRoot(startDir: string): string {
  return git(["rev-parse", "--show-toplevel"], startDir).trim();
}
