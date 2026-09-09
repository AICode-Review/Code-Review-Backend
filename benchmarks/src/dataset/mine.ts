import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseUnifiedDiff } from "../../../src/engine/diff.js";
import type { BenchmarkCase } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Mines candidate real-PR benchmark cases from an OSS repo's history — the "100+
 * real merged PRs... mined from 'fixes #issue' commits" corpus DESIGN.md §12 and
 * dataset/seed.ts's own doc comment describe as a separate piece of real work.
 *
 * Method (SZZ-style bug-introduction tracing, the standard technique for this):
 *   1. Find commits whose message references an issue via fixes/closes/resolves #N.
 *   2. For each, diff it against its parent to find exactly which pre-fix lines
 *      were touched.
 *   3. `git blame` those line ranges at the parent commit to find whichever
 *      earlier commit last touched them — the commit that most plausibly
 *      *introduced* the bug the fix commit resolved.
 *   4. Emit that introducing commit's own diff/files as the case, and its own
 *      added lines as the expected-finding location — since that's where the
 *      regression actually entered the codebase.
 *
 * This produces CANDIDATES, not finished cases — every output entry is written
 * to a JSON report for a human to read and verify before it's hand-promoted into
 * a real `BenchmarkCase` (source: "real_pr") in the dataset. Never wire this
 * script's output directly into the scored dataset: category/severity here are
 * keyword heuristics guessed from the fix commit's message, not a verified
 * classification, and the blame-based pairing itself can be wrong (the blamed
 * commit may have only moved code someone else wrote, touched unrelated lines
 * in the same hunk, etc.). See dataset/README section "Mining real cases".
 */

export interface FixCommitRef {
  sha: string;
  parentSha: string;
  subject: string;
  issueNumber: string;
}

export interface MineCandidate {
  id: string;
  repo: string;
  fixCommitSha: string;
  fixCommitSubject: string;
  introducingCommitSha: string;
  introducingCommitSubject: string;
  prUrl: string | null;
  language: string;
  diff: string;
  files: Record<string, string>;
  expectedFindings: BenchmarkCase["expectedFindings"];
  notes: string;
}

const FIX_REF = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)/i;

/** Pure — parses `git log --format="%H%x1f%P%x1f%s"` output into fix-referencing commits. */
export function parseFixCommits(log: string): FixCommitRef[] {
  const out: FixCommitRef[] = [];
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    const [sha, parents, subject] = line.split("\x1f");
    if (!sha || !subject) continue;
    const parentSha = parents?.trim().split(" ")[0];
    if (!parentSha) continue; // skip root commits — no parent to diff/blame against
    const match = FIX_REF.exec(subject);
    const issueNumber = match?.[1];
    if (!issueNumber) continue;
    out.push({ sha, parentSha, subject: subject.trim(), issueNumber });
  }
  return out;
}

const CATEGORY_KEYWORDS: Array<[RegExp, MineCandidate["expectedFindings"][number]["category"]]> = [
  [/\b(xss|sql injection|csrf|ssrf|auth|authoriz|inject|vulnerab|secret|credential|escape|sanitiz|cve)\b/i, "security"],
  [/\b(race|deadlock|concurren|unawaited|mutex|lock\b|atomic)\b/i, "concurrency"],
  [/\b(breaking|signature|contract|incompatib|api change)\b/i, "contracts"],
  [/\b(swallow|uncaught|unhandled|exception|error handling|leak\b)\b/i, "errors"],
  [/\b(test|flaky|assertion|spec\b)\b/i, "tests"],
  [/\b(lint|style|format|whitespace|typo)\b/i, "style"],
];

/** Pure — heuristic only; a human must confirm before trusting this on a real case. */
export function guessCategory(fixMessage: string): MineCandidate["expectedFindings"][number]["category"] {
  for (const [re, category] of CATEGORY_KEYWORDS) {
    if (re.test(fixMessage)) return category;
  }
  return "logic";
}

