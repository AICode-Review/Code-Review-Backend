import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgRef, PrRef, RepoRef } from "../types/domain.js";
import { decryptToken, encryptToken, encryptionConfigured } from "../security/tokenCrypto.js";
import { env } from "../config.js";
import { bitbucketAuthorizationHeader, encodeBitbucketCredential, parseBitbucketCredential } from "../adapters/bitbucket/auth.js";

interface Row {
  id: string;
}

interface PullRequestJoinRow {
  id: string;
  number: number;
  head_sha: string | null;
  opened_by: string | null;
  repos: {
    id: string;
    external_id: string;
    name: string;
    owner: string;
    default_branch: string;
    org_id: string;
    orgs: {
      id: string;
      platform: "github" | "bitbucket";
      external_id: string;
      name: string;
      installation_id: number | null;
    } | null;
  } | null;
}

function toPrRef(row: PullRequestJoinRow): PrRef {
  const repo = row.repos;
  if (!repo || !repo.orgs) {
    throw new Error(`db: pull_request ${row.id} is missing its repo/org join`);
  }
  return {
    repo: {
      platform: repo.orgs.platform,
      externalId: repo.external_id,
      owner: repo.owner,
      name: repo.name,
      orgExternalId: repo.orgs.external_id,
      orgName: repo.orgs.name,
      defaultBranch: repo.default_branch,
      installationId: repo.orgs.installation_id ?? undefined,
    },
    number: row.number,
    author: row.opened_by ?? undefined,
  };
}

const PR_JOIN_SELECT =
  "id, number, head_sha, opened_by, repos(id, external_id, name, owner, default_branch, org_id, orgs(id, platform, external_id, name, installation_id))";

/** Reconstruct a full PrRef (for calling the platform adapter) from a pull_requests row. */
export async function getPrRefByPrId(
  db: SupabaseClient,
  prId: string,
): Promise<{ pr: PrRef; headSha: string | null; prId: string }> {
  const { data, error } = await db
    .from("pull_requests")
    .select(PR_JOIN_SELECT)
    .eq("id", prId)
    .single();
  if (error || !data) throw new Error(`db: pull_request ${prId} not found: ${error?.message ?? ""}`);
  const row = data as unknown as PullRequestJoinRow;
  return { pr: toPrRef(row), headSha: row.head_sha, prId: row.id };
}

/** Same as getPrRefByPrId but starting from a review_runs id. */
export async function getPrRefByRunId(
  db: SupabaseClient,
  runId: string,
): Promise<{ pr: PrRef; headSha: string; prId: string; runId: string }> {
  const { data: run, error } = await db
    .from("review_runs")
    .select("id, pr_id, head_sha")
    .eq("id", runId)
    .single();
  if (error || !run) throw new Error(`db: review_run ${runId} not found: ${error?.message ?? ""}`);
  const { pr, prId } = await getPrRefByPrId(db, run.pr_id as string);
  return { pr, headSha: run.head_sha as string, prId, runId: run.id as string };
}

/** Look up a repo by org + name, reconstructing enough of RepoRef to call the adapter. */
export async function getRepoRefByName(
  db: SupabaseClient,
  orgId: string,
  repoName: string,
): Promise<{ repo: PrRef["repo"]; repoId: string } | null> {
  const { data, error } = await db
    .from("repos")
    .select(
      "id, external_id, name, owner, default_branch, org_id, orgs(id, platform, external_id, name, installation_id)",
    )
    .eq("org_id", orgId)
    .eq("name", repoName)
    .maybeSingle();
  if (error) throw new Error(`db: failed to look up repo ${repoName}: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as NonNullable<PullRequestJoinRow["repos"]>;
  if (!row.orgs) throw new Error(`db: repo ${repoName} is missing its org join`);
  return {
    repoId: row.id,
    repo: {
      platform: row.orgs.platform,
      externalId: row.external_id,
      owner: row.owner,
      name: row.name,
      orgExternalId: row.orgs.external_id,
      orgName: row.orgs.name,
      defaultBranch: row.default_branch,
      installationId: row.orgs.installation_id ?? undefined,
    },
  };
}

/** Look up a repo directly by id — used by the indexer job, which only has repoId (no orgId/name) in its payload. */
export async function getRepoRefById(db: SupabaseClient, repoId: string): Promise<PrRef["repo"] | null> {
  const { data, error } = await db
    .from("repos")
    .select(
      "id, external_id, name, owner, default_branch, org_id, orgs(id, platform, external_id, name, installation_id)",
    )
    .eq("id", repoId)
    .maybeSingle();
  if (error) throw new Error(`db: failed to look up repo ${repoId}: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as NonNullable<PullRequestJoinRow["repos"]>;
  if (!row.orgs) throw new Error(`db: repo ${repoId} is missing its org join`);
  return {
    platform: row.orgs.platform,
    externalId: row.external_id,
    owner: row.owner,
    name: row.name,
    orgExternalId: row.orgs.external_id,
    orgName: row.orgs.name,
    defaultBranch: row.default_branch,
    installationId: row.orgs.installation_id ?? undefined,
  };
}

function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error || !res.data) {
    throw new Error(`db: failed to ${what}: ${res.error?.message ?? "no row returned"}`);
  }
  return res.data;
}

