import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_CONFIG = {
  strictness: "standard",
  commentBudget: 7,
  ignoredPaths: ["**/dist/**", "**/node_modules/**", "**/*.min.js"],
  failOnCritical: true,
};

/**
 * Writes .review.yml as JSON — valid YAML (JSON is a syntactic subset of YAML 1.2), so it
 * reads fine as a .yml file without pulling in a YAML parser dependency for a config this
 * small. Consumed locally by `codeferret review` today; DESIGN.md §6.1 also describes the
 * PR bot honoring a repo-root .review.yml, which isn't wired up on the backend yet (repo
 * config currently lives in Supabase, editable from the web app) — this file is real and
 * used by the CLI regardless of that.
 */
export async function writeReviewConfig(repoRoot: string, force: boolean): Promise<{ path: string; wrote: boolean }> {
  const path = join(repoRoot, ".review.yml");
  if (!force) {
    try {
      await access(path);
      return { path, wrote: false }; // already exists — don't clobber a customized config
    } catch {
      // doesn't exist yet — proceed
    }
  }
  await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  return { path, wrote: true };
}
