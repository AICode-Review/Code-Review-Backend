import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_SUBSCRIPTION_STATUSES, getOrgUsage, type OrgPlan, type OrgUsage } from "./repositories.js";

/**
 * Cross-org queries for the platform admin console (routes/admin.ts). Deliberately kept
 * separate from repositories.ts: every function there is org-scoped by design (mirrors RLS,
 * takes an orgId the caller has already been authorized against); everything here reads
 * across every org on purpose and must only ever be reached through requireAdmin-gated
 * routes. Multi-hop relations (run -> pr -> repo -> org, user -> org_members -> org) are
 * resolved with separate flat queries + in-memory maps rather than PostgREST embeds, both
 * to keep cardinality unambiguous and to stay within what the shared fakeSupabase test
 * double (testUtils/fakeSupabase.ts) actually supports.
 */

const TIER_PRICE_USD: Record<string, number> = { pro: 15, team: 25 };

function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function startOfNextMonthUtc(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
}

export interface PlatformOverview {
  totalOrgs: number;
  totalUsers: number;
  subscriptionsByTier: { tier: string; count: number }[];
  mrrUsd: number;
  reviewsThisMonth: number;
  llmSpendThisMonthUsd: number;
  anthropicSpendThisMonthUsd: number;
  openaiSpendThisMonthUsd: number;
  periodStart: string;
  periodEnd: string;
}

