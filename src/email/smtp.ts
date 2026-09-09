import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { env } from "../config.js";
import { sendViaResend } from "./resend.js";
import type { EmailMessage, EmailSendResult } from "./types.js";

export type { EmailMessage, EmailSendResult } from "./types.js";

/** Whether some email transport is configured at all (Resend or SMTP) — callers use this to decide up front whether it's worth building a message. */
export function emailConfigured(): boolean {
  const e = env();
  return Boolean(e.RESEND_API_KEY) || Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS);
}

/**
 * Resend (HTTP API over HTTPS) is preferred over SMTP when both are configured — see
 * resend.ts for why: a confirmed production failure where every SMTP send from Render timed
 * out reaching Gmail. SMTP stays as the path for self-hosted deployments (DESIGN.md §11,
 * BYO LLM/infra) that bring their own working mail server. Never throws either way — a
 * missing config, bad credentials, or a connection failure all degrade to `{ sent: false }`
 * so a broken mail path can never block the caller's actual work.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailSendResult> {
  const e = env();
  if (e.RESEND_API_KEY) return sendViaResend(e.RESEND_API_KEY, e.EMAIL_FROM, message);
  if (!(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS)) {
    return { sent: false, error: "No email transport is configured (RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS)" };
  }

  try {
    // `family` isn't in @types/nodemailer's Options interface (though nodemailer passes
    // it straight through to Node's net/tls connect, which does support it) — assigning
    // to a typed variable first avoids the excess-property check an inline literal would
    // trigger, without resorting to `any`.
    const options: SMTPTransport.Options & { family?: number } = {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      auth: { user: e.SMTP_USER, pass: e.SMTP_PASS },
      // Some hosts (e.g. Render) have no outbound IPv6 route, but SMTP hosts like
      // smtp.gmail.com resolve to an IPv6 address first — forcing IPv4 avoids an
      // immediate ENETUNREACH instead of falling back.
      family: 4,
      // nodemailer's defaults (2min connection, 30s greeting/socket) mean a blocked or
      // slow path silently holds the caller's whole request open that long — every caller
      // here awaits sendEmail() inline (POST /api/contact, invite emails, etc.), so a
      // stalled SMTP path reads to the requester as a hung request, not a failed one.
      // Failing fast keeps the "never blocks the caller" promise true in practice.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    };
    const transport = nodemailer.createTransport(options);
    await transport.sendMail({
      from: e.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
