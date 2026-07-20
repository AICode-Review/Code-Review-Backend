import type { MergedFinding } from "./merge.js";
import { SUMMARY_MARKER } from "../adapters/types.js";

export interface DeliverableFinding extends MergedFinding {
  verificationStatus: "verified" | "rejected";
  verificationMethod: "static" | "cross_exam" | "execution";
  verifiedHow: string;
  /** exact source lines (± context), extracted from the real file — never LLM-generated. Null only if the cited range somehow no longer exists in the fetched content. */
  codeSnippet: string | null;
}

export interface DeliverySelection {
  posted: DeliverableFinding[];
  digest: DeliverableFinding[];
  rejected: DeliverableFinding[];
}

/**
 * DESIGN.md §6.6 — only critical/major VERIFIED findings become line
 * comments, by score, up to the budget. Everything else verified goes to the
 * digest. Rejected findings are surfaced (collapsed) for transparency but
 * never as line comments. `findings` must already be sorted by score desc
 * (mergeAndScore does this).
 */
export function selectForDelivery(findings: DeliverableFinding[], commentBudget: number): DeliverySelection {
  const verified = findings.filter((f) => f.verificationStatus === "verified");
  const rejected = findings.filter((f) => f.verificationStatus === "rejected");

  const eligibleForLineComment = verified.filter((f) => f.severity === "critical" || f.severity === "major");
  const posted = eligibleForLineComment.slice(0, commentBudget);
  const postedFingerprints = new Set(posted.map((f) => f.fingerprint));
  const digest = verified.filter((f) => !postedFingerprints.has(f.fingerprint));

  return { posted, digest, rejected };
}

export type RiskLevel = "high" | "medium" | "low" | "none";

export function computeRiskLevel(posted: DeliverableFinding[]): RiskLevel {
  if (posted.some((f) => f.severity === "critical")) return "high";
  if (posted.some((f) => f.severity === "major")) return "medium";
  if (posted.length > 0) return "low";
  return "none";
}

export type CheckState = "success" | "neutral" | "failure";

/** Fail only on critical VERIFIED findings (configurable via failOnCritical), per DESIGN.md §6.6. */
export function computeCheckState(allFindings: DeliverableFinding[], failOnCritical: boolean): CheckState {
  const hasCriticalVerified = allFindings.some((f) => f.verificationStatus === "verified" && f.severity === "critical");
  if (failOnCritical && hasCriticalVerified) return "failure";
  const hasAnyVerified = allFindings.some((f) => f.verificationStatus === "verified");
  return hasAnyVerified ? "neutral" : "success";
}

export function buildLineCommentBody(f: DeliverableFinding): string {
  const lines: string[] = [
    `**${f.title}**`,
    "",
    `**What's wrong:** ${f.explanation}`,
    "",
    `**Why it matters:** ${f.whyItMatters}`,
    `**If ignored:** ${f.impact}`,
    "",
    "**How to fix:**",
    ...f.fixSteps.map((step) => `- ${step}`),
  ];
  if (f.suggestedFix) {
    lines.push("", "**Suggested fix:**", "```suggestion", f.suggestedFix, "```");
  }
  const verifiedNote =
    f.verificationMethod === "execution"
      ? `Verified by reproducing it in an isolated sandbox: ${f.verifiedHow}`
      : f.verificationMethod === "cross_exam"
        ? `Verified via cross-model examination: ${f.verifiedHow}`
        : `Verified via static check: ${f.verifiedHow}`;
  lines.push("", `_✓ ${verifiedNote}_`, "", "👍 helpful · 👎 wrong · 🔇 don't flag this again");
  return lines.join("\n");
}

export interface SummaryArgs {
  prStats: { files: number; additions: number; deletions: number };
  posted: DeliverableFinding[];
  digest: DeliverableFinding[];
  rejected: DeliverableFinding[];
  skippedPasses: string[];
  costUsd: number;
  staleIndex?: boolean;
}

const RISK_LABEL: Record<RiskLevel, string> = { high: "🔴 high", medium: "🟡 medium", low: "🟢 low", none: "✅ none" };

/** DESIGN.md §6.6 — single summary comment, updated in place on re-runs. */
export function buildSummaryMarkdown(args: SummaryArgs): string {
  const risk = computeRiskLevel(args.posted);
  const lines: string[] = [
    SUMMARY_MARKER,
    "### 🤖 AI Review",
    "",
    `**Risk: ${RISK_LABEL[risk]}** · ${args.prStats.files} file${args.prStats.files === 1 ? "" : "s"} changed, +${args.prStats.additions}/-${args.prStats.deletions}`,
    "",
  ];

  if (args.posted.length > 0) {
    lines.push(`**Review order** (${args.posted.length} finding${args.posted.length === 1 ? "" : "s"} posted inline, highest severity first):`);
    args.posted.forEach((f, i) => {
      lines.push(`${i + 1}. \`${f.severity}\` **${f.title}** — \`${f.path}:${f.startLine}\``);
    });
    lines.push("");
  } else {
    lines.push("No high-severity verified findings this run.", "");
  }

  if (args.digest.length > 0) {
    lines.push(
      "<details>",
      `<summary>${args.digest.length} more verified finding${args.digest.length === 1 ? "" : "s"} (lower priority)</summary>`,
      "",
      ...args.digest.map((f) => `- \`${f.severity}\` **${f.title}** — \`${f.path}:${f.startLine}\`: ${f.explanation}`),
      "",
      "</details>",
      "",
    );
  }

  if (args.rejected.length > 0) {
    lines.push(
      "<details>",
      `<summary>${args.rejected.length} candidate${args.rejected.length === 1 ? "" : "s"} rejected during verification</summary>`,
      "",
      ...args.rejected.map((f) => `- ~~**${f.title}**~~ — \`${f.path}:${f.startLine}\`: ${f.verifiedHow}`),
      "",
      "</details>",
      "",
    );
  }

  const total = args.posted.length + args.digest.length + args.rejected.length;
  const passNote = args.skippedPasses.length > 0 ? ` · skipped ${args.skippedPasses.join(", ")} (cost cap)` : "";
  const staleNote = args.staleIndex ? " · repo index is stale" : "";
  lines.push(
    "---",
    `_CodeFerret · ${total} candidate finding${total === 1 ? "" : "s"}, all verified before posting · ~$${args.costUsd.toFixed(3)}${passNote}${staleNote}_`,
  );

  return lines.join("\n");
}