export async function getPlatformOverview(db: SupabaseClient): Promise<PlatformOverview> {
  const periodStart = startOfMonthUtc();
  const periodEnd = startOfNextMonthUtc(periodStart);

  const [orgsCount, usersCount, subsResult, reviewsCount, costResult] = await Promise.all([
    db.from("orgs").select("id", { count: "exact", head: true }),
    db.from("users").select("id", { count: "exact", head: true }),
    db.from("subscriptions").select("tier, seats, status").in("status", [...ACTIVE_SUBSCRIPTION_STATUSES]),
    db
      .from("review_runs")
      .select("id", { count: "exact", head: true })
      .is("blocked_reason", null)
      .gte("started_at", periodStart.toISOString())
      .lt("started_at", periodEnd.toISOString()),
    db
      .from("review_runs")
      .select("llm_cost_usd, anthropic_cost_usd, openai_cost_usd")
      .gte("started_at", periodStart.toISOString())
      .lt("started_at", periodEnd.toISOString()),
  ]);

  const activeSubs = (subsResult.data ?? []) as { tier: string; seats: number }[];
  const tierCounts = new Map<string, number>();
  let mrrUsd = 0;
  for (const s of activeSubs) {
    tierCounts.set(s.tier, (tierCounts.get(s.tier) ?? 0) + 1);
    const price = TIER_PRICE_USD[s.tier];
    if (price) mrrUsd += price * Math.max(1, s.seats);
  }

  type CostRow = { llm_cost_usd: number; anthropic_cost_usd: number | null; openai_cost_usd: number | null };
  const costRows = (costResult.data ?? []) as CostRow[];
  let llmSpendThisMonthUsd = 0;
  let anthropicSpendThisMonthUsd = 0;
  let openaiSpendThisMonthUsd = 0;
  for (const r of costRows) {
    llmSpendThisMonthUsd += r.llm_cost_usd ?? 0;
    anthropicSpendThisMonthUsd += r.anthropic_cost_usd ?? 0;
    openaiSpendThisMonthUsd += r.openai_cost_usd ?? 0;
  }

  return {
    totalOrgs: orgsCount.count ?? 0,
    totalUsers: usersCount.count ?? 0,
    subscriptionsByTier: [...tierCounts.entries()].map(([tier, count]) => ({ tier, count })),
    mrrUsd,
    reviewsThisMonth: reviewsCount.count ?? 0,
    llmSpendThisMonthUsd,
    anthropicSpendThisMonthUsd,
    openaiSpendThisMonthUsd,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

export interface AdminOrgSummary {
  id: string;
  name: string;
  kind: "individual" | "team";
  platform: "github" | "bitbucket";
  plan: OrgPlan;
  seats: number;
  createdAt: string;
  subscriptionStatus: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
}

type OrgRow = {
  id: string;
  name: string;
  kind: "individual" | "team";
  platform: "github" | "bitbucket";
  seats: number;
  created_at: string;
  suspended_at: string | null;
  suspended_reason: string | null;
};
type SubRow = { org_id: string; tier: string; status: string; seats: number };

function tierToPlan(tier: string): OrgPlan {
  return tier === "team" ? "team" : tier === "pro" ? "pro" : "free";
}

function summarizeOrg(o: OrgRow, sub: SubRow | undefined): AdminOrgSummary {
  const active = sub !== undefined && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status);
  return {
    id: o.id,
    name: o.name,
    kind: o.kind,
    platform: o.platform,
    plan: active ? tierToPlan(sub!.tier) : "free",
    seats: active ? sub!.seats : o.seats,
    createdAt: o.created_at,
    subscriptionStatus: sub?.status ?? null,
    suspendedAt: o.suspended_at,
    suspendedReason: o.suspended_reason,
  };
}

const ORG_SELECT = "id, name, kind, platform, seats, created_at, suspended_at, suspended_reason";

export async function listOrgsAdmin(db: SupabaseClient): Promise<AdminOrgSummary[]> {
  const [{ data: orgs }, { data: subs }] = await Promise.all([
    db.from("orgs").select(ORG_SELECT).order("created_at", { ascending: false }),
    db.from("subscriptions").select("org_id, tier, status, seats"),
  ]);
  const subByOrg = new Map(((subs ?? []) as SubRow[]).map((s) => [s.org_id, s]));
  return ((orgs ?? []) as OrgRow[]).map((o) => summarizeOrg(o, subByOrg.get(o.id)));
}

export interface AdminRunSummary {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  candidates: number;
  verified: number;
  posted: number;
  digest: number;
  llmCostUsd: number;
  anthropicCostUsd: number;
  openaiCostUsd: number;
  latencyMs: number | null;
  error: string | null;
  prNumber?: number;
  repoName?: string;
  orgName?: string;
}

type RunRow = {
  id: string;
  pr_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  candidates: number;
  verified: number;
  posted: number;
  digest: number;
  llm_cost_usd: number;
  anthropic_cost_usd: number | null;
  openai_cost_usd: number | null;
  latency_ms: number | null;
  error: string | null;
};
type PrRow = { id: string; number: number; repo_id: string };
type RepoRow = { id: string; name: string; org_id: string };

function summarizeRun(r: RunRow, pr: PrRow | undefined, repo: RepoRow | undefined, orgName: string | undefined): AdminRunSummary {
  return {
    id: r.id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    candidates: r.candidates,
    verified: r.verified,
    posted: r.posted,
    digest: r.digest,
    llmCostUsd: r.llm_cost_usd,
    anthropicCostUsd: r.anthropic_cost_usd ?? 0,
    openaiCostUsd: r.openai_cost_usd ?? 0,
    latencyMs: r.latency_ms,
    error: r.error,
    prNumber: pr?.number,
    repoName: repo?.name,
    orgName,
  };
}

const RUN_SELECT =
  "id, pr_id, status, started_at, finished_at, candidates, verified, posted, digest, llm_cost_usd, anthropic_cost_usd, openai_cost_usd, latency_ms, error";

/** Resolves pr -> repo -> org context for a batch of runs via separate flat queries (see file-level note). */
async function attachRunContext(db: SupabaseClient, runs: RunRow[]): Promise<AdminRunSummary[]> {
  if (runs.length === 0) return [];
  const prIds = [...new Set(runs.map((r) => r.pr_id))];
  const { data: prRows } = await db.from("pull_requests").select("id, number, repo_id").in("id", prIds);
  const prs = (prRows ?? []) as PrRow[];
  const repoIds = [...new Set(prs.map((p) => p.repo_id))];
  const { data: repoRows } = repoIds.length ? await db.from("repos").select("id, name, org_id").in("id", repoIds) : { data: [] };
  const repos = (repoRows ?? []) as RepoRow[];
  const orgIds = [...new Set(repos.map((r) => r.org_id))];
  const { data: orgRows } = orgIds.length ? await db.from("orgs").select("id, name").in("id", orgIds) : { data: [] };
  const orgNameById = new Map(((orgRows ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));

  const prById = new Map(prs.map((p) => [p.id, p]));
  const repoById = new Map(repos.map((r) => [r.id, r]));

  return runs.map((r) => {
    const pr = prById.get(r.pr_id);
    const repo = pr ? repoById.get(pr.repo_id) : undefined;
    return summarizeRun(r, pr, repo, repo ? orgNameById.get(repo.org_id) : undefined);
  });
}

export interface AdminOrgDetail extends AdminOrgSummary {
  members: { userId: string; email: string | null; handle: string | null; role: string }[];
  repos: { id: string; name: string; indexStatus: string }[];
  usage: OrgUsage;
  recentRuns: AdminRunSummary[];
}

export async function getOrgAdminDetail(db: SupabaseClient, orgId: string): Promise<AdminOrgDetail | null> {
  const { data: orgData } = await db.from("orgs").select(ORG_SELECT).eq("id", orgId).maybeSingle();
  if (!orgData) return null;
  const org = orgData as OrgRow;

  const [{ data: subData }, { data: memberRows }, { data: repoRows }, usage] = await Promise.all([
    db.from("subscriptions").select("org_id, tier, status, seats").eq("org_id", orgId).maybeSingle(),
    db.from("org_members").select("user_id, role").eq("org_id", orgId),
    db.from("repos").select("id, name, index_status").eq("org_id", orgId),
    getOrgUsage(db, orgId),
  ]);

  const members = (memberRows ?? []) as { user_id: string; role: string }[];
  const userIds = members.map((m) => m.user_id);
  const { data: userRows } = userIds.length ? await db.from("users").select("id, email, handle").in("id", userIds) : { data: [] };
  const userById = new Map(((userRows ?? []) as { id: string; email: string | null; handle: string | null }[]).map((u) => [u.id, u]));

  const repos = (repoRows ?? []) as { id: string; name: string; index_status: string }[];
  const repoIds = repos.map((r) => r.id);
  const { data: prRows } = repoIds.length ? await db.from("pull_requests").select("id").in("repo_id", repoIds) : { data: [] };
  const prIds = ((prRows ?? []) as { id: string }[]).map((p) => p.id);
  const { data: runRows } = prIds.length
    ? await db.from("review_runs").select(RUN_SELECT).in("pr_id", prIds).order("started_at", { ascending: false }).limit(10)
    : { data: [] };
  const recentRuns = await attachRunContext(db, (runRows ?? []) as RunRow[]);

  return {
    ...summarizeOrg(org, (subData ?? undefined) as SubRow | undefined),
    members: members.map((m) => {
      const u = userById.get(m.user_id);
      return { userId: m.user_id, email: u?.email ?? null, handle: u?.handle ?? null, role: m.role };
    }),
    repos: repos.map((r) => ({ id: r.id, name: r.name, indexStatus: r.index_status })),
    usage,
    recentRuns,
  };
}

export interface AdminUserSummary {
  id: string;
  email: string | null;
  handle: string | null;
  seatActive: boolean;
  isPlatformAdmin: boolean;
  createdAt: string;
  orgs: { id: string; name: string; role: string }[];
}

export async function listUsersAdmin(db: SupabaseClient): Promise<AdminUserSummary[]> {
  const [{ data: users }, { data: memberRows }, { data: orgRows }] = await Promise.all([
    db.from("users").select("id, email, handle, seat_active, is_platform_admin, created_at").order("created_at", { ascending: false }),
    db.from("org_members").select("org_id, user_id, role"),
    db.from("orgs").select("id, name"),
  ]);
  const orgNameById = new Map(((orgRows ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  const orgsByUser = new Map<string, { id: string; name: string; role: string }[]>();
  for (const m of (memberRows ?? []) as { org_id: string; user_id: string; role: string }[]) {
    const list = orgsByUser.get(m.user_id) ?? [];
    list.push({ id: m.org_id, name: orgNameById.get(m.org_id) ?? "—", role: m.role });
    orgsByUser.set(m.user_id, list);
  }

  return (
    (users ?? []) as { id: string; email: string | null; handle: string | null; seat_active: boolean; is_platform_admin: boolean; created_at: string }[]
  ).map((u) => ({
    id: u.id,
    email: u.email,
    handle: u.handle,
    seatActive: u.seat_active,
    isPlatformAdmin: u.is_platform_admin,
    createdAt: u.created_at,
    orgs: orgsByUser.get(u.id) ?? [],
  }));
}

export interface AdminSubscriptionSummary {
  orgId: string;
  orgName: string;
  tier: string;
  status: string;
  seats: number;
  razorpayCustomerId: string | null;
  razorpaySubId: string | null;
}

export async function listSubscriptionsAdmin(db: SupabaseClient): Promise<AdminSubscriptionSummary[]> {
  const [{ data: subs }, { data: orgs }] = await Promise.all([
    db.from("subscriptions").select("org_id, tier, status, seats, razorpay_customer_id, razorpay_sub_id"),
    db.from("orgs").select("id, name"),
  ]);
  const orgNameById = new Map(((orgs ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  return (
    (subs ?? []) as {
      org_id: string;
      tier: string;
      status: string;
      seats: number;
      razorpay_customer_id: string | null;
      razorpay_sub_id: string | null;
    }[]
  ).map((s) => ({
    orgId: s.org_id,
    orgName: orgNameById.get(s.org_id) ?? "—",
    tier: s.tier,
    status: s.status,
    seats: s.seats,
    razorpayCustomerId: s.razorpay_customer_id,
    razorpaySubId: s.razorpay_sub_id,
  }));
}

export interface AdminPageOpts {
  before?: string;
  limit?: number;
}

export async function listRunsAdmin(db: SupabaseClient, opts: AdminPageOpts = {}): Promise<AdminRunSummary[]> {
  let query = db.from("review_runs").select(RUN_SELECT).order("started_at", { ascending: false }).limit(opts.limit ?? 50);
  if (opts.before) query = query.lt("started_at", opts.before);
  const { data: runRows } = await query;
  return attachRunContext(db, (runRows ?? []) as RunRow[]);
}

export async function getRunAdmin(db: SupabaseClient, runId: string): Promise<AdminRunSummary | null> {
  const { data } = await db.from("review_runs").select(RUN_SELECT).eq("id", runId).maybeSingle();
  if (!data) return null;
  const [run] = await attachRunContext(db, [data as RunRow]);
  return run ?? null;
}

export interface AdminAuditLogEntry {
  id: string;
  orgId: string | null;
  orgName?: string;
  actor: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export async function listAuditLogAdmin(db: SupabaseClient, opts: AdminPageOpts = {}): Promise<AdminAuditLogEntry[]> {
  let query = db.from("audit_log").select("id, org_id, actor, action, target, meta, created_at").order("created_at", { ascending: false }).limit(opts.limit ?? 50);
  if (opts.before) query = query.lt("created_at", opts.before);
  const { data: rows } = await query;
  const entries = (rows ?? []) as {
    id: string;
    org_id: string | null;
    actor: string;
    action: string;
    target: string | null;
    meta: Record<string, unknown>;
    created_at: string;
  }[];
  if (entries.length === 0) return [];

  const orgIds = [...new Set(entries.map((e) => e.org_id).filter((id): id is string => !!id))];
  const { data: orgRows } = orgIds.length ? await db.from("orgs").select("id, name").in("id", orgIds) : { data: [] };
  const orgNameById = new Map(((orgRows ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));

  return entries.map((e) => ({
    id: e.id,
    orgId: e.org_id,
    orgName: e.org_id ? orgNameById.get(e.org_id) : undefined,
    actor: e.actor,
    action: e.action,
    target: e.target,
    meta: e.meta,
    createdAt: e.created_at,
  }));
}

/** Returns suspension info for the review choke-point (and synchronous REST 403s). */
export async function getOrgSuspension(
  db: SupabaseClient,
  orgId: string,
): Promise<{ suspended: boolean; suspendedAt: string | null; suspendedReason: string | null }> {
  const { data } = await db.from("orgs").select("suspended_at, suspended_reason").eq("id", orgId).maybeSingle();
  if (!data) return { suspended: false, suspendedAt: null, suspendedReason: null };
  const suspendedAt = (data.suspended_at as string | null) ?? null;
  return {
    suspended: suspendedAt !== null,
    suspendedAt,
    suspendedReason: (data.suspended_reason as string | null) ?? null,
  };
}

export async function suspendOrgAdmin(
  db: SupabaseClient,
  orgId: string,
  reason: string | null,
): Promise<{ id: string; suspendedAt: string; suspendedReason: string | null } | null> {
  const suspendedAt = new Date().toISOString();
  const { data, error } = await db
    .from("orgs")
    .update({ suspended_at: suspendedAt, suspended_reason: reason })
    .eq("id", orgId)
    .select("id, suspended_at, suspended_reason")
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    suspendedAt: data.suspended_at as string,
    suspendedReason: (data.suspended_reason as string | null) ?? null,
  };
}

export async function unsuspendOrgAdmin(
  db: SupabaseClient,
  orgId: string,
): Promise<{ id: string; suspendedAt: null; suspendedReason: null } | null> {
  const { data, error } = await db
    .from("orgs")
    .update({ suspended_at: null, suspended_reason: null })
    .eq("id", orgId)
    .select("id")
    .maybeSingle();
  if (error || !data) return null;
  return { id: data.id as string, suspendedAt: null, suspendedReason: null };
}

export async function setPlatformAdminFlag(
  db: SupabaseClient,
  userId: string,
  isPlatformAdmin: boolean,
): Promise<{ id: string; isPlatformAdmin: boolean } | null> {
  const { data, error } = await db
    .from("users")
    .update({ is_platform_admin: isPlatformAdmin })
    .eq("id", userId)
    .select("id, is_platform_admin")
    .maybeSingle();
  if (error || !data) return null;
  return { id: data.id as string, isPlatformAdmin: data.is_platform_admin as boolean };
}

export async function countPlatformAdmins(db: SupabaseClient): Promise<number> {
  const { count } = await db.from("users").select("id", { count: "exact", head: true }).eq("is_platform_admin", true);
  return count ?? 0;
}
