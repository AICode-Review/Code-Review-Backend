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
    `CodeFerret finished reviewing ${args.repoName} #${args.prNumber}: "${args.prTitle}"`,
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

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #18181b;">
  <p style="font-size: 15px; line-height: 1.5;">
    CodeFerret finished reviewing <strong>${escapeHtml(args.repoName)} #${args.prNumber}</strong>:
    "${escapeHtml(args.prTitle)}"
  </p>
  <p style="font-size: 14px; font-weight: 600; margin: 16px 0;">${escapeHtml(RISK_LABEL[args.riskLevel])}</p>
  ${
    args.posted.length > 0
      ? `<table style="width: 100%; border-collapse: collapse; border: 1px solid #e4e4e7; border-radius: 6px; overflow: hidden;">${findingRowsHtml}</table>`
      : `<p style="font-size: 13px; color: #71717a;">No findings posted to the PR this run.</p>`
  }
  ${args.digestCount > 0 ? `<p style="font-size: 13px; color: #71717a; margin-top: 12px;">+${args.digestCount} more lower-priority finding(s) in the digest.</p>` : ""}
  <p style="margin: 24px 0 12px;">
    <a href="${args.runUrl}" style="background: #18181b; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 14px; display: inline-block;">
      View full review
    </a>
  </p>
  <p style="font-size: 13px;">
    <a href="${args.prUrl}" style="color: #2563eb;">View the pull request →</a>
  </p>
</div>`.trim();

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

export function inviteEmail(args: InviteEmailArgs): EmailContent {
  const subject = `${args.inviterLabel} invited you to join ${args.orgName} on CodeFerret`;
  const text = [
    `${args.inviterLabel} invited you to join ${args.orgName} on CodeFerret as ${args.role}.`,
    "",
    `Accept the invite: ${args.acceptUrl}`,
    "",
    "This link expires in 14 days. If you weren't expecting this, you can ignore it.",
  ].join("\n");

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #18181b;">
  <p style="font-size: 15px; line-height: 1.5;">
    <strong>${escapeHtml(args.inviterLabel)}</strong> invited you to join
    <strong>${escapeHtml(args.orgName)}</strong> on CodeFerret as <strong>${escapeHtml(args.role)}</strong>.
  </p>
  <p style="margin: 24px 0;">
    <a href="${args.acceptUrl}" style="background: #18181b; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 14px; display: inline-block;">
      Accept invite
    </a>
  </p>
  <p style="font-size: 13px; color: #71717a; line-height: 1.5;">
    This link expires in 14 days. If you weren't expecting this, you can safely ignore it.
  </p>
</div>`.trim();

  return { subject, html, text };
}