const CRITICAL_KEYWORDS = /\b(security|vulnerab|crash|data loss|corrupt|exploit|cve|rce\b)\b/i;
const MINOR_KEYWORDS = /\b(typo|lint|style|whitespace|cosmetic|nit\b)\b/i;

/** Pure — heuristic only; same caveat as guessCategory. */
export function guessSeverity(fixMessage: string): MineCandidate["expectedFindings"][number]["severity"] {
  if (CRITICAL_KEYWORDS.test(fixMessage)) return "critical";
  if (MINOR_KEYWORDS.test(fixMessage)) return "minor";
  return "major";
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rb: "ruby", java: "java", kt: "kotlin", rs: "rust", c: "c", h: "c", cpp: "cpp",
  cs: "csharp", php: "php", swift: "swift",
};

/** Pure — small local guess; the real engine's cosmetic-only LANG_BY_EXT map is broader but not exported. */
export function guessLanguage(paths: string[]): string {
  for (const path of paths) {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext && EXT_LANGUAGE[ext]) return EXT_LANGUAGE[ext];
  }
  return "unknown";
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 * 32 });
  return stdout;
}

const BLAME_HEADER = /^[0-9a-f]{40} /;

/** Pure — `git blame --line-porcelain` emits one header line (`<sha> <origline> <finalline>...`)
 * per blamed source line, interleaved with metadata/content lines. Tallies how many of the
 * requested lines each commit is responsible for, so a range spanning several authors doesn't
 * silently collapse to whichever commit happened to blame first. */
export function tallyBlameShas(porcelain: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of porcelain.split("\n")) {
    if (!BLAME_HEADER.test(line)) continue;
    const sha = line.slice(0, 40);
    counts.set(sha, (counts.get(sha) ?? 0) + 1);
  }
  return counts;
}

