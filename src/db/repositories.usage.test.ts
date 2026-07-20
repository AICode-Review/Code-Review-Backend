import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeTables } from "../testUtils/fakeSupabase.js";
import { getOrgUsage } from "./repositories.js";

const USAGE_ENV_KEYS = ["SELF_HOSTED", "FREE_MONTHLY_REVIEW_QUOTA", "PRO_MONTHLY_REVIEWS_PER_SEAT", "TEAM_MONTHLY_REVIEWS_PER_SEAT"] as const;
const ORIGINAL_ENV = Object.fromEntries(USAGE_ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of USAGE_ENV_KEYS) delete process.env[k];
  vi.resetModules(); // config.ts memoizes env() at module scope — force a fresh read per test.
});
afterEach(() => {
  for (const k of USAGE_ENV_KEYS) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function freshGetOrgUsage() {
  const mod = await import("./repositories.js");
  return mod.getOrgUsage as typeof getOrgUsage;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/** A timestamp guaranteed to fall in the month before the current one, in UTC. */
function isoLastMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
}

function seedOrg(opts: {
  orgId: string;
  repoId: string;
  prId: string;
  subscription?: { tier: string; status: string; seats: number };
  runs: { status: string; started_at: string; blocked_reason?: string | null }[];
}): FakeTables {
  return {
    subscriptions: opts.subscription ? [{ org_id: opts.orgId, ...opts.subscription }] : [],
    repos: [{ id: opts.repoId, org_id: opts.orgId }],
    pull_requests: [{ id: opts.prId, repo_id: opts.repoId }],
    review_runs: opts.runs.map((r, i) => ({
      id: `run-${i}`,
      pr_id: opts.prId,
      status: r.status,
      started_at: r.started_at,
      blocked_reason: r.blocked_reason ?? null,
    })),
  };
}

describe("getOrgUsage", () => {
  it("free plan: counts this-month unblocked runs against the default quota", async () => {
    const { client } = createFakeSupabase(
      seedOrg({
        orgId: "org-1",
        repoId: "repo-1",
        prId: "pr-1",
        runs: [
          { status: "completed", started_at: isoDaysAgo(1) },
          { status: "completed", started_at: isoDaysAgo(2) },
          { status: "completed", started_at: isoDaysAgo(3) },
        ],
      }),
    );
    const usage = await getOrgUsage(client, "org-1");
    expect(usage.plan).toBe("free");
    expect(usage.used).toBe(3);
    expect(usage.quota).toBe(25);
    expect(usage.remaining).toBe(22);
    expect(usage.blocked).toBe(false);
  });

  it("blocks once usage reaches the quota", async () => {
    process.env["FREE_MONTHLY_REVIEW_QUOTA"] = "2";
    const getOrgUsage = await freshGetOrgUsage();
    const { client } = createFakeSupabase(
      seedOrg({
        orgId: "org-1",
        repoId: "repo-1",
        prId: "pr-1",
        runs: [
          { status: "completed", started_at: isoDaysAgo(1) },
          { status: "completed", started_at: isoDaysAgo(2) },
        ],
      }),
    );
    const usage = await getOrgUsage(client, "org-1");
    expect(usage.used).toBe(2);
    expect(usage.quota).toBe(2);
    expect(usage.remaining).toBe(0);
    expect(usage.blocked).toBe(true);
  });

  it("excludes runs blocked before any LLM spend from the count", async () => {
    const { client } = createFakeSupabase(
      seedOrg({
        orgId: "org-1",
        repoId: "repo-1",
        prId: "pr-1",
        runs: [
          { status: "completed", started_at: isoDaysAgo(1) },
          { status: "failed", started_at: isoDaysAgo(1), blocked_reason: "private_repo_free_plan" },
          { status: "failed", started_at: isoDaysAgo(1), blocked_reason: "monthly_quota_exceeded" },
        ],
      }),
    );
    const usage = await getOrgUsage(client, "org-1");
    expect(usage.used).toBe(1);
  });

  it("excludes runs from a previous month", async () => {
    const { client } = createFakeSupabase(
      seedOrg({
        orgId: "org-1",
        repoId: "repo-1",
        prId: "pr-1",
        runs: [
          { status: "completed", started_at: isoDaysAgo(1) },
          { status: "completed", started_at: isoLastMonth() },
        ],
      }),
    );
    const usage = await getOrgUsage(client, "org-1");
    expect(usage.used).toBe(1);
  });

  it("scales the pro quota by purchased seats", async () => {
    const { client } = createFakeSupabase(
      seedOrg({
        orgId: "org-1",
        repoId: "repo-1",
        prId: "pr-1",
        subscription: { tier: "pro", status: "active", seats: 5 },
        runs: [],
      }),
    );
    const usage = await getOrgUsage(client, "org-1");
    expect(usage.plan).toBe("pro");
    expect(usage.quota).toBe(200); // 40/seat default * 5 seats
  });

  it("scales the team quota by purchased seats", async () => {
    const { client } = createFakeSupabase(
      seedOrg({
        orgId: "org-1",
        repoId: "repo-1",
        prId: "pr-1",
        subscription: { tier: "team", status: "active", seats: 10 },
        runs: [],
      }),
    );
    const usage = await getOrgUsage(client, "org-1");
    expect(usage.plan).toBe("team");
    expect(usage.quota).toBe(650); // 65/seat default * 10 seats
  });

  it("is always unlimited and never blocked when self-hosted", async () => {
    process.env["SELF_HOSTED"] = "true";
    const getOrgUsage = await freshGetOrgUsage();
    const { client } = createFakeSupabase(
      seedOrg({
        orgId: "org-1",
        repoId: "repo-1",
        prId: "pr-1",
        runs: Array.from({ length: 1000 }, (_, i) => ({ status: "completed", started_at: isoDaysAgo(i % 20) })),
      }),
    );
    const usage = await getOrgUsage(client, "org-1");
    expect(usage.quota).toBeNull();
    expect(usage.remaining).toBeNull();
    expect(usage.blocked).toBe(false);
  });

  it("returns zero usage for an org with no repos", async () => {
    const { client } = createFakeSupabase({ repos: [], pull_requests: [], review_runs: [] });
    const usage = await getOrgUsage(client, "org-empty");
    expect(usage.used).toBe(0);
    expect(usage.blocked).toBe(false);
  });
});
