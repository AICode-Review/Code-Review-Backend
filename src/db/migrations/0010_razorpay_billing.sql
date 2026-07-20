-- Payment provider swap: Stripe -> Razorpay. Renaming rather than adding new columns
-- alongside the old ones — this is a full replacement, not dual-provider support, and
-- Stripe was never actually configured in any real deployment (STRIPE_SECRET_KEY was
-- always unset), so there's no real subscription data this could orphan.
alter table subscriptions rename column stripe_customer_id to razorpay_customer_id;
alter table subscriptions rename column stripe_sub_id to razorpay_sub_id;
