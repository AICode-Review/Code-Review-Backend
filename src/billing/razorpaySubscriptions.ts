import type { SupabaseClient } from "@supabase/supabase-js";

export type BillingTier = "pro" | "team";

export type BillingOpResult =
  | { ok: true; razorpaySubId: string; planId?: string }
  | { ok: false; status: 400 | 501; error: string };

function razorpayCreds(): { keyId: string; keySecret: string } | null {
  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

function planIdForTier(tier: BillingTier): string | null {
  return (tier === "team" ? process.env["RAZORPAY_PLAN_TEAM"] : process.env["RAZORPAY_PLAN_PRO"]) ?? null;
}

/** Shared by owner Settings + platform admin console so cancel semantics cannot drift. */
export async function cancelOrgSubscription(db: SupabaseClient, orgId: string): Promise<BillingOpResult> {
  const creds = razorpayCreds();
  if (!creds) return { ok: false, status: 501, error: "Razorpay is not configured on this deployment yet" };

  const { data: sub } = await db.from("subscriptions").select("razorpay_sub_id").eq("org_id", orgId).maybeSingle();
  if (!sub?.razorpay_sub_id) return { ok: false, status: 400, error: "no active subscription on file for this org" };

  const { default: Razorpay } = await import("razorpay");
  const razorpay = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
  // cancelAtCycleEnd=true — keep access through what's already paid for.
  await razorpay.subscriptions.cancel(sub.razorpay_sub_id as string, true);
  return { ok: true, razorpaySubId: sub.razorpay_sub_id as string };
}

/** Shared by owner Settings + platform admin console so plan-change semantics cannot drift. */
export async function changeOrgSubscriptionPlan(db: SupabaseClient, orgId: string, tier: BillingTier): Promise<BillingOpResult> {
  const creds = razorpayCreds();
  if (!creds) return { ok: false, status: 501, error: "Razorpay is not configured on this deployment yet" };

  const planId = planIdForTier(tier);
  if (!planId) return { ok: false, status: 501, error: `No Razorpay plan configured for the ${tier} tier` };

  const { data: sub } = await db.from("subscriptions").select("razorpay_sub_id").eq("org_id", orgId).maybeSingle();
  if (!sub?.razorpay_sub_id) {
    return { ok: false, status: 400, error: "no active subscription to change — start checkout instead" };
  }

  const { default: Razorpay } = await import("razorpay");
  const razorpay = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
  await razorpay.subscriptions.update(sub.razorpay_sub_id as string, { plan_id: planId, schedule_change_at: "now" });
  return { ok: true, razorpaySubId: sub.razorpay_sub_id as string, planId };
}
