import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SUMMARY_MARKER, type PlatformAdapter } from "../types.js";
import type {
  CheckStatus,
  CommentId,
  LineComment,
  Markdown,
  NormalizedEvent,
  PlatformComment,
  PrRef,
  RepoRef,
} from "../../types/domain.js";
import { getDb } from "../../db/client.js";
import { getCachedInstallationToken } from "../../db/repositories.js";

const API_BASE = "https://api.bitbucket.org/2.0";

export interface BitbucketAdapterConfig {
  /**
   * Single app-wide secret used for every workspace webhook we register
   * (Bitbucket Cloud's "secure webhooks" feature — the identical
   * HMAC-SHA256-over-`X-Hub-Signature` scheme GitHub uses). Per-workspace
   * auth for API calls (clone/comment/status) comes from a Workspace Access
   * Token the customer supplies at connect time, cached encrypted in
   * `platform_tokens` (DESIGN.md §4/§13) — not this secret.
   */
  webhookSecret: string;
}

/** Shape the webhook route hands to parseEvent — mirrors the GitHub adapter's convention. */
export const BitbucketWebhookInputSchema = z.object({
  name: z.string(), // the X-Event-Key header value, e.g. "pullrequest:created"
  payload: z.unknown(),
});

const WorkspaceRefSchema = z.object({ slug: z.string(), uuid: z.string() });
const RepositoryRefSchema = z.object({
  uuid: z.string(),
  full_name: z.string(),
  workspace: WorkspaceRefSchema,
  mainbranch: z.object({ name: z.string() }).optional(),
  is_private: z.boolean().optional(),
});

const PullRequestRefSchema = z.object({
  id: z.number(),
  title: z.string(),
  author: z.object({ nickname: z.string().optional(), display_name: z.string().optional() }).optional(),
  source: z.object({ commit: z.object({ hash: z.string() }) }),
});

const PullRequestEventSchema = z.object({
  pullrequest: PullRequestRefSchema,
  repository: RepositoryRefSchema,
});

const CommentEventSchema = z.object({
  comment: z.object({
    id: z.number(),
    content: z.object({ raw: z.string() }),
    user: z.object({ nickname: z.string().optional(), display_name: z.string().optional() }).optional(),
    parent: z.object({ id: z.number() }).optional(),
  }),
  pullrequest: z.object({ id: z.number() }),
  repository: RepositoryRefSchema,
});

/** Matches an explicit @mention of the bot in a general PR conversation comment (not threaded under a specific finding). */
const BOT_MENTION_RE = /\bcodeferret\b/i;

function repoSlug(fullName: string): string {
  return fullName.split("/")[1] ?? fullName;
}

function repoRef(repo: z.infer<typeof RepositoryRefSchema>): RepoRef {
  return {
    platform: "bitbucket",
    externalId: repo.uuid,
    owner: repo.workspace.slug,
    name: repoSlug(repo.full_name),
    orgExternalId: repo.workspace.uuid,
    orgName: repo.workspace.slug,
    defaultBranch: repo.mainbranch?.name,
    isPrivate: repo.is_private,
  };
}

const PushEventSchema = z.object({
  push: z.object({
    changes: z.array(
      z.object({
        new: z.object({ name: z.string(), target: z.object({ hash: z.string() }) }).nullable(),
      }),
    ),
  }),
  repository: RepositoryRefSchema,
});

/** Bitbucket's "line comment" line-number semantics: inline.to = line in the new/destination file, inline.from = line in the old/source file. We always comment on the new side, matching the GitHub adapter's default. */
interface BitbucketInlineBody {
  content: { raw: string };
  inline?: { path: string; to: number };
  parent?: { id: number };
}