async function cloneForMining(ownerRepo: string, depth: number): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "scrutinye-mine-"));
  await execFileAsync("git", ["clone", `--depth=${depth}`, `https://github.com/${ownerRepo}.git`, dir]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

interface BlameResolution {
  /** The commit git blame says dominates the touched lines, and how confidently. */
  sha: string;
  dominantCount: number;
  totalLines: number;
}

async function blameDominantCommit(
  dir: string,
  atSha: string,
  touched: Map<string, [number, number]>,
): Promise<BlameResolution | null> {
  const blamed = new Map<string, number>();
  for (const [path, [start, end]] of touched) {
    const porcelain = await git(dir, ["blame", "--line-porcelain", `-L${start},${end}`, atSha, "--", path]);
    for (const [sha, count] of tallyBlameShas(porcelain)) {
      blamed.set(sha, (blamed.get(sha) ?? 0) + count);
    }
  }
  if (blamed.size === 0) return null;
  const totalLines = [...touched.values()].reduce((n, [start, end]) => n + (end - start + 1), 0);
  const [sha, dominantCount] = [...blamed.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return { sha, dominantCount, totalLines };
}

/** Standard SZZ refinement: the commit blame lands on is often itself another fix/refactor
 * commit rather than the original regression — re-diff and re-blame through up to `maxHops`
 * such meta-commits before accepting a result, so "introducing" doesn't just mean "whatever
 * was touched most recently." Returns null (giving up, not guessing) if a hop's own diff/blame
 * fails, is ambiguous, or the hop budget runs out while still landing on a fix-shaped commit. */
async function resolveIntroducingCommit(
  dir: string,
  startSha: string,
  startParentSha: string,
  maxHops: number,
  debug: (msg: string) => void,
): Promise<string | null> {
  let sha = startSha;
  let parentSha = startParentSha;

  for (let hop = 0; hop <= maxHops; hop++) {
    const diff = await git(dir, ["diff", parentSha, sha]).catch(() => null);
    if (!diff) {
      debug(`  hop ${hop}: diff ${parentSha.slice(0, 7)}..${sha.slice(0, 7)} failed`);
      return null;
    }
    const touched = collectPreFixTouchedRanges(diff);
    if (touched.size === 0) {
      debug(`  hop ${hop}: no old-side lines to blame (pure addition)`);
      return null;
    }
    const resolution = await blameDominantCommit(dir, parentSha, touched).catch(() => null);
    if (!resolution || resolution.dominantCount < resolution.totalLines * 0.6) {
      debug(`  hop ${hop}: no dominant blame`);
      return null;
    }

    const subject = (await git(dir, ["log", "-1", "--format=%s", resolution.sha])).trim();
    if (!FIX_REF.test(subject)) {
      debug(`  hop ${hop}: resolved to ${resolution.sha.slice(0, 7)} "${subject}" — not fix-shaped, accepting`);
      return resolution.sha;
    }
    if (hop === maxHops) {
      debug(`  hop ${hop}: resolved to another fix commit "${subject}" and hop budget exhausted — giving up`);
      return null;
    }
    debug(`  hop ${hop}: resolved to another fix commit "${subject}" — tracing back further`);
    const nextParent = (await git(dir, ["log", "-1", "--format=%P", resolution.sha])).trim().split(" ")[0];
    if (!nextParent) return null;
    sha = resolution.sha;
    parentSha = nextParent;
  }
  return null;
}

/** GitHub's "list PRs associated with a commit" endpoint — the only reliable way to turn a
 * commit SHA into a real, checkable PR URL. Unauthenticated (60 req/hr) is fine since this is
 * only called for the handful of candidates that survive git-side filtering, not every commit
 * scanned. Returns null (never throws) on any failure — a missing PR link just means the
 * candidate needs a human to find the real URL manually, not that mining should abort. */
async function findPrUrl(ownerRepo: string, sha: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}/commits/${sha}/pulls`, {
      headers: { Accept: "application/vnd.github.groot-preview+json", "User-Agent": "scrutinye-benchmark-miner" },
    });
    if (!res.ok) return null;
    const prs = (await res.json()) as Array<{ html_url?: string }>;
    return prs[0]?.html_url ?? null;
  } catch {
    return null;
  }
}

/** Pure — old-side line numbers the fix commit deleted or changed, grouped per file: these are
 * the lines that existed pre-fix and are worth blaming to find who introduced them. */
export function collectPreFixTouchedRanges(fixDiffText: string): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  for (const file of parseUnifiedDiff(fixDiffText)) {
    const oldNos = file.lines.filter((l) => l.kind === "del" && l.oldNo != null).map((l) => l.oldNo as number);
    if (oldNos.length === 0) continue;
    ranges.set(file.path, [Math.min(...oldNos), Math.max(...oldNos)]);
  }
  return ranges;
}

interface MineOptions {
  ownerRepo: string;
  limit?: number;
  cloneDepth?: number;
  maxFilesPerCandidate?: number;
  maxDiffLines?: number;
}

export async function mineCandidates(opts: MineOptions): Promise<MineCandidate[]> {
  const limit = opts.limit ?? 8;
  const cloneDepth = opts.cloneDepth ?? 3000;
  const maxFiles = opts.maxFilesPerCandidate ?? 3;
  const maxDiffLines = opts.maxDiffLines ?? 120;

  const { dir, cleanup } = await cloneForMining(opts.ownerRepo, cloneDepth);
  const candidates: MineCandidate[] = [];
  try {
    const log = await git(dir, ["log", "--no-merges", "--format=%H\x1f%P\x1f%s"]);
    const fixCommits = parseFixCommits(log);

    const DEBUG = !!process.env.MINE_DEBUG;

    for (const fix of fixCommits) {
      if (candidates.length >= limit) break;
      if (DEBUG) console.error(`\n[mine] considering ${fix.sha.slice(0, 7)} "${fix.subject}"`);

      const debug = (msg: string) => DEBUG && console.error(msg);
      const introducingSha = await resolveIntroducingCommit(dir, fix.sha, fix.parentSha, 4, debug).catch((e) => {
        debug(`  reject: resolveIntroducingCommit threw — ${(e as Error).message.slice(0, 200)}`);
        return null;
      });
      if (!introducingSha) {
        if (DEBUG) console.error(`  reject: could not resolve a non-fix introducing commit`);
        continue;
      }

      let introducingDiff: string;
      try {
        introducingDiff = await git(dir, ["show", "--no-color", introducingSha]);
      } catch (e) {
        if (DEBUG) console.error("  reject: show introducing commit failed —", (e as Error).message.slice(0, 200));
        continue;
      }
      const introducingFiles = parseUnifiedDiff(introducingDiff);
      const totalLines = introducingFiles.reduce((n, f) => n + f.lines.length, 0);
      if (DEBUG) console.error(`  introducing=${introducingSha.slice(0, 7)} files=${introducingFiles.length} lines=${totalLines}`);
      if (introducingFiles.length === 0 || introducingFiles.length > maxFiles || totalLines > maxDiffLines) {
        if (DEBUG) console.error(`  reject: introducing commit too big (files=${introducingFiles.length}, lines=${totalLines})`);
        continue;
      }

      const files: Record<string, string> = {};
      const expectedFindings: MineCandidate["expectedFindings"] = [];
      let contentFetchFailed = false;
      for (const f of introducingFiles) {
        try {
          files[f.path] = await git(dir, ["show", `${introducingSha}:${f.path}`]);
        } catch {
          contentFetchFailed = true;
          break; // file was deleted/renamed at this SHA in a way `show` can't resolve — skip case
        }
        const addedNos = f.lines.filter((l) => l.kind === "add" && l.newNo != null).map((l) => l.newNo as number);
        if (addedNos.length === 0) continue;
        expectedFindings.push({
          path: f.path,
          lineRange: [Math.min(...addedNos), Math.max(...addedNos)],
          category: guessCategory(fix.subject),
          severity: guessSeverity(fix.subject),
          description: `Introduced by ${introducingSha.slice(0, 7)}; later fixed by ${fix.sha.slice(0, 7)} ("${fix.subject}"). Category/severity are heuristic guesses from the fix commit's message — verify against the actual diff before trusting this.`,
        });
      }
      if (contentFetchFailed || expectedFindings.length === 0) {
        if (DEBUG) console.error(`  reject: contentFetchFailed=${contentFetchFailed} expectedFindings=${expectedFindings.length}`);
        continue;
      }

      const introducingSubject = (await git(dir, ["log", "-1", "--format=%s", introducingSha])).trim();
      const prUrl = await findPrUrl(opts.ownerRepo, introducingSha);

      candidates.push({
        id: `${opts.ownerRepo.replace("/", "-")}-${introducingSha.slice(0, 7)}`,
        repo: opts.ownerRepo,
        fixCommitSha: fix.sha,
        fixCommitSubject: fix.subject,
        introducingCommitSha: introducingSha,
        introducingCommitSubject: introducingSubject,
        prUrl,
        language: guessLanguage(Object.keys(files)),
        diff: introducingDiff,
        files,
        expectedFindings,
        notes: prUrl
          ? "Has a resolved PR URL — still read the diff yourself before promoting; blame-based pairing can be wrong."
          : "No PR found for this commit (may have been pushed directly, or squash-merged in a way GitHub can't map back) — needs a manually-found prUrl before this can be source:\"real_pr\", or drop it.",
      });
    }
  } finally {
    await cleanup();
  }
  return candidates;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf("--repo");
  const ownerRepo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
  if (!ownerRepo) {
    console.error('Usage: npm run mine -- --repo <owner/name> [--limit N] [--depth N]');
    process.exit(1);
  }
  const limitIdx = args.indexOf("--limit");
  const depthIdx = args.indexOf("--depth");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
  const cloneDepth = depthIdx >= 0 ? Number(args[depthIdx + 1]) : undefined;

  console.error(`Mining ${ownerRepo} (limit=${limit ?? 8}, cloneDepth=${cloneDepth ?? 3000})...`);
  const candidates = await mineCandidates({ ownerRepo, limit, cloneDepth });
  console.error(`Found ${candidates.length} candidate(s). These are UNVERIFIED — read each one before promoting it into the dataset.`);
  process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
