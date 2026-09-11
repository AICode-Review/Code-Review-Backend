export interface ReviewCompleteFinding {
  severity: "critical" | "major" | "minor";
  title: string;
  path: string;
  line: number;
}

export interface ReviewCompleteEmailArgs {
  repoName: string;
  prNumber: number;
  prTitle: string;
  riskLevel: "high" | "medium" | "low" | "none";
  posted: ReviewCompleteFinding[];
  digestCount: number;
  runUrl: string;
  prUrl: string;
}

const RISK_LABEL: Record<ReviewCompleteEmailArgs["riskLevel"], string> = {
  high: "🔴 High risk",
  medium: "🟡 Medium risk",
  low: "🟢 Low risk",
  none: "✅ No high-severity findings",
};

const SEVERITY_LABEL: Record<ReviewCompleteFinding["severity"], string> = {
  critical: "🔴 Critical",
  major: "🟡 Major",
  minor: "⚪ Minor",
};

/** GitHub/Bitbucket both use owner/repo#N somewhere in prUrl already by the time this is built by the caller — kept here as the one place that formats findings into an email body. */
export function reviewCompleteEmail(args: ReviewCompleteEmailArgs): EmailContent {
  const subject = `${RISK_LABEL[args.riskLevel]} — ${args.repoName} #${args.prNumber}: ${args.prTitle}`;

  const findingLinesText = args.posted.map(
    (f) => `  - [${SEVERITY_LABEL[f.severity]}] ${f.title} (${f.path}:${f.line})`,
  );
  const text = [
    `Scrutinye finished reviewing ${args.repoName} #${args.prNumber}: "${args.prTitle}"`,
    "",
    `Risk: ${RISK_LABEL[args.riskLevel]}`,
    "",
    args.posted.length > 0 ? `${args.posted.length} finding(s) posted to the PR:` : "No findings posted to the PR this run.",
    ...findingLinesText,
    args.digestCount > 0 ? `\n+${args.digestCount} more lower-priority finding(s) in the digest.` : "",
    "",
    `View the full review: ${args.runUrl}`,
    `View the pull request: ${args.prUrl}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const findingRowsHtml = args.posted
    .map(
      (f) => `
    <tr>
      <td style="padding: 6px 8px; font-size: 13px; white-space: nowrap; vertical-align: top;">${escapeHtml(SEVERITY_LABEL[f.severity])}</td>
      <td style="padding: 6px 8px; font-size: 13px;">
        ${escapeHtml(f.title)}<br />
        <span style="color: #71717a; font-family: ui-monospace, monospace; font-size: 12px;">${escapeHtml(f.path)}:${f.line}</span>
      </td>
    </tr>`,
    )
    .join("");

  const html = emailLayout(`
  <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;">
    Scrutinye finished reviewing <strong>${escapeHtml(args.repoName)} #${args.prNumber}</strong>:
    "${escapeHtml(args.prTitle)}"
  </p>
  <p style="font-size: 14px; font-weight: 600; margin: 0 0 16px;">${escapeHtml(RISK_LABEL[args.riskLevel])}</p>
  ${
    args.posted.length > 0
      ? `<table role="presentation" style="width: 100%; border-collapse: collapse; border: 1px solid #e4e4e7; border-radius: 6px; overflow: hidden;">${findingRowsHtml}</table>`
      : `<p style="font-size: 13px; color: #71717a; margin: 0;">No findings posted to the PR this run.</p>`
  }
  ${args.digestCount > 0 ? `<p style="font-size: 13px; color: #71717a; margin: 12px 0 0;">+${args.digestCount} more lower-priority finding(s) in the digest.</p>` : ""}
  <p style="margin: 24px 0 12px;">
    <a href="${args.runUrl}" style="background: #3956DD; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600; display: inline-block;">
      View full review
    </a>
  </p>
  <p style="font-size: 13px; margin: 0;">
    <a href="${args.prUrl}" style="color: #3956DD;">View the pull request →</a>
  </p>`);

  return { subject, html, text };
}

export interface InviteEmailArgs {
  orgName: string;
  inviterLabel: string;
  role: string;
  acceptUrl: string;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]!);
}

/**
 * Shared branded shell every transactional email renders inside — a header (logo + name),
 * the caller's own content untouched, and a footer. Table-based layout rather than
 * flexbox/grid, since that's what actually renders consistently across email clients
 * (Outlook's Word-based renderer in particular ignores most modern CSS). The logo is a
 * hosted <img> (favicon-32x32.png, already live) rather than an inline SVG — SVG-in-email
 * support is inconsistent across clients, a hosted image with alt-text fallback is not.
 */
function emailLayout(bodyHtml: string): string {
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; background: #ffffff; color: #18181b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom: 1px solid #ececef;">
    <tr>
      <td style="padding: 20px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align: middle; padding-right: 8px;">
              <img src="https://scrutinye.dev/favicon-32x32.png" width="22" height="22" alt="Scrutinye" style="display: block; border-radius: 5px;" />
            </td>
            <td style="vertical-align: middle;">
              <span style="font-size: 15px; font-weight: 700; color: #18181b; letter-spacing: -0.01em;">Scrutinye</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  <div style="padding: 28px;">
    ${bodyHtml}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #ececef;">
    <tr>
      <td style="padding: 18px 28px; font-size: 12px; color: #a1a1aa; line-height: 1.6;">
        Scrutinye · AI code review for your team<br />
        <a href="https://scrutinye.dev" style="color: #a1a1aa;">scrutinye.dev</a>
      </td>
    </tr>
  </table>
</div>`.trim();
}

export type ContactReason = "general" | "billing" | "legal" | "enterprise" | "bug";

export interface ContactSubmissionEmailArgs {
  name: string;
  email: string;
  message: string;
  reason: ContactReason;
}

const CONTACT_REASON_COPY: Record<ContactReason, { tag: string; intro: string }> = {
  general: { tag: "General", intro: "New contact form submission" },
  billing: { tag: "Billing", intro: "New billing inquiry" },
  legal: { tag: "Legal", intro: "New legal/privacy inquiry" },
  enterprise: { tag: "Self-hosted/Enterprise", intro: "New self-hosted or enterprise inquiry" },
  bug: { tag: "Bug/Feedback", intro: "New bug report or feedback" },
};

/** Notifies CONTACT_INBOX_EMAIL of a new public "Contact us" form submission — the submission itself is always saved to contact_submissions regardless of whether this send succeeds. */
export function contactSubmissionEmail(args: ContactSubmissionEmailArgs): EmailContent {
  const { tag, intro } = CONTACT_REASON_COPY[args.reason];
  const subject = `[${tag}] ${intro} from ${args.name}`;
  const text = [
    `${intro}`,
    `Name: ${args.name}`,
    `Email: ${args.email}`,
    "",
    args.message,
  ].join("\n");

  const html = emailLayout(`
  <p style="display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #3956DD; background: #eef1ff; border-radius: 6px; padding: 3px 9px; margin: 0 0 16px;">${escapeHtml(tag)}</p>
  <p style="font-size: 15px; font-weight: 600; margin: 0 0 4px;">${escapeHtml(intro)}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 12px 0 20px;">
    <tr>
      <td style="font-size: 13px; color: #71717a; padding-right: 8px; vertical-align: top;">From</td>
      <td style="font-size: 13px;"><strong>${escapeHtml(args.name)}</strong> &lt;<a href="mailto:${escapeHtml(args.email)}" style="color: #3956DD;">${escapeHtml(args.email)}</a>&gt;</td>
    </tr>
  </table>
  <div style="background: #fafafa; border: 1px solid #ececef; border-radius: 8px; padding: 16px; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(args.message)}</div>
  <p style="margin: 20px 0 0;">
    <a href="mailto:${escapeHtml(args.email)}" style="background: #3956DD; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600; display: inline-block;">
      Reply to ${escapeHtml(args.name)}
    </a>
  </p>`);

  return { subject, html, text };
}

export function inviteEmail(args: InviteEmailArgs): EmailContent {
  const subject = `${args.inviterLabel} invited you to join ${args.orgName} on Scrutinye`;
  const text = [
    `${args.inviterLabel} invited you to join ${args.orgName} on Scrutinye as ${args.role}.`,
    "",
    `Accept the invite: ${args.acceptUrl}`,
    "",
    "This link expires in 14 days. If you weren't expecting this, you can ignore it.",
  ].join("\n");

  const html = emailLayout(`
  <p style="font-size: 15px; line-height: 1.5; margin: 0 0 20px;">
    <strong>${escapeHtml(args.inviterLabel)}</strong> invited you to join
    <strong>${escapeHtml(args.orgName)}</strong> on Scrutinye as <strong>${escapeHtml(args.role)}</strong>.
  </p>
  <p style="margin: 0 0 20px;">
    <a href="${args.acceptUrl}" style="background: #3956DD; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600; display: inline-block;">
      Accept invite
    </a>
  </p>
  <p style="font-size: 13px; color: #71717a; line-height: 1.5; margin: 0;">
    This link expires in 14 days. If you weren't expecting this, you can safely ignore it.
  </p>`);

  return { subject, html, text };
}
