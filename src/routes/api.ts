import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { getAdapter } from "../adapters/index.js";
import { requireAuth } from "../auth/plugin.js";
import {
  claimInstalledOrgs,
  ensureOrgAccess,
  getOrgRole,
  getPrimaryOrgId,
  listUserOrgs,
  roleAtLeast,
  type AuthedUser,
  type OrgRole,
} from "../auth/verifyUser.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  connectBitbucketWorkspace,
  formatUsageLimitMessage,
  getFindingOrgContext,
  getOrgPlan,
  getOrgSeatLimit,
  getOrgUsage,
  getPrRefByRunId,
  getRepoConfig,
  getRepoOrgId,
  getRepoRefByName,
  getRunOrgId,
  recordAudit,
  upsertPrChain,
} from "../db/repositories.js";
import { encryptionConfigured } from "../security/tokenCrypto.js";
import { buildPrDiff } from "../engine/diff.js";
import { enqueueIndexRepo, enqueueReviewRunNow, enqueueRulebookCompile } from "../queue/index.js";
import { buildWeeklyAnalytics, categoryCounts } from "./analyticsAggregation.js";
import { env } from "../config.js";
import { emailConfigured, sendEmail } from "../email/smtp.js";
import { inviteEmail } from "../email/templates.js";

const RepoConfigSchema = z.object({
  strictness: z.enum(["chill", "standard", "strict"]),
  commentBudget: z.number().int().min(3).max(15),
  ignoredPaths: z.array(z.string()),
  failOnCritical: z.boolean(),
});

const RuleCreateSchema = z.object({
  ruleText: z.string().min(1),
  category: z.string().min(1),
  repoName: z.string().nullable(),
});

const RuleActiveSchema = z.object({ active: z.boolean() });

const TriggerReviewSchema = z.object({
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  trigger: z.enum(["automatic", "manual"]),
  /** which of the user's orgs this repo belongs to — required once a user has more than one. */
  orgId: z.string().uuid().optional(),
});

const OnboardingFinishSchema = z.object({
  repoIds: z.array(z.string()).min(1),
  preset: z.enum(["chill", "standard", "strict"]),
});

const FeedbackSchema = z.object({
  feedback: z.enum(["accepted", "dismissed", "fixed", "ignored"]),
});

const InviteCreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});

const CheckoutSchema = z.object({
  tier: z.enum(["pro", "team"]),
});

const BitbucketConnectSchema = z.object({
  workspaceSlug: z.string().min(1),
  workspaceName: z.string().min(1),
  /** A Bitbucket Workspace Access Token (Repository/Project/Workspace admin settings) — not an OAuth flow, mirroring how self-hosted GitHub Apps are configured with a static credential. */
  accessToken: z.string().min(1),
});

const PRESET_CONFIG: Record<string, { commentBudget: number; failOnCritical: boolean }> = {
  chill: { commentBudget: 3, failOnCritical: false },
  standard: { commentBudget: 7, failOnCritical: false },
  strict: { commentBudget: 15, failOnCritical: true },
};

/** A human-readable actor for the audit log — prefers the GitHub handle, falls back to email, then the internal id. */
function actorLabel(user: AuthedUser): string {
  return user.githubLogin ?? user.email ?? user.id;
}