/** Idempotently materialize org → repo for any incoming platform event. Shared by upsertPrChain and the repo_pushed webhook handler (which has no PR to attach). */
export async function upsertRepoRef(db: SupabaseClient, r: RepoRef): Promise<{ orgId: string; repoId: string }> {
  const org = unwrap<Row>(
    await db
      .from("orgs")
      .upsert(
        {
          platform: r.platform,
          external_id: r.orgExternalId,
          name: r.orgName,
          ...(r.installationId !== undefined ? { installation_id: r.installationId } : {}),
        },
        { onConflict: "platform,external_id" },
      )
      .select("id")
      .single(),
    "upsert org",
  );

  const repo = unwrap<Row>(
    await db
      .from("repos")
      .upsert(
        {
          org_id: org.id,
          external_id: r.externalId,
          name: r.name,
          owner: r.owner,
          ...(r.defaultBranch ? { default_branch: r.defaultBranch } : {}),
          ...(r.isPrivate !== undefined ? { is_private: r.isPrivate } : {}),
        },
        { onConflict: "org_id,external_id" },
      )
      .select("id")
      .single(),
    "upsert repo",
  );

  return { orgId: org.id, repoId: repo.id };
}

/** Idempotently materialize org → repo → pull_request for an incoming PR event. */
export async function upsertPrChain(
  db: SupabaseClient,
  pr: PrRef,
  headSha: string,
): Promise<{ orgId: string; repoId: string; prId: string }> {
  const { orgId, repoId } = await upsertRepoRef(db, pr.repo);

  const pull = unwrap<Row>(
    await db
      .from("pull_requests")
      .upsert(
        {
          repo_id: repoId,
          number: pr.number,
          head_sha: headSha,
          state: "open",
          opened_by: pr.author ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "repo_id,number" },
      )
      .select("id")
      .single(),
    "upsert pull_request",
  );

  return { orgId, repoId, prId: pull.id };
}

export interface RepoConfig {
  strictness: "chill" | "standard" | "strict";
  commentBudget: number;
  ignoredPaths: string[];
  failOnCritical: boolean;
}

const DEFAULT_REPO_CONFIG: RepoConfig = {
  strictness: "standard",
  commentBudget: 7,
  ignoredPaths: [],
  failOnCritical: false,
};

export async function getRepoConfig(db: SupabaseClient, repoId: string): Promise<RepoConfig> {
  const { data, error } = await db.from("repos").select("config").eq("id", repoId).single();
  if (error || !data) throw new Error(`db: repo ${repoId} not found: ${error?.message ?? ""}`);
  const config = (data.config ?? {}) as Partial<RepoConfig>;
  return { ...DEFAULT_REPO_CONFIG, ...config };
}

export async function isRepoPrivate(db: SupabaseClient, repoId: string): Promise<boolean> {
  const { data } = await db.from("repos").select("is_private").eq("id", repoId).maybeSingle();
  return Boolean(data?.is_private);
}

export interface RulebookRuleRow {
  ruleText: string;
  category: string;
  weight: number;
}

