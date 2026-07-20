import type { LocalFinding } from "./review.js";

const SEVERITY_ORDER: Record<LocalFinding["severity"], number> = { critical: 0, major: 1, minor: 2 };

function sorted(findings: LocalFinding[]): LocalFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path));
}

export function formatText(findings: LocalFinding[]): string {
  if (findings.length === 0) return "No verified findings. ✓";
  const lines: string[] = [`${findings.length} verified finding${findings.length === 1 ? "" : "s"}:\n`];
  for (const f of sorted(findings)) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.path}:${f.startLine}-${f.endLine} — ${f.title}`);
    lines.push(`  ${f.explanation}`);
    if (f.suggestedFix) lines.push(`  Suggested fix: ${f.suggestedFix}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatJson(findings: LocalFinding[]): string {
  return JSON.stringify(sorted(findings), null, 2);
}

/** GitHub Actions workflow-command annotations — https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions#setting-an-error-message */
export function formatGithub(findings: LocalFinding[]): string {
  return sorted(findings)
    .map((f) => {
      const level = f.severity === "critical" ? "error" : f.severity === "major" ? "warning" : "notice";
      const message = f.explanation.replace(/\r?\n/g, " ");
      return `::${level} file=${f.path},line=${f.startLine},endLine=${f.endLine},title=${f.title}::${message}`;
    })
    .join("\n");
}

export type OutputFormat = "text" | "json" | "github";

export function format(findings: LocalFinding[], fmt: OutputFormat): string {
  if (fmt === "json") return formatJson(findings);
  if (fmt === "github") return formatGithub(findings);
  return formatText(findings);
}
