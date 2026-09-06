import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeTables } from "../testUtils/fakeSupabase.js";

const updateMock = vi.fn(async () => ({ id: "sub_1", plan_id: "plan_team", status: "active" }));
const cancelMock = vi.fn(async () => ({ id: "sub_1", plan_id: "plan_pro", status: "active" }));
vi.mock("razorpay", () => ({
  default: class Razorpay {
    subscriptions = { update: updateMock, cancel: cancelMock };
  },
}));

const ORIGINAL_ENV = {
  RAZORPAY_KEY_ID: process.env["RAZORPAY_KEY_ID"],
  RAZORPAY_KEY_SECRET: process.env["RAZORPAY_KEY_SECRET"],
  RAZORPAY_PLAN_PRO: process.env["RAZORPAY_PLAN_PRO"],
  RAZORPAY_PLAN_TEAM: process.env["RAZORPAY_PLAN_TEAM"],
};

beforeEach(() => {
  updateMock.mockClear();
  cancelMock.mockClear();
  process.env["RAZORPAY_KEY_ID"] = "key_test";
  process.env["RAZORPAY_KEY_SECRET"] = "secret_test";
  process.env["RAZORPAY_PLAN_PRO"] = "plan_pro";
  process.env["RAZORPAY_PLAN_TEAM"] = "plan_team";
});
afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const TABLES: FakeTables = {
  subscriptions: [{ org_id: "org-1", razorpay_sub_id: "sub_1", tier: "pro", status: "active", seats: 1 }],
  org_members: [
    { org_id: "org-1", user_id: "u1", role: "owner" },
    { org_id: "org-1", user_id: "u2", role: "member" },
    { org_id: "org-1", user_id: "u3", role: "member" },
  ],
  users: [
    { id: "u1", seat_active: true },
    { id: "u2", seat_active: true },
    { id: "u3", seat_active: false },
  ],
};

describe("changeOrgSubscriptionPlan", () => {
  it("reconciles the current active-seat count into Razorpay's quantity, not just plan_id", async () => {
    const { changeOrgSubscriptionPlan } = await import("./razorpaySubscriptions.js");
    const { client } = createFakeSupabase(structuredClone(TABLES));

    const result = await changeOrgSubscriptionPlan(client, "org-1", "team");

    expect(result).toEqual({ ok: true, razorpaySubId: "sub_1", planId: "plan_team" });
    expect(updateMock).toHaveBeenCalledWith("sub_1", { plan_id: "plan_team", quantity: 2, schedule_change_at: "now" });
  });
});
