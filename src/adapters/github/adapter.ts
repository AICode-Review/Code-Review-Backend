import { createHmac, timingSafeEqual } from "node:crypto";
import { App } from "@octokit/app";
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
import { cacheInstallationToken, getCachedInstallationToken } from "../../db/repositories.js";

/** GitHub installation tokens are valid ~60 min — refresh 10 min early, matching DESIGN.md §4. */
const TOKEN_TTL_MS = 50 * 60 * 1000;

export interface GithubAdapterConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

/** Shape the webhook route hands to parseEvent. */
export const GithubWebhookInputSchema = z.object({
  name: z.string(),
  payload: z.unknown(),
});

const RepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  default_branch: z.string().optional(),
  owner: z.object({ id: z.number(), login: z.string() }),
  private: z.boolean().optional(),
});

const PullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    head: z.object({ sha: z.string() }),
    user: z.object({ login: z.string() }).nullable().optional(),
    draft: z.boolean().optional(),
  }),
  repository: RepositorySchema,
  installation: z.object({ id: z.number() }).optional(),
});

const InstallationEventSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ id: z.number(), login: z.string(), type: z.enum(["User", "Organization"]) }),
  }),
  repositories: z
    .array(z.object({ id: z.number(), name: z.string(), full_name: z.string(), private: z.boolean().optional() }))
    .optional(),
  /** whoever clicked "install" in the GitHub UI — not necessarily the account owner. */
  sender: z.object({ id: z.number(), login: z.string() }),
});

const IssueCommentEventSchema = z.object({
  action: z.string(),
  comment: z.object({ id: z.number(), body: z.string(), user: z.object({ login: z.string() }) }),
  issue: z.object({ number: z.number(), pull_request: z.object({}).passthrough().optional() }),
  repository: RepositorySchema,
  installation: z.object({ id: z.number() }).optional(),
});

const PullRequestReviewCommentEventSchema = z.object({
  action: z.string(),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    user: z.object({ login: z.string() }),
    in_reply_to_id: z.number().optional(),
  }),
  pull_request: z.object({ number: z.number() }),
  repository: RepositorySchema,
  installation: z.object({ id: z.number() }).optional(),
});

const PushEventSchema = z.object({
  ref: z.string(),
  after: z.string(),
  repository: RepositorySchema,
  installation: z.object({ id: z.number() }).optional(),
});

/** Matches an explicit @mention of the bot in a general PR conversation comment (not threaded under a specific finding). */
const BOT_MENTION_RE = /\bcodeferret\b/i;

function repoRef(repo: z.infer<typeof RepositorySchema>, installationId?: number): RepoRef {
  return {
    platform: "github",
    externalId: String(repo.id),
    owner: repo.owner.login,
    name: repo.name,
    orgExternalId: String(repo.owner.id),
    orgName: repo.owner.login,
    defaultBranch: repo.default_branch,
    installationId,
    isPrivate: repo.private,
  };
}

export class GithubAdapter implements PlatformAdapter {
  private readonly app: App;

