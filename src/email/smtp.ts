import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { env } from "../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSendResult {
  sent: boolean;
  error?: string;
}

/** Whether SMTP is configured at all — callers use this to decide up front whether it's worth building a message. */
export function emailConfigured(): boolean {
  const e = env();
  return Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS);
}

/**
 * Sends via a plain SMTP transport (nodemailer) — works with Gmail Workspace, Office365,
 * Amazon SES, Mailgun, an internal relay, or any other standard SMTP server, whatever the
 * deployment already has credentials for. A fresh transport per call rather than a
 * cached/pooled one — email volume here is transactional (invites, review-complete), not
 * bulk, so the simplicity is worth more than the reused-connection savings. Never throws
 * — a missing config, bad credentials, or a connection failure all degrade to
 * `{ sent: false }` so a broken mail server can never block the caller's actual work.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailSendResult> {
  if (!emailConfigured()) return { sent: false, error: "SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)" };

  const e = env();
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
