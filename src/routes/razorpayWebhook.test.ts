import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyRazorpayEvent, type RazorpayEventLike, type RazorpaySubscriptionEntity } from "./razorpayWebhook.js";

interface Call {
  table: string;
  op: "upsert" | "update" | "insert";
  payload: Record<string, unknown>;
  eq?: [string, unknown];
}

/** Minimal fake mirroring the .from(table).upsert(...) / .update(...).eq(...) / .insert(...) chains applyRazorpayEvent (+ recordAudit) uses. */
function makeFakeDb() {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      return {
        upsert(payload: Record<string, unknown>) {
          calls.push({ table, op: "upsert", payload });
          return Promise.resolve({ error: null });
        },
        insert(payload: Record<string, unknown>) {
          calls.push({ table, op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        update(payload: Record<string, unknown>) {
          return {
            eq(col: string, val: unknown) {
              calls.push({ table, op: "update", payload, eq: [col, val] });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env["RAZORPAY_PLAN_PRO"] = "plan_pro_123";
  process.env["RAZORPAY_PLAN_TEAM"] = "plan_team_456";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function subEvent(event: string, entity: Partial<RazorpaySubscriptionEntity> & Pick<RazorpaySubscriptionEntity, "id" | "plan_id" | "status">): RazorpayEventLike {
  return { event, payload: { subscription: { entity } } };
}

describe("applyRazorpayEvent", () => {
  it("upserts a subscription row on subscription.activated", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(
      db,
      subEvent("subscription.activated", {
        id: "sub_1",
        plan_id: "plan_pro_123",
        status: "active",
        quantity: 3,
        customer_id: "cust_1",
        notes: { org_id: "org-1", tier: "pro" },
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      table: "subscriptions",
      op: "upsert",
      payload: { org_id: "org-1", razorpay_customer_id: "cust_1", razorpay_sub_id: "sub_1", status: "active", seats: 3, tier: "pro" },
    });
    expect(calls[1]).toMatchObject({ table: "audit_log", op: "insert", payload: { org_id: "org-1", action: "billing.subscribed" } });
  });

  it("ignores a subscription.activated event with no org_id in notes (not one of ours)", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(db, subEvent("subscription.activated", { id: "sub_1", plan_id: "plan_pro_123", status: "active" }));
    expect(calls).toHaveLength(0);
  });

  it("ignores an event with no subscription payload at all", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(db, { event: "payment.captured", payload: {} });
    expect(calls).toHaveLength(0);
  });

  it("syncs status/seats/tier on subscription.charged, resolving tier from the plan id", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(
      db,
      subEvent("subscription.charged", { id: "sub_1", plan_id: "plan_team_456", status: "active", quantity: 8 }),
    );
    expect(calls[0]).toMatchObject({
      table: "subscriptions",
      op: "update",
      payload: { status: "active", seats: 8, tier: "team" },
      eq: ["razorpay_sub_id", "sub_1"],
    });
  });

  it("defaults to the pro tier for an unrecognized plan id rather than guessing team", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(db, subEvent("subscription.updated", { id: "sub_2", plan_id: "plan_unknown", status: "active", quantity: 1 }));
    expect(calls[0]?.payload).toMatchObject({ tier: "pro" });
  });

  it("marks a subscription canceled on subscription.cancelled", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(db, subEvent("subscription.cancelled", { id: "sub_1", plan_id: "plan_pro_123", status: "cancelled" }));
    expect(calls[0]).toMatchObject({ table: "subscriptions", op: "update", payload: { status: "canceled" }, eq: ["razorpay_sub_id", "sub_1"] });
  });

  it("maps a payment failure (subscription.halted) to past_due rather than canceling outright", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(db, subEvent("subscription.halted", { id: "sub_1", plan_id: "plan_pro_123", status: "halted" }));
    expect(calls[0]).toMatchObject({ table: "subscriptions", op: "update", payload: { status: "past_due" }, eq: ["razorpay_sub_id", "sub_1"] });
  });

  it("ignores event types it doesn't act on", async () => {
    const { db, calls } = makeFakeDb();
    await applyRazorpayEvent(db, subEvent("subscription.pending", { id: "sub_1", plan_id: "plan_pro_123", status: "pending" }));
    expect(calls).toHaveLength(0);
  });
});