/** Active rules for org-wide + this specific repo (repo_id null = org-wide). */
export async function getActiveRulebookRules(db: SupabaseClient, orgId: string, repoId: string): Promise<RulebookRuleRow[]> {
  const { data, error } = await db
    .from("rulebook_rules")
    .select("rule_text, category, weight, repo_id")
    .eq("org_id", orgId)
    .eq("active", true);
  if (error) throw new Error(`db: failed to load rulebook rules: ${error.message}`);
  return (data ?? [])
    .filter((r) => r.repo_id === null || r.repo_id === repoId)
    .map((r) => ({ ruleText: r.rule_text as string, category: r.category as string, weight: Number(r.weight) }));
}

export type FindingFeedback = "accepted" | "dismissed" | "fixed" | "ignored";

/** fingerprint -> most recent feedback, across all prior runs on this PR — used to suppress re-posting dismissed findings and carry feedback forward. */
export async function getPriorFindingFeedback(db: SupabaseClient, prId: string, excludeRunId?: string): Promise<Map<string, FindingFeedback>> {
  const { data: runs, error: runsError } = await db.from("review_runs").select("id, started_at").eq("pr_id", prId);
  if (runsError) throw new Error(`db: failed to load prior runs: ${runsError.message}`);
  const runIds = (runs ?? []).map((r) => r.id as string).filter((id) => id !== excludeRunId);
  if (runIds.length === 0) return new Map();

  const { data: findings, error } = await db
    .from("findings")
    .select("fingerprint, feedback, created_at")
    .in("run_id", runIds)
    .not("feedback", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`db: failed to load prior findings feedback: ${error.message}`);

  const map = new Map<string, FindingFeedback>();
  for (const row of findings ?? []) {
    map.set(row.fingerprint as string, row.feedback as FindingFeedback);
  }
  return map;
}

export async function getRepoOrgId(db: SupabaseClient, repoId: string): Promise<string | null> {
  const { data } = await db.from("repos").select("org_id").eq("id", repoId).maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}

export async function getRunOrgId(db: SupabaseClient, runId: string): Promise<{ orgId: string; repoId: string; prId: string } | null> {
  const { data: run } = await db.from("review_runs").select("pr_id").eq("id", runId).maybeSingle();
  if (!run) return null;
  const { data: pr } = await db.from("pull_requests").select("repo_id").eq("id", run.pr_id as string).maybeSingle();
  if (!pr) return null;
  const orgId = await getRepoOrgId(db, pr.repo_id as string);
  if (!orgId) return null;
  return { orgId, repoId: pr.repo_id as string, prId: run.pr_id as string };
}

export interface FindingChatContext {
  findingId: string;
  orgId: string;
  repoId: string;
  title: string;
  category: string;
  severity: string;
  path: string;
  startLine: number;
  endLine: number;
  bodyMd: string;
  whyItMatters: string;
  impact: string;
  suggestedFix: string | null;
  codeSnippet: string | null;
  feedback: FindingFeedback | null;
}

/**
 * Looks up the finding whose posted line comment is the parent of an
 * incoming reply — chat-with-reviewer context (DESIGN.md §6.7). Null when
 * the reply isn't threaded under one of our own comments (a reply in
 * someone else's review thread, or a general PR-level mention instead).
 */
export async function getFindingByCommentExternalId(db: SupabaseClient, commentId: string): Promise<FindingChatContext | null> {
  const { data } = await db
    .from("findings")
    .select(
      "id, run_id, title, category, severity, path, start_line, end_line, body_md, why_it_matters, impact, suggested_fix, code_snippet, feedback",
    )
    .eq("comment_external_id", commentId)
    .maybeSingle();
  if (!data) return null;
  const ctx = await getRunOrgId(db, data.run_id as string);
  if (!ctx) return null;
  return {
    findingId: data.id as string,
    orgId: ctx.orgId,
    repoId: ctx.repoId,
    title: data.title as string,
    category: data.category as string,
    severity: data.severity as string,
    path: data.path as string,
    startLine: data.start_line as number,
    endLine: data.end_line as number,
    bodyMd: data.body_md as string,
    whyItMatters: data.why_it_matters as string,
    impact: data.impact as string,
    suggestedFix: (data.suggested_fix as string | null) ?? null,
    codeSnippet: (data.code_snippet as string | null) ?? null,
    feedback: (data.feedback as FindingFeedback | null) ?? null,
  };
}