  constructor(private readonly cfg: GithubAdapterConfig) {
    this.app = new App({ appId: cfg.appId, privateKey: cfg.privateKey });
  }

  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean {
    const header = headers["x-hub-signature-256"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return false;
    const expected =
      "sha256=" + createHmac("sha256", this.cfg.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseEvent(input: unknown): NormalizedEvent | null {
    const parsed = GithubWebhookInputSchema.safeParse(input);
    if (!parsed.success) return null;
    const { name, payload } = parsed.data;

    if (name === "pull_request") {
      const ev = PullRequestEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { action, pull_request: pr, repository, installation } = ev.data;
      const ref: PrRef = {
        repo: repoRef(repository, installation?.id),
        number: pr.number,
        title: pr.title,
        author: pr.user?.login,
      };
      if (action === "opened" || action === "reopened" || action === "ready_for_review") {
        return { kind: "pr_opened", pr: ref, headSha: pr.head.sha };
      }
      if (action === "synchronize") {
        return { kind: "pr_updated", pr: ref, headSha: pr.head.sha };
      }
      return null;
    }

    if (name === "installation") {
      const ev = InstallationEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { action, installation, repositories, sender } = ev.data;
      if (action !== "created" && action !== "deleted") return null;
      const org = {
        platform: "github" as const,
        externalId: String(installation.account.id),
        name: installation.account.login,
      };
      const repos: RepoRef[] = (repositories ?? []).map((r) => ({
        platform: "github" as const,
        externalId: String(r.id),
        owner: installation.account.login,
        name: r.name,
        orgExternalId: org.externalId,
        orgName: org.name,
        installationId: installation.id,
        isPrivate: r.private,
      }));
      if (action === "deleted") return { kind: "uninstalled", org, repos };
      return {
        kind: "installed",
        org,
        repos,
        installationId: installation.id,
        accountType: installation.account.type,
        installedBy: { githubId: sender.id, login: sender.login },
      };
    }

    if (name === "issue_comment") {
      const ev = IssueCommentEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { action, comment, issue, repository, installation } = ev.data;
      // Only commands on PRs, only on creation, never our own bot comments.
      if (action !== "created" || !issue.pull_request) return null;
      if (comment.user.login.endsWith("[bot]")) return null;
      const ref: PrRef = { repo: repoRef(repository, installation?.id), number: issue.number };

      const match = comment.body.trim().match(/^\/(review|pause|resume|resolve)\b/);
      if (match) {
        return { kind: "command", pr: ref, command: match[1] as "review" | "pause" | "resume" | "resolve", author: comment.user.login };
      }

      // Explicit @mention in the PR's general conversation — chat-with-reviewer
      // without a specific finding attached (DESIGN.md §6.7).
      if (BOT_MENTION_RE.test(comment.body)) {
        return { kind: "feedback", pr: ref, commentId: String(comment.id), type: "reply", body: comment.body, scope: "general" };
      }

      return null;
    }

    if (name === "pull_request_review_comment") {
      const ev = PullRequestReviewCommentEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { action, comment, pull_request: pr, repository, installation } = ev.data;
      // Only replies (never a brand-new top-level review comment) on creation, never our own bot's replies.
      if (action !== "created" || comment.in_reply_to_id === undefined) return null;
      if (comment.user.login.endsWith("[bot]")) return null;
      return {
        kind: "feedback",
        pr: { repo: repoRef(repository, installation?.id), number: pr.number },
        commentId: String(comment.in_reply_to_id),
        type: "reply",
        body: comment.body,
        scope: "finding",
      };
    }

    if (name === "push") {
      const ev = PushEventSchema.safeParse(payload);
      if (!ev.success) return null;
      const { ref, after, repository, installation } = ev.data;
      const defaultBranch = repository.default_branch;
      if (!defaultBranch || ref !== `refs/heads/${defaultBranch}`) return null; // only the default branch re-indexes
      if (/^0+$/.test(after)) return null; // branch deletion — nothing to index
      return { kind: "repo_pushed", repo: repoRef(repository, installation?.id), headSha: after };
    }

    return null;
  }

  private octokit(repo: RepoRef) {
    if (repo.installationId === undefined) {
      throw new Error(`Missing GitHub installationId for ${repo.owner}/${repo.name}`);
    }
    return this.app.getInstallationOctokit(repo.installationId);
  }

  async getPrInfo(pr: PrRef): Promise<{ headSha: string; title: string; author: string; baseSha: string }> {
    const kit = await this.octokit(pr.repo);
    const res = await kit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      pull_number: pr.number,
    });
    const data = res.data as {
      head: { sha: string };
      base: { sha: string };
      title: string;
      user: { login: string } | null;
    };
    return {
      headSha: data.head.sha,
      baseSha: data.base.sha,
      title: data.title,
      author: data.user?.login ?? "unknown",
    };
  }

  async getDiff(pr: PrRef): Promise<string> {
    const kit = await this.octokit(pr.repo);
    const res = await kit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      pull_number: pr.number,
      mediaType: { format: "diff" },
    });
    return res.data as unknown as string;
  }

  async getFile(repo: RepoRef, path: string, sha: string): Promise<string> {
    const kit = await this.octokit(repo);
    const res = await kit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: repo.owner,
      repo: repo.name,
      path,
      ref: sha,
    });
    const data = res.data as { content?: string; encoding?: string };
    if (!data.content) throw new Error(`No content for ${path}@${sha}`);
    return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf8");
  }

  async cloneUrl(repo: RepoRef): Promise<string> {
    if (repo.installationId === undefined) {
      throw new Error(`Missing GitHub installationId for ${repo.owner}/${repo.name}`);
    }
    const token = await this.getInstallationAccessToken(repo);
    return `https://x-access-token:${token}@github.com/${repo.owner}/${repo.name}.git`;
  }

  /** Postgres-cached (encrypted, 50-min TTL) installation access token — DESIGN.md §4. Falls back to minting fresh if the cache is unavailable/expired/unconfigured. */
  private async getInstallationAccessToken(repo: RepoRef): Promise<string> {
    if (repo.installationId === undefined) {
      throw new Error(`Missing GitHub installationId for ${repo.owner}/${repo.name}`);
    }
    const db = getDb();
    const cached = await getCachedInstallationToken(db, "github", repo.orgExternalId).catch(() => null);
    if (cached) return cached;

    const res = await this.app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: repo.installationId,
    });
    const token = (res.data as { token: string }).token;
    await cacheInstallationToken(db, "github", repo.orgExternalId, token, new Date(Date.now() + TOKEN_TTL_MS)).catch((err) => {
      console.error("[github adapter] failed to cache installation token:", err);
    });
    return token;
  }

  async postSummary(pr: PrRef, body: Markdown): Promise<CommentId> {
    const kit = await this.octokit(pr.repo);
    const res = await kit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      issue_number: pr.number,
      body,
    });
    return String((res.data as { id: number }).id);
  }

  async postLineComment(pr: PrRef, c: LineComment): Promise<CommentId> {
    const kit = await this.octokit(pr.repo);
    const res = await kit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      pull_number: pr.number,
      commit_id: c.headSha,
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.body,
    });
    return String((res.data as { id: number }).id);
  }

  async postReply(pr: PrRef, parentCommentId: CommentId, body: Markdown): Promise<CommentId> {
    const kit = await this.octokit(pr.repo);
    // Octokit's generated type for this endpoint only models the "new top-level
    // comment" params (commit_id/path/line/side) as required — it doesn't
    // reflect that the API also accepts the "threaded reply" shape used here
    // (body + in_reply_to only). The cast reflects GitHub's actual documented behavior.
    const res = await kit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      pull_number: pr.number,
      body,
      in_reply_to: Number(parentCommentId),
    } as unknown as Parameters<typeof kit.request<"POST /repos/{owner}/{repo}/pulls/{pull_number}/comments">>[1]);
    return String((res.data as { id: number }).id);
  }

  async updateComment(pr: PrRef, id: CommentId, body: Markdown): Promise<void> {
    const kit = await this.octokit(pr.repo);
    await kit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      comment_id: Number(id),
      body,
    });
  }

  async setStatus(pr: PrRef, s: CheckStatus): Promise<void> {
    const kit = await this.octokit(pr.repo);
    const conclusionByState = { success: "success", failure: "failure", neutral: "neutral" } as const;
    await kit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      name: "AI Review",
      head_sha: s.headSha,
      ...(s.state === "pending"
        ? { status: "in_progress" as const }
        : { status: "completed" as const, conclusion: conclusionByState[s.state] }),
      output: { title: s.title, summary: s.summary },
    });
  }

  async listOwnComments(pr: PrRef): Promise<PlatformComment[]> {
    const kit = await this.octokit(pr.repo);
    const res = await kit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: pr.repo.owner,
      repo: pr.repo.name,
      issue_number: pr.number,
      per_page: 100,
    });
    const comments = res.data as Array<{ id: number; body?: string }>;
    return comments
      .filter((c) => c.body?.includes(SUMMARY_MARKER))
      .map((c) => ({ id: String(c.id), body: c.body ?? "" }));
  }
}
