export interface HealthMetrics {
  riskScore: number; // 0-100
  untestedPct: number; // 0-100
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 10, major: 4, minor: 1 };

/**
 * Heuristic weekly health metrics (DESIGN.md §7, Gap 7) from a week's worth
 * of verified findings — no execution/coverage tooling in v1, so this is a
 * proxy: severity-weighted finding density for risk, and the share of
 * findings that are test-related for undertested-change signal.
 */
export function computeHealthMetrics(findings: { severity: string; category: string }[]): HealthMetrics {
  if (findings.length === 0) return { riskScore: 0, untestedPct: 0 };

  const rawScore = findings.reduce((sum, f) => sum + (SEVERITY_WEIGHT[f.severity] ?? 1), 0);
  const riskScore = Math.min(100, Math.round(rawScore));

  const testsRelated = findings.filter((f) => f.category === "tests").length;
  const untestedPct = Math.round((testsRelated / findings.length) * 100);

  return { riskScore, untestedPct };
}