/** membership (with auto-linking via ensureOrgAccess) + a minimum role bar. */
async function requireRole(
  db: SupabaseClient,
  user: AuthedUser,
  orgId: string,
  minimum: OrgRole,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!(await ensureOrgAccess(db, user, orgId))) return { ok: false, status: 403, error: "not a member of this org" };
  const role = await getOrgRole(db, user.id, orgId);
  if (!roleAtLeast(role, minimum)) return { ok: false, status: 403, error: `requires ${minimum} role or higher` };
  return { ok: true };
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // ------------------------------------------------------------------- orgs

  app.get("/api/orgs", async (req, reply) => {
    const db = getDb();
    await claimInstalledOrgs(db, req.authedUser!);
    const orgs = await listUserOrgs(db, req.authedUser!.id);
    return reply.send({ orgs });
  });

  // ------------------------------------------------------------- bitbucket

  app.post<{ Body: unknown }>("/api/bitbucket/connect", async (req, reply) => {
    if (!encryptionConfigured()) {
      return reply.code(501).send({ error: "ENCRYPTION_KEY is not configured on this deployment — Bitbucket tokens cannot be stored" });
    }
    const parsed = BitbucketConnectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { orgId } = await connectBitbucketWorkspace(db, parsed.data, req.authedUser!.id);
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "bitbucket.connected", parsed.data.workspaceSlug);
    return reply.send({ orgId });
  });

  // ---------------------------------------------------------------- analytics

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>("/api/orgs/:id/analytics", async (req, reply) => {
    const db = getDb();
    const { id: orgId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });
    if ((await getOrgPlan(db, orgId)) !== "team") {
      return reply.code(402).send({ error: "team_plan_required", message: "Analytics dashboards are a Team-plan feature. Upgrade to unlock them." });
    }

    const weeksBack = Math.max(1, Math.min(52, parseInt((req.query.range ?? "12w").replace(/\D/g, ""), 10) || 12));
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - weeksBack * 7);

    const { data: repos } = await db.from("repos").select("id").eq("org_id", orgId);
    const repoIds = (repos ?? []).map((r) => r.id as string);
    if (repoIds.length === 0) return reply.send({ weekly: [], categories: [] });

    const { data: prs } = await db.from("pull_requests").select("id").in("repo_id", repoIds);
    const prIds = (prs ?? []).map((p) => p.id as string);
    if (prIds.length === 0) return reply.send({ weekly: [], categories: [] });

    const { data: runs } = await db
      .from("review_runs")
      .select("id, started_at, posted, latency_ms")
      .in("pr_id", prIds)
      .eq("status", "completed")
      .gte("started_at", since.toISOString());
    const runRows = runs ?? [];
    const runIds = runRows.map((r) => r.id as string);

    const { data: findings } =
      runIds.length > 0
        ? await db.from("findings").select("category, feedback, created_at").in("run_id", runIds)
        : { data: [] as { category: string; feedback: string | null; created_at: string }[] };
    const findingRows = findings ?? [];

    const weekly = buildWeeklyAnalytics(
      runRows.map((r) => ({ startedAt: r.started_at as string, posted: r.posted as number, latencyMs: r.latency_ms as number | null })),
      findingRows.map((f) => ({ createdAt: f.created_at as string, feedback: f.feedback as string | null })),
      weeksBack,
    );
    const categories = categoryCounts(findingRows.map((f) => ({ category: f.category as string })));

    return reply.send({ weekly, categories });
  });

  // -------------------------------------------------------------------- health

  app.get<{ Params: { id: string } }>("/api/repos/:id/health", async (req, reply) => {
    const db = getDb();
    const { id: repoId } = req.params;
    const orgId = await getRepoOrgId(db, repoId);
    if (!orgId) return reply.code(404).send({ error: "repo not found" });
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });
    if ((await getOrgPlan(db, orgId)) !== "team") {
      return reply.code(402).send({ error: "team_plan_required", message: "Repo health reports are a Team-plan feature. Upgrade to unlock them." });
    }

    const { data: snapshots } = await db
      .from("health_snapshots")
      .select("week, metrics")
      .eq("repo_id", repoId)
      .order("week", { ascending: true });

    const { data: prs } = await db.from("pull_requests").select("id").eq("repo_id", repoId);
    const prIds = (prs ?? []).map((p) => p.id as string);
    let recurring: { category: string; count: number }[] = [];
    if (prIds.length > 0) {
      const { data: runs } = await db.from("review_runs").select("id").in("pr_id", prIds).order("started_at", { ascending: false }).limit(20);
      const runIds = (runs ?? []).map((r) => r.id as string);
      if (runIds.length > 0) {
        const { data: findings } = await db.from("findings").select("category").in("run_id", runIds);
        recurring = categoryCounts((findings ?? []).map((f) => ({ category: f.category as string })), 6);
      }
    }

    const snapshotPoints = (snapshots ?? []).map((s) => {
      const metrics = (s.metrics ?? {}) as { riskScore?: number; untestedPct?: number };
      const week = new Date(s.week as string).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      return { week, riskScore: metrics.riskScore ?? 0, untestedPct: metrics.untestedPct ?? 0 };
    });

    return reply.send({ snapshots: snapshotPoints, recurring });
  });

  // ---------------------------------------------------------------------- audit

  // Usage tracking — every plan can see its own monthly review usage (not Team-gated
  // like analytics/health/audit above, since the whole point is to show Free/Pro orgs
  // where they stand against their quota too).
  app.get<{ Params: { id: string } }>("/api/orgs/:id/usage", async (req, reply) => {
    const db = getDb();
    const { id: orgId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const usage = await getOrgUsage(db, orgId);
    return reply.send(usage);
  });

  app.get<{ Params: { id: string } }>("/api/orgs/:id/audit", async (req, reply) => {
    const db = getDb();
    const { id: orgId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });
    if ((await getOrgPlan(db, orgId)) !== "team") {
      return reply.code(402).send({ error: "team_plan_required", message: "The audit log is a Team-plan feature. Upgrade to unlock it." });
    }

    const { data: entries, error } = await db
      .from("audit_log")
      .select("id, actor, action, target, meta, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send({ entries: entries ?? [] });
  });

  // --------------------------------------------------------------------- diff

  app.get<{ Params: { id: string } }>("/api/runs/:id/diff", async (req, reply) => {
    const db = getDb();
    const { id: runId } = req.params;
    const ctx = await getRunOrgId(db, runId);
    if (!ctx) return reply.code(404).send({ error: "run not found" });
    if (!(await ensureOrgAccess(db, req.authedUser!, ctx.orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const { pr } = await getPrRefByRunId(db, runId);
    const adapter = getAdapter(pr.repo.platform);
    const [diffText, info] = await Promise.all([adapter.getDiff(pr), adapter.getPrInfo(pr)]);
    const prDiff = buildPrDiff({ baseSha: info.baseSha, headSha: info.headSha, diffText });
    return reply.send(prDiff);
  });

  // ------------------------------------------------------------------- rerun

  app.post<{ Params: { id: string } }>("/api/runs/:id/rerun", async (req, reply) => {
    const db = getDb();
    const { id: sourceRunId } = req.params;
    const ctx = await getRunOrgId(db, sourceRunId);
    if (!ctx) return reply.code(404).send({ error: "run not found" });
    if (!(await ensureOrgAccess(db, req.authedUser!, ctx.orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const usage = await getOrgUsage(db, ctx.orgId);
    if (usage.blocked) {
      return reply.code(402).send({ error: "usage_limit_exceeded", message: formatUsageLimitMessage(usage) });
    }

    const { getOrgSuspension } = await import("../db/adminRepositories.js");
    const suspension = await getOrgSuspension(db, ctx.orgId);
    if (suspension.suspended) {
      return reply.code(403).send({
        error: "org_suspended",
        message: suspension.suspendedReason
          ? `This organization is suspended: ${suspension.suspendedReason}`
          : "This organization is suspended. Contact support.",
      });
    }

    const { pr, headSha } = await getPrRefByRunId(db, sourceRunId);

    const { data: newRun, error } = await db
      .from("review_runs")
      .insert({ pr_id: ctx.prId, head_sha: headSha, status: "queued", trigger: "manual", source_run_id: sourceRunId })
      .select("id")
      .single();
    if (error || !newRun) return reply.code(500).send({ error: `failed to create run: ${error?.message ?? ""}` });

    await enqueueReviewRunNow({ pr, headSha, reason: "rerun", runId: newRun.id as string, sourceRunId });
    await recordAudit(db, ctx.orgId, actorLabel(req.authedUser!), "run.retriggered", `${pr.repo.owner}/${pr.repo.name}#${pr.number}`);
    return reply.send({ id: newRun.id });
  });

  // ------------------------------------------------------------------ trigger

  app.post<{ Body: unknown }>("/api/reviews/trigger", async (req, reply) => {
    const parsed = TriggerReviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { repo: repoName, prNumber } = parsed.data;

    const db = getDb();
    const orgId = parsed.data.orgId ?? (await getPrimaryOrgId(db, req.authedUser!));
    if (!orgId) return reply.code(404).send({ error: "no organization found for this account yet — install the app first" });
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const usage = await getOrgUsage(db, orgId);
    if (usage.blocked) {
      return reply.code(402).send({ error: "usage_limit_exceeded", message: formatUsageLimitMessage(usage) });
    }

    const { getOrgSuspension } = await import("../db/adminRepositories.js");
    const suspension = await getOrgSuspension(db, orgId);
    if (suspension.suspended) {
      return reply.code(403).send({
        error: "org_suspended",
        message: suspension.suspendedReason
          ? `This organization is suspended: ${suspension.suspendedReason}`
          : "This organization is suspended. Contact support.",
      });
    }

    const found = await getRepoRefByName(db, orgId, repoName);
    if (!found) return reply.code(404).send({ error: `repo "${repoName}" not found in your org` });

    const adapter = getAdapter(found.repo.platform);
    const prStub = { repo: found.repo, number: prNumber };
    const info = await adapter.getPrInfo(prStub);
    const pr = { ...prStub, title: info.title, author: info.author };

    const { prId } = await upsertPrChain(db, pr, info.headSha);
    const { data: newRun, error } = await db
      .from("review_runs")
      .insert({ pr_id: prId, head_sha: info.headSha, status: "queued", trigger: "manual" })
      .select("id")
      .single();
    if (error || !newRun) return reply.code(500).send({ error: `failed to create run: ${error?.message ?? ""}` });

    await enqueueReviewRunNow({ pr, headSha: info.headSha, reason: "manual", runId: newRun.id as string });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "review.triggered", `${repoName}#${prNumber}`);
    return reply.send({ id: newRun.id });
  });

  // ------------------------------------------------------------ repo config

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/repos/:id/config", async (req, reply) => {
    const parsed = RepoConfigSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: repoId } = req.params;
    const orgId = await getRepoOrgId(db, repoId);
    if (!orgId) return reply.code(404).send({ error: "repo not found" });
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const existing = await getRepoConfig(db, repoId);
    const { error } = await db.from("repos").update({ config: { ...existing, ...parsed.data } }).eq("id", repoId);
    if (error) return reply.code(500).send({ error: error.message });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "repo.config_changed", repoId, parsed.data);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/api/repos/:id/reindex", async (req, reply) => {
    const db = getDb();
    const { id: repoId } = req.params;
    const orgId = await getRepoOrgId(db, repoId);
    if (!orgId) return reply.code(404).send({ error: "repo not found" });
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    await enqueueIndexRepo({ repoId, reason: "manual" });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "repo.reindex_triggered", repoId);
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------- rulebook

  app.post<{ Params: { id: string }; Body: unknown }>("/api/orgs/:id/rulebook", async (req, reply) => {
    const parsed = RuleCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: orgId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    let repoId: string | null = null;
    if (parsed.data.repoName) {
      const found = await getRepoRefByName(db, orgId, parsed.data.repoName);
      if (!found) return reply.code(404).send({ error: `repo "${parsed.data.repoName}" not found` });
      repoId = found.repoId;
    }

    const { error } = await db.from("rulebook_rules").insert({
      org_id: orgId,
      repo_id: repoId,
      source: "manual",
      rule_text: parsed.data.ruleText,
      category: parsed.data.category,
      weight: 1,
      active: true,
      evidence_count: 0,
    });
    if (error) return reply.code(500).send({ error: error.message });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "rule.created", parsed.data.ruleText.slice(0, 120));
    return reply.send({ ok: true });
  });

  app.patch<{ Params: { id: string; ruleId: string }; Body: unknown }>("/api/orgs/:id/rulebook/:ruleId", async (req, reply) => {
    const parsed = RuleActiveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: orgId, ruleId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const { error } = await db.from("rulebook_rules").update({ active: parsed.data.active }).eq("id", ruleId).eq("org_id", orgId);
    if (error) return reply.code(500).send({ error: error.message });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), parsed.data.active ? "rule.activated" : "rule.deactivated", ruleId);
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string; ruleId: string } }>("/api/orgs/:id/rulebook/:ruleId", async (req, reply) => {
    const db = getDb();
    const { id: orgId, ruleId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const { error } = await db.from("rulebook_rules").delete().eq("id", ruleId).eq("org_id", orgId);
    if (error) return reply.code(500).send({ error: error.message });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "rule.deleted", ruleId);
    return reply.send({ ok: true });
  });

  // ----------------------------------------------------------- members/invites

  app.get<{ Params: { id: string } }>("/api/orgs/:id/members", async (req, reply) => {
    const db = getDb();
    const { id: orgId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const { data: members } = await db.from("org_members").select("role, users(id, handle, seat_active)").eq("org_id", orgId);
    const { data: invites } = await db
      .from("org_invites")
      .select("id, email, role, status, created_at, expires_at")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    return reply.send({ members: members ?? [], invites: invites ?? [] });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/orgs/:id/invites", async (req, reply) => {
    const parsed = InviteCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: orgId } = req.params;
    const authz = await requireRole(db, req.authedUser!, orgId, "admin");
    if (!authz.ok) return reply.code(authz.status).send({ error: authz.error });

    const { data: org } = await db.from("orgs").select("kind, name").eq("id", orgId).maybeSingle();
    if (org?.kind === "individual") {
      return reply.code(400).send({ error: "this is a personal account — invites are only available on team orgs" });
    }

    const [seatLimit, { count: memberCount }, { count: pendingInviteCount }] = await Promise.all([
      getOrgSeatLimit(db, orgId),
      db.from("org_members").select("*", { count: "exact", head: true }).eq("org_id", orgId),
      db.from("org_invites").select("*", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "pending"),
    ]);
    const seatsInUse = (memberCount ?? 0) + (pendingInviteCount ?? 0);
    if (seatsInUse >= seatLimit) {
      return reply.code(402).send({
        error: "seat_limit_reached",
        message: `This plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"}, all in use. Upgrade to invite more teammates.`,
      });
    }

    const { data: invite, error } = await db
      .from("org_invites")
      .insert({ org_id: orgId, email: parsed.data.email.toLowerCase(), role: parsed.data.role, invited_by: req.authedUser!.id })
      .select("id, email, role, token, expires_at")
      .single();
    if (error || !invite) return reply.code(500).send({ error: error?.message ?? "failed to create invite" });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "member.invited", parsed.data.email);

    // Best-effort: the invite is already created and valid either way. When no email
    // provider or FRONTEND_URL is configured, the web app falls back to showing a
    // copyable link built from this same token — that path is never blocked by this.
    let emailSent = false;
    const frontendUrl = env().FRONTEND_URL;
    if (emailConfigured() && frontendUrl) {
      const acceptUrl = `${frontendUrl.replace(/\/+$/, "")}/invite/${invite.token as string}`;
      const content = inviteEmail({
        orgName: (org?.name as string | undefined) ?? "your team",
        inviterLabel: actorLabel(req.authedUser!),
        role: invite.role as string,
        acceptUrl,
      });
      const result = await sendEmail({ to: invite.email as string, ...content });
      emailSent = result.sent;
      if (!result.sent) console.warn(`[invites] email send failed for ${invite.email as string}: ${result.error}`);
    }

    return reply.send({ invite, emailSent });
  });

  app.delete<{ Params: { id: string; inviteId: string } }>("/api/orgs/:id/invites/:inviteId", async (req, reply) => {
    const db = getDb();
    const { id: orgId, inviteId } = req.params;
    const authz = await requireRole(db, req.authedUser!, orgId, "admin");
    if (!authz.ok) return reply.code(authz.status).send({ error: authz.error });

    const { error } = await db.from("org_invites").update({ status: "revoked" }).eq("id", inviteId).eq("org_id", orgId);
    if (error) return reply.code(500).send({ error: error.message });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "invite.revoked", inviteId);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { token: string } }>("/api/invites/:token/accept", async (req, reply) => {
    const db = getDb();
    const user = req.authedUser!;
    const { token } = req.params;

    const { data: invite } = await db
      .from("org_invites")
      .select("id, org_id, email, role, status, expires_at")
      .eq("token", token)
      .maybeSingle();
    if (!invite) return reply.code(404).send({ error: "invite not found" });
    if (invite.status !== "pending") return reply.code(400).send({ error: `invite already ${invite.status}` });
    if (new Date(invite.expires_at as string) < new Date()) return reply.code(400).send({ error: "invite has expired" });
    if (!user.email || (invite.email as string).toLowerCase() !== user.email.toLowerCase()) {
      return reply.code(403).send({ error: `this invite was sent to ${invite.email} — sign in with that email to accept it` });
    }

    const { error: memberError } = await db
      .from("org_members")
      .insert({ org_id: invite.org_id, user_id: user.id, role: invite.role as string });
    if (memberError && memberError.code !== "23505") return reply.code(500).send({ error: memberError.message });
    await db.from("org_invites").update({ status: "accepted" }).eq("id", invite.id);
    await recordAudit(db, invite.org_id as string, actorLabel(user), "member.joined", actorLabel(user));

    return reply.send({ ok: true, orgId: invite.org_id });
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/orgs/:id/members/:userId", async (req, reply) => {
    const db = getDb();
    const { id: orgId, userId } = req.params;
    const authz = await requireRole(db, req.authedUser!, orgId, "owner");
    if (!authz.ok) return reply.code(authz.status).send({ error: authz.error });

    if (userId === req.authedUser!.id) {
      const { count } = await db.from("org_members").select("*", { count: "exact", head: true }).eq("org_id", orgId).eq("role", "owner");
      if ((count ?? 0) <= 1) return reply.code(400).send({ error: "can't remove the last owner — transfer ownership first" });
    }

    const { error } = await db.from("org_members").delete().eq("org_id", orgId).eq("user_id", userId);
    if (error) return reply.code(500).send({ error: error.message });
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "member.removed", userId);
    return reply.send({ ok: true });
  });

  // --------------------------------------------------------------- billing
  //
  // Razorpay has no direct equivalent to Stripe's hosted Customer Portal — there's no
  // self-serve product for "update payment method / see invoices" the way Stripe offers
  // it. What Razorpay's Subscriptions API *does* support directly: creating a subscription
  // (returns a short_url — a hosted authorization page, the actual checkout-redirect
  // equivalent), cancelling one, and changing its plan. So "portal" becomes two explicit
  // actions below (cancel, change-plan) instead of one opaque redirect.

  /** Razorpay requires a finite total_count (no "until cancelled" option) — 10 years of monthly cycles is effectively open-ended for a SaaS subscription while staying within the API's bounds. */
  const RAZORPAY_TOTAL_MONTHLY_CYCLES = 120;

  app.post<{ Params: { id: string }; Body: unknown }>("/api/orgs/:id/billing/checkout", async (req, reply) => {
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: orgId } = req.params;
    const authz = await requireRole(db, req.authedUser!, orgId, "owner");
    if (!authz.ok) return reply.code(authz.status).send({ error: authz.error });

    const keyId = process.env["RAZORPAY_KEY_ID"];
    const keySecret = process.env["RAZORPAY_KEY_SECRET"];
    if (!keyId || !keySecret) return reply.code(501).send({ error: "Razorpay is not configured on this deployment yet" });
    const planId = parsed.data.tier === "team" ? process.env["RAZORPAY_PLAN_TEAM"] : process.env["RAZORPAY_PLAN_PRO"];
    if (!planId) return reply.code(501).send({ error: `No Razorpay plan configured for the ${parsed.data.tier} tier` });

    const { default: Razorpay } = await import("razorpay");
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: RAZORPAY_TOTAL_MONTHLY_CYCLES,
      customer_notify: 1,
      notes: { org_id: orgId, tier: parsed.data.tier },
    });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "billing.checkout_started", parsed.data.tier);
    return reply.send({ url: subscription.short_url });
  });

  app.post<{ Params: { id: string } }>("/api/orgs/:id/billing/cancel", async (req, reply) => {
    const db = getDb();
    const { id: orgId } = req.params;
    const authz = await requireRole(db, req.authedUser!, orgId, "owner");
    if (!authz.ok) return reply.code(authz.status).send({ error: authz.error });

    const { cancelOrgSubscription } = await import("../billing/razorpaySubscriptions.js");
    const result = await cancelOrgSubscription(db, orgId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "billing.cancel_requested", result.razorpaySubId);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/orgs/:id/billing/change-plan", async (req, reply) => {
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: orgId } = req.params;
    const authz = await requireRole(db, req.authedUser!, orgId, "owner");
    if (!authz.ok) return reply.code(authz.status).send({ error: authz.error });

    const { changeOrgSubscriptionPlan } = await import("../billing/razorpaySubscriptions.js");
    const result = await changeOrgSubscriptionPlan(db, orgId, parsed.data.tier);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "billing.plan_changed", parsed.data.tier);
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------------ onboarding

  app.post<{ Params: { id: string }; Body: unknown }>("/api/orgs/:id/onboarding", async (req, reply) => {
    const parsed = OnboardingFinishSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: orgId } = req.params;
    if (!(await ensureOrgAccess(db, req.authedUser!, orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const preset = PRESET_CONFIG[parsed.data.preset]!;
    for (const repoId of parsed.data.repoIds) {
      const existing = await getRepoConfig(db, repoId);
      await db
        .from("repos")
        .update({ config: { ...existing, strictness: parsed.data.preset, ...preset } })
        .eq("id", repoId)
        .eq("org_id", orgId);
    }
    await db.from("orgs").update({ settings: { onboarded: true } }).eq("id", orgId);
    await recordAudit(db, orgId, actorLabel(req.authedUser!), "onboarding.completed", parsed.data.preset, { repoCount: parsed.data.repoIds.length });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------- feedback

  app.post<{ Params: { id: string }; Body: unknown }>("/api/findings/:id/feedback", async (req, reply) => {
    const parsed = FeedbackSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { id: findingId } = req.params;
    const ctx = await getFindingOrgContext(db, findingId);
    if (!ctx) return reply.code(404).send({ error: "finding not found" });
    if (!(await ensureOrgAccess(db, req.authedUser!, ctx.orgId))) return reply.code(403).send({ error: "not a member of this org" });

    const { error } = await db.from("findings").update({ feedback: parsed.data.feedback }).eq("id", findingId);
    if (error) return reply.code(500).send({ error: error.message });

    await db.from("learning_events").insert({
      org_id: ctx.orgId,
      repo_id: ctx.repoId,
      finding_id: findingId,
      event_type: parsed.data.feedback,
    });

    if (parsed.data.feedback === "dismissed" || parsed.data.feedback === "ignored") {
      await enqueueRulebookCompile({ orgId: ctx.orgId, repoId: ctx.repoId }).catch(() => undefined);
    }

    return reply.send({ ok: true });
  });
}
