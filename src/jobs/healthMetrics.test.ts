import { describe, expect, it } from "vitest";
import { computeHealthMetrics } from "./healthMetrics.js";

describe("computeHealthMetrics", () => {
  it("returns zeroes for no findings", () => {
    expect(computeHealthMetrics([])).toEqual({ riskScore: 0, untestedPct: 0 });
  });

  it("weights critical findings much more heavily than minor", () => {
    const critical = computeHealthMetrics([{ severity: "critical", category: "security" }]);
    const minor = computeHealthMetrics([{ severity: "minor", category: "style" }]);
    expect(critical.riskScore).toBeGreaterThan(minor.riskScore);
  });

  it("caps riskScore at 100", () => {
    const many = Array.from({ length: 20 }, () => ({ severity: "critical", category: "logic" }));
    expect(computeHealthMetrics(many).riskScore).toBe(100);
  });

  it("computes untestedPct as the share of tests-category findings", () => {
    const findings = [
      { severity: "major", category: "tests" },
      { severity: "major", category: "tests" },
      { severity: "major", category: "logic" },
      { severity: "major", category: "security" },
    ];
    expect(computeHealthMetrics(findings).untestedPct).toBe(50);
  });
});
