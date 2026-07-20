import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClonedRepo {
  dir: string;
  headSha: string;
  cleanup: () => Promise<void>;
}

/**
 * Shallow (depth 1) clone to an ephemeral temp dir — DESIGN.md §7/§13:
 * "never persist customer source code beyond the review run... purge after
 * indexing." Caller MUST call cleanup() even on error (use try/finally).
 *
 * `cloneUrl` embeds a short-lived access token — errors are deliberately
 * re-thrown without the original message/args so a thrown/logged error can
 * never leak that token.
 */
export async function cloneShallow(cloneUrl: string): Promise<ClonedRepo> {
  const dir = await mkdtemp(join(tmpdir(), "codeferret-index-"));
  try {
    await execFileAsync("git", ["clone", "--depth", "1", "--single-branch", cloneUrl, dir]);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
    return { dir, headSha: stdout.trim(), cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("git clone failed — repo unreachable, access token expired/revoked, or default branch missing");
  }
}
