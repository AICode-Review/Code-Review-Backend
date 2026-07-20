/**
 * The official `razorpay` npm package ships with no TypeScript declarations. Rather than
 * depend on a community `@types/razorpay` package of uncertain accuracy, this declares
 * exactly the surface this codebase actually calls (routes/api.ts, routes/razorpayWebhook.ts)
 * — nothing more. Extend it if a new method is needed rather than widening to `any`.
 */
declare module "razorpay" {
  export interface RazorpaySubscription {
    id: string;
    plan_id: string;
    status: string;
    quantity?: number;
    customer_id?: string;
    short_url?: string;
    notes?: Record<string, string>;
  }

  export interface CreateSubscriptionParams {
    plan_id: string;
    /** Required by Razorpay's API — max number of billing cycles. There's no "until cancelled" option, so this is set to a large-but-finite number for effectively-open-ended monthly billing. */
    total_count: number;
    quantity?: number;
    customer_notify?: 0 | 1;
    notes?: Record<string, string>;
  }

  export interface UpdateSubscriptionParams {
    plan_id?: string;
    quantity?: number;
    schedule_change_at?: "now" | "cycle_end";
  }

  export default class Razorpay {
    constructor(options: { key_id: string; key_secret: string });
    subscriptions: {
      create(params: CreateSubscriptionParams): Promise<RazorpaySubscription>;
      cancel(subscriptionId: string, cancelAtCycleEnd?: boolean): Promise<RazorpaySubscription>;
      update(subscriptionId: string, params: UpdateSubscriptionParams): Promise<RazorpaySubscription>;
    };
  }
}

declare module "razorpay/dist/utils/razorpay-utils.js" {
  export function validateWebhookSignature(body: string, signature: string, secret: string): boolean;
}
