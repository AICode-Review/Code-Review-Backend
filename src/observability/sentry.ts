import * as Sentry from "@sentry/node";
import { env } from "../config.js";

let initialized = false;

/**
 * No-op when SENTRY_DSN is unset — same silent-degrade pattern as SMTP/Razorpay
 * elsewhere in config.ts. Call once per process (server.ts, worker.ts) before
 * registering any error handlers.
 */
export function initSentry(): void {
  const dsn = env().SENTRY_DSN;
  if (!dsn || initialized) return;
  Sentry.init({ dsn, environment: env().NODE_ENV, tracesSampleRate: 0 });
  initialized = true;
}

/** Safe to call unconditionally — a no-op Sentry client just drops the event. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