export async function getFindingOrgContext(
  db: SupabaseClient,
  findingId: string,
): Promise<{ orgId: string; repoId: string; runId: string; fingerprint: string } | null> {
  const { data: finding } = await db.from("findings").select("run_id, fingerprint").eq("id", findingId).maybeSingle();
  if (!finding) return null;
  const ctx = await getRunOrgId(db, finding.run_id as string);
  if (!ctx) return null;
  return { ...ctx, runId: finding.run_id as string, fingerprint: finding.fingerprint as string };
}

/**
 * Authoritative org creation — the GitHub installation webhook is the only
 * source of truth for orgs. `kind` follows GitHub's own account type
 * ("User" installs -> individual org, "Organization" installs -> team org),
 * and `installed_by_*` records who to grant ownership to the next time they
 * sign into the web app (see auth/verifyUser.ts claimInstalledOrgs).
 */
export async function upsertInstalledOrg(
  db: SupabaseClient,
  org: OrgRef,
  repos: RepoRef[],
  installationId: number,
  accountType: "User" | "Organization",
  installedBy: { githubId: number; login: string },
): Promise<{ orgId: string; repoIds: string[] }> {
  const orgRow = unwrap<Row>(
    await db
      .from("orgs")
      .upsert(
        {
          platform: org.platform,
          external_id: org.externalId,
          name: org.name,
          kind: accountType === "User" ? "individual" : "team",
          installation_id: installationId,
          installed_by_github_id: installedBy.githubId,
          installed_by_login: installedBy.login,
        },
        { onConflict: "platform,external_id" },
      )
      .select("id")
      .single(),
    "upsert installed org",
  );

  const repoIds: string[] = [];
  for (const repo of repos) {
    const repoRow = unwrap<Row>(
      await db
        .from("repos")
        .upsert(
          { org_id: orgRow.id, external_id: repo.externalId, name: repo.name, owner: repo.owner },
          { onConflict: "org_id,external_id" },
        )
        .select("id")
        .single(),
      `upsert repo ${repo.owner}/${repo.name}`,
    );
    repoIds.push(repoRow.id);
  }

  return { orgId: orgRow.id, repoIds };
}

/** Non-destructive: clears the installation link so new webhooks/API calls fail cleanly, but keeps all review history. */
export async function clearOrgInstallation(db: SupabaseClient, org: OrgRef): Promise<void> {
  const { error } = await db
    .from("orgs")
    .update({ installation_id: null })
    .eq("platform", org.platform)
    .eq("external_id", org.externalId);
  if (error) throw new Error(`db: failed to clear installation for org ${org.name}: ${error.message}`);
}

/**
 * DESIGN.md §6.1: "Cancel in-flight run if a new head SHA arrives." Marks any
 * other queued/running review_runs row for this PR as cancelled — the
 * running job itself notices via `getRunStatus` at its own checkpoints and
 * bails out rather than posting a stale review.
 */
