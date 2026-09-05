import type {
  CheckStatus,
  CommentId,
  LineComment,
  Markdown,
  NormalizedEvent,
  PlatformComment,
  PrRef,
  RepoRef,
  UnifiedDiff,
} from "../types/domain.js";

/** Embedded in our summary comment on every platform so re-runs update it in place instead of posting a duplicate. */
export const SUMMARY_MARKER = "<!-- codeferret:summary -->";

export interface ApplyFixParams {
  path: string;
  /** Branch NAME (not a sha) — both platforms' "commit a file change" APIs operate on a branch, not a raw commit. */
  branch: string;
  newContent: string;
  message: string;
}

/**
 * One interface, two implementations (GitHub, Bitbucket).
 * The engine never knows which platform it's on.
 *
 * `parseEvent` receives whatever the platform's webhook route hands it —
 * for GitHub that is `{ name: <x-github-event>, payload: <json body> }`.
 */
export interface PlatformAdapter {
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean;
  parseEvent(payload: unknown): NormalizedEvent | null;
  getDiff(pr: PrRef): Promise<UnifiedDiff>;
  /** Current head sha/branch + title/author for a PR — used by manual trigger/rerun (where we don't yet have a webhook payload) and by apply-fix (which needs the branch NAME to commit onto). */
  getPrInfo(pr: PrRef): Promise<{ headSha: string; headRef: string; title: string; author: string; baseSha: string }>;
  getFile(repo: RepoRef, path: string, sha: string): Promise<string>;
  /** Commits a single-file change directly onto a branch — backs "apply suggested fix" (engine/applyFix.ts). Throws on failure; never partially applies. */
  applyFix(pr: PrRef, params: ApplyFixParams): Promise<void>;
  /** tokenized shallow-clone URL */
  cloneUrl(repo: RepoRef): Promise<string>;
  postSummary(pr: PrRef, body: Markdown): Promise<CommentId>;
  postLineComment(pr: PrRef, c: LineComment): Promise<CommentId>;
  /** Threaded reply under an existing line comment — used for chat-with-reviewer (DESIGN.md §6.7). */
  postReply(pr: PrRef, parentCommentId: CommentId, body: Markdown): Promise<CommentId>;
  updateComment(pr: PrRef, id: CommentId, body: Markdown): Promise<void>;
  setStatus(pr: PrRef, s: CheckStatus): Promise<void>;
  listOwnComments(pr: PrRef): Promise<PlatformComment[]>;
}