export class BitbucketAdapter implements PlatformAdapter {
  constructor(private readonly cfg: BitbucketAdapterConfig) {}

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean {
    const header = headers["x-hub-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return false;
    const expected = "sha256=" + createHmac("sha256", this.cfg.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseEvent(input: unknown): NormalizedEvent | null {
    const parsed = BitbucketWebhookInputSchema.safeParse(input);
    if (!parsed.success) return null;
    const { name, payload } = parsed.data;

    if (name === "pullrequest:created" || name === "pullrequest:updated") {
      const ev = PullRequestEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { pullrequest: pr, repository } = ev.data;
      const ref: PrRef = {
        repo: repoRef(repository),
        number: pr.id,
        title: pr.title,
        author: pr.author?.nickname ?? pr.author?.display_name,
      };
      return name === "pullrequest:created"
        ? { kind: "pr_opened", pr: ref, headSha: pr.source.commit.hash }
        : { kind: "pr_updated", pr: ref, headSha: pr.source.commit.hash };
    }

    if (name === "pullrequest:comment_created") {
      const ev = CommentEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { comment, pullrequest: pr, repository } = ev.data;
      const author = comment.user?.nickname ?? comment.user?.display_name ?? "";
      if (author.endsWith("[bot]") || author === "codeferret") return null; // never our own comments/replies

      const ref: PrRef = { repo: repoRef(repository), number: pr.id };
      const body = comment.content.raw;

      const match = body.trim().match(/^\/(review|pause|resume|resolve)\b/);
      if (match) {
        return { kind: "command", pr: ref, command: match[1] as "review" | "pause" | "resume" | "resolve", author };
      }

      // A reply threaded under one of our own comments (finding or summary).
      if (comment.parent) {
        return { kind: "feedback", pr: ref, commentId: String(comment.parent.id), type: "reply", body, scope: "finding" };
      }

      // A brand-new top-level comment explicitly @mentioning the bot.
      if (BOT_MENTION_RE.test(body)) {
        return { kind: "feedback", pr: ref, commentId: String(comment.id), type: "reply", body, scope: "general" };
      }

      return null;
    }

    if (name === "repo:push") {
      const ev = PushEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { push, repository } = ev.data;
      const defaultBranch = repository.mainbranch?.name;
      if (!defaultBranch) return null;
      const change = push.changes.find((c) => c.new?.name === defaultBranch);
      if (!change?.new) return null; // no push landed on the default branch (or it was deleted)
      return { kind: "repo_pushed", repo: repoRef(repository), headSha: change.new.target.hash };
    }

    return null;
  }

  /** Workspace Access Token supplied by the customer at connect time (Settings → Connect Bitbucket), cached encrypted — DESIGN.md §4/§13. Unlike GitHub's App-signed mint flow there is no fallback: an expired/missing token here means the workspace needs to be reconnected. */
  private async accessToken(repo: RepoRef): Promise<string> {
    const token = await getCachedInstallationToken(getDb(), "bitbucket", repo.orgExternalId);
    if (!token) {
      throw new Error(
        `No Bitbucket access token cached for workspace "${repo.owner}" — reconnect the workspace in Settings, or ENCRYPTION_KEY is not configured.`,
      );
    }
    return token;
  }

  private async request<T>(repo: RepoRef, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken(repo);
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`Bitbucket API ${method} ${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as T;
  }

  async getPrInfo(pr: PrRef): Promise<{ headSha: string; title: string; author: string; baseSha: string }> {
    const data = await this.request<{
      source: { commit: { hash: string } };
      destination: { commit: { hash: string } };
      title: string;
      author?: { nickname?: string; display_name?: string };
    }>(pr.repo, "GET", `/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}`);
    return {
      headSha: data.source.commit.hash,
      baseSha: data.destination.commit.hash,
      title: data.title,
      author: data.author?.nickname ?? data.author?.display_name ?? "unknown",
    };
  }

  async getDiff(pr: PrRef): Promise<string> {
    const token = await this.accessToken(pr.repo);
    const res = await fetch(
      `${API_BASE}/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}/diff`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Bitbucket diff fetch failed: ${res.status}`);
    return res.text();
  }

  async getFile(repo: RepoRef, path: string, sha: string): Promise<string> {
    const token = await this.accessToken(repo);
    const res = await fetch(`${API_BASE}/repositories/${repo.owner}/${repo.name}/src/${sha}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Bitbucket file fetch failed for ${path}@${sha}: ${res.status}`);
    return res.text();
  }

  async cloneUrl(repo: RepoRef): Promise<string> {
    const token = await this.accessToken(repo);
    return `https://x-token-auth:${token}@bitbucket.org/${repo.owner}/${repo.name}.git`;
  }

  async postSummary(pr: PrRef, body: Markdown): Promise<CommentId> {
    const data = await this.request<{ id: number }>(
      pr.repo,
      "POST",
      `/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}/comments`,
      { content: { raw: body } } satisfies BitbucketInlineBody,
    );
    return String(data.id);
  }

  async postLineComment(pr: PrRef, c: LineComment): Promise<CommentId> {
    const data = await this.request<{ id: number }>(
      pr.repo,
      "POST",
      `/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}/comments`,
      { content: { raw: c.body }, inline: { path: c.path, to: c.line } } satisfies BitbucketInlineBody,
    );
    return String(data.id);
  }

  async postReply(pr: PrRef, parentCommentId: CommentId, body: Markdown): Promise<CommentId> {
    const data = await this.request<{ id: number }>(
      pr.repo,
      "POST",
      `/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}/comments`,
      { content: { raw: body }, parent: { id: Number(parentCommentId) } } satisfies BitbucketInlineBody,
    );
    return String(data.id);
  }

  async updateComment(pr: PrRef, id: CommentId, body: Markdown): Promise<void> {
    await this.request(
      pr.repo,
      "PUT",
      `/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}/comments/${id}`,
      { content: { raw: body } },
    );
  }

  async setStatus(pr: PrRef, s: CheckStatus): Promise<void> {
    // Bitbucket has no "neutral" build state — map it to SUCCESSFUL (informational, never blocks).
    const stateByCheck = { pending: "INPROGRESS", success: "SUCCESSFUL", neutral: "SUCCESSFUL", failure: "FAILED" } as const;
    await this.request(pr.repo, "POST", `/repositories/${pr.repo.owner}/${pr.repo.name}/commit/${s.headSha}/statuses/build`, {
      key: "codeferret-review",
      state: stateByCheck[s.state],
      name: s.title,
      description: s.summary.slice(0, 255), // Bitbucket caps description length
      url: `https://bitbucket.org/${pr.repo.owner}/${pr.repo.name}/pull-requests/${pr.number}`,
    });
  }

  async listOwnComments(pr: PrRef): Promise<PlatformComment[]> {
    const data = await this.request<{ values: Array<{ id: number; content: { raw: string } }> }>(
      pr.repo,
      "GET",
      `/repositories/${pr.repo.owner}/${pr.repo.name}/pullrequests/${pr.number}/comments?pagelen=100`,
    );
    return data.values
      .filter((c) => c.content.raw.includes(SUMMARY_MARKER))
      .map((c) => ({ id: String(c.id), body: c.content.raw }));
  }
}
