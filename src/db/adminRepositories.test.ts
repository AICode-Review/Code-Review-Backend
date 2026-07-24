import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "../testUtils/fakeSupabase.js";
import {
  getOrgAdminDetail,
  getOrgSuspension,
  getPlatformOverview,
  listAuditLogAdmin,
  listOrgsAdmin,
  getRunAdmin,
  listRunsAdmin,
  listSubscriptionsAdmin,
  listUsersAdmin,
  countPlatformAdmins,
  setPlatformAdminFlag,
  suspendOrgAdmin,
  unsuspendOrgAdmin,
} from "./adminRepositories.js";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function isoLastMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
}

const BASE: FakeTables = {
  orgs: [
    { id: "org-free", name: "Acme Free", kind: "individual", platform: "github", seats: 1, created_at: isoDaysAgo(30), suspended_at: null, suspended_reason: null },
    { id: "org-pro", name: "Acme Pro", kind: "team", platform: "github", seats: 3, created_at: isoDaysAgo(20), suspended_at: null, suspended_reason: null },
  ],
  subscriptions: [{ org_id: "org-pro", tier: "pro", status: "active", seats: 5, razorpay_customer_id: "cust_1", razorpay_sub_id: "sub_1" }],
  users: [
    { id: "user-1", email: "owner@acme.dev", handle: "owner", seat_active: true, is_platform_admin: false, created_at: isoDaysAgo(25) },
    { id: "user-2", email: "admin@codeferret.dev", handle: "cfadmin", seat_active: true, is_platform_admin: true, created_at: isoDaysAgo(10) },
  ],
  org_members: [
    { org_id: "org-pro", user_id: "user-1", role: "owner" },
    { org_id: "org-free", user_id: "user-2", role: "owner" },
  ],
  repos: [{ id: "repo-1", org_id: "org-pro", name: "acme/web", index_status: "ready" }],
  pull_requests: [{ id: "pr-1", repo_id: "repo-1", number: 42 }],
  review_runs: [
    {
      id: "run-1",
      pr_id: "pr-1",
      status: "completed",
      started_at: isoDaysAgo(1),
      finished_at: isoDaysAgo(1),
      candidates: 5,
      verified: 2,
      posted: 2,
      digest: 1,
      llm_cost_usd: 0.12,
      anthropic_cost_usd: 0.1,
      openai_cost_usd: 0.02,
      latency_ms: 4000,
      error: null,
      blocked_reason: null,
    },
    {
      id: "run-2",
      pr_id: "pr-1",
      status: "failed",
      started_at: isoLastMonth(),
      finished_at: null,
      candidates: 0,
      verified: 0,
      posted: 0,
      digest: 0,
      llm_cost_usd: 0,
      anthropic_cost_usd: 0,
      openai_cost_usd: 0,
      latency_ms: null,
      error: "timeout",
      blocked_reason: null,
    },
  ],
  audit_log: [
    { id: "al-1", org_id: "org-pro", actor: "owner@acme.dev", action: "bitbucket.connected", target: "acme", meta: {}, created_at: isoDaysAgo(2) },
  ],
};

describe("getPlatformOverview", () => {
  it("aggregates counts, active-sub MRR, this-month reviews, and this-month LLM spend", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const overview = await getPlatformOverview(client);
    expect(overview.totalOrgs).toBe(2);
    expect(overview.totalUsers).toBe(2);
    expect(overview.subscriptionsByTier).toEqual([{ tier: "pro", count: 1 }]);
    expect(overview.mrrUsd).toBe(75); // $15/seat * 5 seats
    expect(overview.reviewsThisMonth).toBe(1); // only run-1 is this month
    expect(overview.llmSpendThisMonthUsd).toBeCloseTo(0.12);
    expect(overview.anthropicSpendThisMonthUsd).toBeCloseTo(0.1);
    expect(overview.openaiSpendThisMonthUsd).toBeCloseTo(0.02);
  });
});

describe("listOrgsAdmin", () => {
  it("marks the free org's plan free and the actively-subscribed org's plan from its subscription tier/seats", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const orgs = await listOrgsAdmin(client);
    const free = orgs.find((o) => o.id === "org-free")!;
    const pro = orgs.find((o) => o.id === "org-pro")!;
    expect(free.plan).toBe("free");
    expect(free.subscriptionStatus).toBeNull();
    expect(pro.plan).toBe("pro");
    expect(pro.seats).toBe(5); // subscription seats override the org's raw seats column
    expect(pro.subscriptionStatus).toBe("active");
  });

  it("treats a cancelled subscription as effectively free", async () => {
    const tables = structuredClone(BASE);
    tables.subscriptions = [{ org_id: "org-pro", tier: "pro", status: "cancelled", seats: 5 }];
    const { client } = createFakeSupabase(tables);
    const orgs = await listOrgsAdmin(client);
    expect(orgs.find((o) => o.id === "org-pro")!.plan).toBe("free");
  });
});

