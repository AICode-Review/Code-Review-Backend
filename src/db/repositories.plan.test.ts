import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { canReviewRepo, FREE_SEAT_LIMIT, getOrgOwnerEmail, getOrgPlan, getOrgSeatLimit } from "./repositories.js";

function fakeSubscriptionsDb(row: { tier: string; status: string; seats: number } | null): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("getOrgPlan", () => {
  it("is free when there is no subscription row", async () => {
    expect(await getOrgPlan(fakeSubscriptionsDb(null), "org-1")).toBe("free");
  });

  it("is free when the subscription status is not active or trialing", async () => {
    expect(await getOrgPlan(fakeSubscriptionsDb({ tier: "team", status: "past_due", seats: 10 }), "org-1")).toBe("free");
    expect(await getOrgPlan(fakeSubscriptionsDb({ tier: "team", status: "canceled", seats: 10 }), "org-1")).toBe("free");
  });

  it("reflects the real tier when active", async () => {
    expect(await getOrgPlan(fakeSubscriptionsDb({ tier: "pro", status: "active", seats: 5 }), "org-1")).toBe("pro");
    expect(await getOrgPlan(fakeSubscriptionsDb({ tier: "team", status: "active", seats: 20 }), "org-1")).toBe("team");
  });

  it("counts trialing as active", async () => {
    expect(await getOrgPlan(fakeSubscriptionsDb({ tier: "pro", status: "trialing", seats: 5 }), "org-1")).toBe("pro");
  });
});

describe("getOrgSeatLimit", () => {
  it("falls back to the free seat limit with no active subscription", async () => {
    expect(await getOrgSeatLimit(fakeSubscriptionsDb(null), "org-1")).toBe(FREE_SEAT_LIMIT);
  });

  it("uses the purchased seat count for an active subscription", async () => {
    expect(await getOrgSeatLimit(fakeSubscriptionsDb({ tier: "pro", status: "active", seats: 8 }), "org-1")).toBe(8);
  });
});

describe("canReviewRepo", () => {
  it("always allows public repos regardless of plan", async () => {
    expect(await canReviewRepo(fakeSubscriptionsDb(null), "org-1", false)).toBe(true);
  });

  it("blocks private repos on the free plan", async () => {
    expect(await canReviewRepo(fakeSubscriptionsDb(null), "org-1", true)).toBe(false);
  });

  it("allows private repos on pro/team plans", async () => {
    expect(await canReviewRepo(fakeSubscriptionsDb({ tier: "pro", status: "active", seats: 5 }), "org-1", true)).toBe(true);
  });
});

function fakeOwnerLookupDb(row: { email: string | null; handle: string | null } | null): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: row ? { users: row } : null, error: null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("getOrgOwnerEmail", () => {
  it("returns the owner's email and handle when present", async () => {
    const result = await getOrgOwnerEmail(fakeOwnerLookupDb({ email: "owner@acme.dev", handle: "owner-dev" }), "org-1");
    expect(result).toEqual({ email: "owner@acme.dev", handle: "owner-dev" });
  });

  it("returns null when no owner row is found", async () => {
    expect(await getOrgOwnerEmail(fakeOwnerLookupDb(null), "org-1")).toBeNull();
  });

  it("returns null when the owner hasn't captured an email yet (never a throw)", async () => {
    expect(await getOrgOwnerEmail(fakeOwnerLookupDb({ email: null, handle: "owner-dev" }), "org-1")).toBeNull();
  });
});