export async function cancelOtherRunsForPr(db: SupabaseClient, prId: string, excludeRunId?: string): Promise<void> {
  let query = db
    .from("review_runs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("pr_id", prId)
    .in("status", ["queued", "running"]);
  if (excludeRunId) query = query.neq("id", excludeRunId);
  const { error } = await query;
  if (error) throw new Error(`db: failed to cancel superseded runs for PR ${prId}: ${error.message}`);
}

export async function getRunStatus(db: SupabaseClient, runId: string): Promise<string | null> {
  const { data } = await db.from("review_runs").select("status").eq("id", runId).maybeSingle();
  return (data?.status as string | undefined) ?? null;
}

/** Record a webhook delivery id; returns false if we've already seen it (duplicate). */
export async function recordDelivery(
  db: SupabaseClient,
  platform: string,
  deliveryId: string,
): Promise<boolean> {
  const { error } = await db
    .from("webhook_deliveries")
    .insert({ platform, delivery_id: deliveryId });
  if (!error) return true;
  if (error.code === "23505") return false; // unique_violation → duplicate delivery
  throw new Error(`db: failed to record webhook delivery: ${error.message}`);
}

/** Best-effort audit trail write — never blocks or fails the mutation it's recording. orgId may be null for platform-scoped actions (e.g. admin grant/revoke). */
export async function recordAudit(
  db: SupabaseClient,
  orgId: string | null,
  actor: string,
  action: string,
  target?: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("audit_log").insert({
    org_id: orgId,
    actor,
    action,
    target: target ?? null,
    meta: meta ?? {},
  });
  if (error) console.error(`[audit] failed to record "${action}" for org ${orgId ?? "platform"}:`, error.message);
}

/**
 * Connects a Bitbucket workspace: no webhook-driven install event exists for
 * Bitbucket (unlike GitHub's `installation` webhook), so this REST-triggered
 * flow does the same job synchronously — upsert the org, grant the calling
 * user ownership immediately (no "claim on next sign-in" round trip needed),
 * and cache the customer-supplied Workspace Access Token.
 */
export async function connectBitbucketWorkspace(
  db: SupabaseClient,
  args: { workspaceSlug: string; workspaceName: string; accessToken: string; accountEmail: string },
  ownerUserId: string,
): Promise<{ orgId: string; repoCount: number; syncError?: string }> {
  const orgRow = unwrap<Row>(
    await db
      .from("orgs")
      .upsert(
        { platform: "bitbucket", external_id: args.workspaceSlug, name: args.workspaceName, kind: "team" },
        { onConflict: "platform,external_id" },
      )
      .select("id")
      .single(),
    "upsert bitbucket org",
  );

  const { error: memberError } = await db
    .from("org_members")
    .upsert({ org_id: orgRow.id, user_id: ownerUserId, role: "owner" }, { onConflict: "org_id,user_id" });
  if (memberError) throw new Error(`db: failed to grant ownership of bitbucket org: ${memberError.message}`);

  const credential = encodeBitbucketCredential(args.accessToken, args.accountEmail);
  await cacheInstallationToken(db, "bitbucket", args.workspaceSlug, credential, new Date(Date.now() + 365 * 86_400_000));

  // Import workspace repos now. Surface sync failures to the client — silent 0-count
  // made private-repo / wrong-auth failures look like "Bitbucket just has no repos".
  try {
    const repoCount = await syncBitbucketWorkspaceRepos(
      db,
      orgRow.id as string,
      args.workspaceSlug,
      credential,
    );
    if (repoCount === 0) {
      const hasEmail = Boolean(parseBitbucketCredential(credential).email);
      return {
        orgId: orgRow.id as string,
        repoCount: 0,
        syncError: hasEmail
          ? `Bitbucket authenticated but returned 0 repos for workspace "${args.workspaceSlug}". Confirm the slug is correct, the token includes read:repository:bitbucket, and that account can see the private repo in Bitbucket.`
          : `Bitbucket returned 0 repos. For a personal API token you must enter your real Atlassian account email (not the placeholder), then reconnect.`,
      };
    }
    return { orgId: orgRow.id as string, repoCount };
  } catch (err) {
    const syncError = err instanceof Error ? err.message : String(err);
    console.error(`[bitbucket] repo sync failed for workspace "${args.workspaceSlug}":`, syncError);
    return { orgId: orgRow.id as string, repoCount: 0, syncError };
  }
}

export interface BitbucketWorkspaceSummary {
  orgId: string;
  name: string;
  workspaceSlug: string;
  role: string;
  plan: string;
  repoCount: number;
  accountEmail: string | null;
  tokenPresent: boolean;
  tokenExpiresAt: string | null;
}

/** Every Bitbucket workspace the user belongs to, with non-secret connection metadata for the Settings UI. */
export async function listBitbucketWorkspacesForUser(
  db: SupabaseClient,
  userId: string,
): Promise<BitbucketWorkspaceSummary[]> {
  const { data, error } = await db
    .from("org_members")
    .select("role, orgs(id, name, plan, platform, external_id)")
    .eq("user_id", userId);
  if (error) throw new Error(`db: failed to list bitbucket workspaces: ${error.message}`);

  type MemberRow = {
    role: string;
    orgs: {
      id: string;
      name: string;
      plan: string;
      platform: string;
      external_id: string;
    } | null;
  };

  const bitbucketOrgs = ((data ?? []) as unknown as MemberRow[])
    .filter((row) => row.orgs?.platform === "bitbucket")
    .map((row) => ({ role: row.role, org: row.orgs! }));

  const summaries: BitbucketWorkspaceSummary[] = [];
  for (const { role, org } of bitbucketOrgs) {
    const { count } = await db
      .from("repos")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id);

    const { data: tokenRow } = await db
      .from("platform_tokens")
      .select("encrypted_token, expires_at")
      .eq("org_id", org.id)
      .eq("platform", "bitbucket")
      .maybeSingle();

    let accountEmail: string | null = null;
    let tokenPresent = false;
    if (tokenRow?.encrypted_token && encryptionConfigured()) {
      try {
        const parsed = parseBitbucketCredential(decryptToken(tokenRow.encrypted_token as string));
        tokenPresent = Boolean(parsed.token);
        accountEmail = parsed.email ?? null;
      } catch {
        tokenPresent = true; // row exists but decrypt failed — still show as connected
      }
    }

    summaries.push({
      orgId: org.id,
      name: org.name,
      workspaceSlug: org.external_id,
      role,
      plan: org.plan,
      repoCount: count ?? 0,
      accountEmail,
      tokenPresent,
      tokenExpiresAt: (tokenRow?.expires_at as string | null | undefined) ?? null,
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

type BitbucketRepoListItem = {
  uuid: string;
  name: string;
  slug?: string;
  is_private?: boolean;
  mainbranch?: { name?: string } | null;
  workspace?: { slug?: string };
};

/** Lists every repo in a Bitbucket workspace and upserts them under the CodeFerret org. */
async function syncBitbucketWorkspaceRepos(
  db: SupabaseClient,
  orgId: string,
  workspaceSlug: string,
  credential: string,
): Promise<number> {
  const auth = bitbucketAuthorizationHeader(credential);
  const repos = await listBitbucketReposForWorkspace(workspaceSlug, auth);

  let count = 0;
  for (const r of repos) {
    const { error } = await db.from("repos").upsert(
      {
        org_id: orgId,
        external_id: r.uuid,
        name: r.slug ?? r.name,
        owner: workspaceSlug,
        default_branch: r.mainbranch?.name ?? "main",
        is_private: r.is_private ?? true,
      },
      { onConflict: "org_id,external_id" },
    );
    if (error) throw new Error(`db: failed to upsert bitbucket repo ${r.slug ?? r.name}: ${error.message}`);
    count += 1;
  }
  return count;
}

async function listBitbucketReposForWorkspace(
  workspaceSlug: string,
  authorization: string,
): Promise<BitbucketRepoListItem[]> {
  const primary = await fetchBitbucketRepoPages(
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspaceSlug)}?pagelen=100&role=member`,
    authorization,
  );
  if (primary.length > 0) return primary;

  // Fallback: repos the token can access, filtered to this workspace.
  const allAccessible = await fetchBitbucketRepoPages(
    `https://api.bitbucket.org/2.0/repositories?pagelen=100&role=member`,
    authorization,
  );
  return allAccessible.filter((r) => (r.workspace?.slug ?? "").toLowerCase() === workspaceSlug.toLowerCase());
}

async function fetchBitbucketRepoPages(startUrl: string, authorization: string): Promise<BitbucketRepoListItem[]> {
  const out: BitbucketRepoListItem[] = [];
  let url: string | null = startUrl;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: authorization, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Bitbucket rejected the token (${res.status}). Private repos need read:repository:bitbucket. ` +
            `Personal API tokens require your real Atlassian account email. ` +
            body.slice(0, 200),
        );
      }
      throw new Error(`Bitbucket list repositories failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as { values?: BitbucketRepoListItem[]; next?: string };
    out.push(...(body.values ?? []));
    url = body.next ?? null;
  }

  return out;
}

async function getOrgIdByExternal(db: SupabaseClient, platform: string, externalId: string): Promise<string | null> {
  const { data } = await db.from("orgs").select("id").eq("platform", platform).eq("external_id", externalId).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * DESIGN.md §4: "cache [installation access tokens] in Postgres with expiry,
 * refresh at 50 min", §3/§13: encrypted at rest (AES-256-GCM). Returns null
 * on a cache miss/expiry/decrypt failure/unconfigured encryption key — the
 * caller falls back to minting a fresh token, so a broken cache never blocks
 * a review.
 */
export async function getCachedInstallationToken(db: SupabaseClient, platform: string, orgExternalId: string): Promise<string | null> {
  if (!encryptionConfigured()) return null;
  const orgId = await getOrgIdByExternal(db, platform, orgExternalId);
  if (!orgId) return null;

  const { data } = await db
    .from("platform_tokens")
    .select("encrypted_token, expires_at")
    .eq("org_id", orgId)
    .eq("platform", platform)
    .maybeSingle();
  if (!data?.expires_at || new Date(data.expires_at as string) <= new Date()) return null;

  try {
    return decryptToken(data.encrypted_token as string);
  } catch {
    return null; // corrupt cache row (e.g. ENCRYPTION_KEY rotated) — mint a fresh token instead of failing the run
  }
}

export async function cacheInstallationToken(
  db: SupabaseClient,
  platform: string,
  orgExternalId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  if (!encryptionConfigured()) return;
  const orgId = await getOrgIdByExternal(db, platform, orgExternalId);
  if (!orgId) return; // org not materialized yet — nothing to key the cache row on

  const { error } = await db
    .from("platform_tokens")
    .upsert(
      { org_id: orgId, platform, encrypted_token: encryptToken(token), expires_at: expiresAt.toISOString() },
      { onConflict: "org_id,platform" },
    );
  if (error) throw new Error(`db: failed to cache installation token: ${error.message}`);
}

// ------------------------------------------------------------- plan enforcement

export type OrgPlan = "free" | "pro" | "team";

export const FREE_SEAT_LIMIT = 1;

export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/**
 * Effective plan for enforcement. Reads `subscriptions` (the table the Razorpay webhook
 * actually keeps current — see routes/razorpayWebhook.ts) rather than the legacy `orgs.plan`
 * column, which nothing ever writes to. No row, or a non-active/trialing status (past_due,
 * canceled, incomplete, …), means the org is effectively on the free plan.
 */
export async function getOrgPlan(db: SupabaseClient, orgId: string): Promise<OrgPlan> {
  const { data } = await db.from("subscriptions").select("tier, status").eq("org_id", orgId).maybeSingle();
  if (!data || !ACTIVE_SUBSCRIPTION_STATUSES.has(data.status as string)) return "free";
  const tier = data.tier as string;
  return tier === "team" ? "team" : tier === "pro" ? "pro" : "free";
}

/** Seat limit for the org's effective plan — paid tiers use whatever seat count was purchased on the subscription. */
export async function getOrgSeatLimit(db: SupabaseClient, orgId: string): Promise<number> {
  const { data } = await db.from("subscriptions").select("seats, status").eq("org_id", orgId).maybeSingle();
  if (!data || !ACTIVE_SUBSCRIPTION_STATUSES.has(data.status as string)) return FREE_SEAT_LIMIT;
  return Math.max(FREE_SEAT_LIMIT, data.seats as number);
}

/** Whether a repo can be reviewed under the org's current plan — free plan is public-repos-only. */
export async function canReviewRepo(db: SupabaseClient, orgId: string, repoIsPrivate: boolean): Promise<boolean> {
  if (!repoIsPrivate) return true;
  const plan = await getOrgPlan(db, orgId);
  return plan !== "free";
}

export interface OrgUsage {
  plan: OrgPlan;
  seats: number;
  used: number;
  /** Monthly review allowance. `null` means unlimited (self-hosted). */
  quota: number | null;
  /** `null` when quota is unlimited. */
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
  /** Whether the org has hit its quota and further reviews should be hard-blocked. */
  blocked: boolean;
}

function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfNextMonthUtc(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
}

function monthlyQuotaFor(plan: OrgPlan, seats: number): number {
  const e = env();
  if (plan === "team") return e.TEAM_MONTHLY_REVIEWS_PER_SEAT * Math.max(1, seats);
  if (plan === "pro") return e.PRO_MONTHLY_REVIEWS_PER_SEAT * Math.max(1, seats);
  return e.FREE_MONTHLY_REVIEW_QUOTA;
}

/**
 * Reviews that actually ran this month, for this org — excludes runs blocked before any
 * LLM spend (private-repo gate, quota gate itself) via `blocked_reason IS NULL`, so a
 * blocked attempt never counts against the very quota that blocked it.
 */
async function countMonthlyReviews(db: SupabaseClient, orgId: string, periodStart: Date, periodEnd: Date): Promise<number> {
  const { data: repoRows } = await db.from("repos").select("id").eq("org_id", orgId);
  const repoIds = (repoRows ?? []).map((r) => r.id as string);
  if (repoIds.length === 0) return 0;

  const { data: prRows } = await db.from("pull_requests").select("id").in("repo_id", repoIds);
  const prIds = (prRows ?? []).map((p) => p.id as string);
  if (prIds.length === 0) return 0;

  const { data: runRows } = await db
    .from("review_runs")
    .select("status, llm_cost_usd")
    .in("pr_id", prIds)
    .is("blocked_reason", null)
    .gte("started_at", periodStart.toISOString())
    .lt("started_at", periodEnd.toISOString());

  // A run that failed with zero LLM spend (crashed before/without ever making a model
  // call — misconfiguration, a bug, a transient provider outage before the first request)
  // never actually cost anything and shouldn't consume the org's quota either — same
  // fairness principle as the blocked_reason exclusion above, just for failures that
  // happen after the gate instead of before it.
  return ((runRows ?? []) as { status: string; llm_cost_usd: number | null }[]).filter(
    (r) => r.status !== "failed" || Number(r.llm_cost_usd ?? 0) > 0,
  ).length;
}

/** Shared wording so the synchronous API 402 and the async job-level block never drift apart. */
export function formatUsageLimitMessage(usage: OrgUsage): string {
  return `Your plan's monthly review limit has been reached (${usage.used}/${usage.quota} reviews used). Upgrade in Settings to increase this limit, or wait until ${usage.periodEnd.slice(0, 10)}.`;
}

/**
 * Monthly AI-review usage against the org's plan quota (DESIGN.md pricing — hard-block
 * once exceeded). Self-hosted deployments (SELF_HOSTED=true) are always unlimited: that
 * org brings its own LLM keys/infra, so there's no shared cost for CodeFerret to protect.
 */
export async function getOrgUsage(db: SupabaseClient, orgId: string): Promise<OrgUsage> {
  const [plan, seats] = await Promise.all([getOrgPlan(db, orgId), getOrgSeatLimit(db, orgId)]);
  const periodStart = startOfMonthUtc();
  const periodEnd = startOfNextMonthUtc(periodStart);
  const used = await countMonthlyReviews(db, orgId, periodStart, periodEnd);

  if (env().SELF_HOSTED) {
    return {
      plan,
      seats,
      used,
      quota: null,
      remaining: null,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      blocked: false,
    };
  }

  const quota = monthlyQuotaFor(plan, seats);
  return {
    plan,
    seats,
    used,
    quota,
    remaining: Math.max(0, quota - used),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    blocked: used >= quota,
  };
}

/**
 * The org owner's email, for review-completion notifications (jobs/reviewRun.ts) — the
 * one stable, well-defined recipient for a per-review email regardless of how the run
 * was triggered. Null (not thrown) whenever there's no usable recipient: no owner row,
 * or an owner who hasn't signed in since email capture was added (auth/verifyUser.ts) —
 * a missing notification recipient must never fail the review itself.
 */
export async function getOrgOwnerEmail(db: SupabaseClient, orgId: string): Promise<{ email: string; handle: string | null } | null> {
  const { data } = await db
    .from("org_members")
    .select("users(email, handle)")
    .eq("org_id", orgId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  const user = data?.users as unknown as { email: string | null; handle: string | null } | null | undefined;
  if (!user?.email) return null;
  return { email: user.email, handle: user.handle };
}