describe("getOrgAdminDetail", () => {
  it("returns null for a nonexistent org", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    expect(await getOrgAdminDetail(client, "org-nope")).toBeNull();
  });

  it("assembles members, repos, usage, and recent runs with pr/repo context", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const detail = await getOrgAdminDetail(client, "org-pro");
    expect(detail?.name).toBe("Acme Pro");
    expect(detail?.members).toEqual([{ userId: "user-1", email: "owner@acme.dev", handle: "owner", role: "owner" }]);
    expect(detail?.repos).toEqual([{ id: "repo-1", name: "acme/web", indexStatus: "ready" }]);
    expect(detail?.recentRuns).toHaveLength(2);
    expect(detail?.recentRuns[0]?.prNumber).toBe(42);
    expect(detail?.recentRuns[0]?.repoName).toBe("acme/web");
    expect(detail?.usage.plan).toBe("pro");
  });
});

describe("listUsersAdmin", () => {
  it("attaches each user's org memberships with role and org name", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const users = await listUsersAdmin(client);
    const owner = users.find((u) => u.id === "user-1")!;
    expect(owner.orgs).toEqual([{ id: "org-pro", name: "Acme Pro", role: "owner" }]);
    expect(users.find((u) => u.id === "user-2")!.isPlatformAdmin).toBe(true);
  });
});

describe("listSubscriptionsAdmin", () => {
  it("joins each subscription to its org name", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const subs = await listSubscriptionsAdmin(client);
    expect(subs).toEqual([
      { orgId: "org-pro", orgName: "Acme Pro", tier: "pro", status: "active", seats: 5, razorpayCustomerId: "cust_1", razorpaySubId: "sub_1" },
    ]);
  });
});

describe("listRunsAdmin", () => {
  it("lists runs newest-first across every org with pr/repo/org context attached", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const runs = await listRunsAdmin(client);
    expect(runs.map((r) => r.id)).toEqual(["run-1", "run-2"]);
    expect(runs[0]?.orgName).toBe("Acme Pro");
  });

  it("returns an empty list when there are no runs at all", async () => {
    const { client } = createFakeSupabase({ review_runs: [] });
    expect(await listRunsAdmin(client)).toEqual([]);
  });
});

describe("getRunAdmin", () => {
  it("returns a single run with pr/repo/org context", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const run = await getRunAdmin(client, "run-1");
    expect(run?.id).toBe("run-1");
    expect(run?.orgName).toBe("Acme Pro");
  });

  it("returns null when the run does not exist", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    expect(await getRunAdmin(client, "missing")).toBeNull();
  });
});

describe("listAuditLogAdmin", () => {
  it("lists entries with org name attached", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const entries = await listAuditLogAdmin(client);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "al-1",
      orgId: "org-pro",
      orgName: "Acme Pro",
      actor: "owner@acme.dev",
      action: "bitbucket.connected",
      target: "acme",
      meta: {},
    });
  });
});

describe("suspend / unsuspend / platform admin writes", () => {
  it("suspends and unsuspends an org", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    const suspended = await suspendOrgAdmin(client, "org-pro", "abuse");
    expect(suspended?.suspendedReason).toBe("abuse");
    expect(suspended?.suspendedAt).toBeTruthy();
    expect((await getOrgSuspension(client, "org-pro")).suspended).toBe(true);

    const detail = await getOrgAdminDetail(client, "org-pro");
    expect(detail?.suspendedAt).toBeTruthy();
    expect(detail?.suspendedReason).toBe("abuse");

    await unsuspendOrgAdmin(client, "org-pro");
    expect((await getOrgSuspension(client, "org-pro")).suspended).toBe(false);
  });

  it("toggles is_platform_admin and counts admins", async () => {
    const { client } = createFakeSupabase(structuredClone(BASE));
    expect(await countPlatformAdmins(client)).toBe(1);
    const granted = await setPlatformAdminFlag(client, "user-1", true);
    expect(granted?.isPlatformAdmin).toBe(true);
    expect(await countPlatformAdmins(client)).toBe(2);
    await setPlatformAdminFlag(client, "user-1", false);
    expect(await countPlatformAdmins(client)).toBe(1);
  });
});
