import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDb } from "../db/client.js";
import { recordAudit } from "../db/repositories.js";

export interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  status: string;
  quantity?: number;
  customer_id?: string;
  /** Set at creation time by routes/api.ts's checkout route — the one link back to our org, since Razorpay subscriptions don't carry a Stripe-style client_reference_id. */
  notes?: { org_id?: string; tier?: string };
}

export interface RazorpayEventLike {
  event: string;
  payload: { subscription?: { entity: RazorpaySubscriptionEntity } };
}

function tierForPlanId(planId: string | undefined): string {
  if (planId && planId === process.env["RAZORPAY_PLAN_TEAM"]) return "team";
  if (planId && planId === process.env["RAZORPAY_PLAN_PRO"]) return "pro";
  return "pro"; // unrecognized plan — default to the lower tier rather than guessing "team"
}

/** Razorpay's own status vocabulary (created/authenticated/active/pending/halted/cancelled/completed/expired) mapped onto the smaller set the rest of this codebase already reads (repositories.ts's ACTIVE_SUBSCRIPTION_STATUSES etc). */
const STATUS_MAP: Record<string, string> = {
  active: "active",
  authenticated: "active",
  cancelled: "canceled",
  completed: "canceled",
  expired: "canceled",
  halted: "past_due",
  paused: "past_due",
};

function mappedStatus(rawStatus: string): string {
  return STATUS_MAP[rawStatus] ?? rawStatus;
}

/**
 * Pure sync logic — unit-testable with fixture Razorpay event payloads, no real signature
 * verification needed here (that happens once in the route below). Keeps `subscriptions`
 * in sync with the Razorpay source of truth whenever a customer subscribes, changes
 * seats/tier, or cancels.
 */
export async function applyRazorpayEvent(db: SupabaseClient, event: RazorpayEventLike): Promise<void> {
  const sub = event.payload.subscription?.entity;
  if (!sub) return; // not a subscription event we act on

  switch (event.event) {
    case "subscription.activated": {
      const orgId = sub.notes?.org_id;
      if (!orgId) return; // not one of our subscriptions
      const { error } = await db.from("subscriptions").upsert(
        {
          org_id: orgId,
          razorpay_customer_id: sub.customer_id ?? null,
          razorpay_sub_id: sub.id,
          status: "active",
          seats: sub.quantity ?? 1,
          tier: tierForPlanId(sub.plan_id),
        },
        { onConflict: "org_id" },
      );
      if (error) throw new Error(`db: failed to sync subscription.activated: ${error.message}`);
      await recordAudit(db, orgId, "razorpay", "billing.subscribed", sub.id);
      return;
    }
    case "subscription.charged":
    case "subscription.updated": {
      const { error } = await db
        .from("subscriptions")
        .update({ status: mappedStatus(sub.status), seats: sub.quantity ?? 1, tier: tierForPlanId(sub.plan_id) })
        .eq("razorpay_sub_id", sub.id);
      if (error) throw new Error(`db: failed to sync ${event.event}: ${error.message}`);
      return;
    }
    case "subscription.cancelled":
    case "subscription.completed":
    case "subscription.halted": {
      const { error } = await db.from("subscriptions").update({ status: mappedStatus(sub.status) }).eq("razorpay_sub_id", sub.id);
      if (error) throw new Error(`db: failed to sync ${event.event}: ${error.message}`);
      return;
    }
    default:
      return; // ignore event types we don't act on
  }
}

export async function razorpayWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/razorpay", async (req, reply) => {
    const secret = process.env["RAZORPAY_WEBHOOK_SECRET"];
    const keyId = process.env["RAZORPAY_KEY_ID"];
    if (!secret || !keyId) return reply.code(501).send({ error: "Razorpay is not configured on this deployment" });

    const signature = req.headers["x-razorpay-signature"];
    if (!req.rawBody || typeof signature !== "string") {
      return reply.code(400).send({ error: "missing x-razorpay-signature header or body" });
    }

    const { validateWebhookSignature } = await import("razorpay/dist/utils/razorpay-utils.js");
    const rawBodyText = req.rawBody.toString("utf8");
    let valid: boolean;
    try {
      valid = validateWebhookSignature(rawBodyText, signature, secret);
    } catch (err) {
      req.log.warn({ err }, "razorpay webhook signature verification threw");
      return reply.code(400).send({ error: "invalid signature" });
    }
    if (!valid) {
      req.log.warn("razorpay webhook signature verification failed");
      return reply.code(400).send({ error: "invalid signature" });
    }

    const event = JSON.parse(rawBodyText) as RazorpayEventLike;
    await applyRazorpayEvent(getDb(), event);
    return reply.send({ received: true });
  });
}
