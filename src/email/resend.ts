import type { EmailMessage, EmailSendResult } from "./types.js";

/**
 * Sends via Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email) over
 * HTTPS (443) instead of raw SMTP (587/465). This exists because of a confirmed production
 * failure, not a hypothetical one: every send via nodemailer/SMTP to smtp.gmail.com timed out
 * from Render's network (logged as "Connection timeout" on every attempt) — Render, like many
 * PaaS hosts, appears to block or drop outbound SMTP-port traffic to fight spam abuse, while
 * regular HTTPS egress (what every other API call this backend makes already relies on) works
 * fine. Never throws — same "degrade to `{ sent: false }`" contract as the SMTP path it
 * replaces, so a Resend outage or bad key can never block the caller's actual work.
 */
export async function sendViaResend(apiKey: string, from: string, message: EmailMessage): Promise<EmailSendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { sent: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
