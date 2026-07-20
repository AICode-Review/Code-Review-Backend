import { describe, expect, it } from "vitest";
import { buildWeeklyAnalytics, categoryCounts } from "./analyticsAggregation.js";

const NOW = new Date("2026-07-10T12:00:00Z"); // a Friday

describe("buildWeeklyAnalytics", () => {
  it("returns exactly weeksBack buckets, oldest first, zeroed when there's no data", () => {
    const result = buildWeeklyAnalytics([], [], 4, NOW);
    expect(result).toHaveLength(4);
    expect(result.every((w) => w.findingsPosted === 0 && w.acceptancePct === 0)).toBe(true);
  });

  it("sums posted counts and computes acceptance/noise percentages for the right week", () => {
    const runs = [
      { startedAt: "2026-07-08T10:00:00Z", posted: 3, latencyMs: 120_000 },
      { startedAt: "2026-07-09T10:00:00Z", posted: 2, latencyMs: 180_000 },
    ];
    const findings = [
      { createdAt: "2026-07-08T10:05:00Z", feedback: "accepted" },
      { createdAt: "2026-07-08T10:06:00Z", feedback: "dismissed" },
      { createdAt: "2026-07-09T10:05:00Z", feedback: "fixed" },
    ];
    const result = buildWeeklyAnalytics(runs, findings, 2, NOW);
    const thisWeek = result[result.length - 1]!;
    expect(thisWeek.findingsPosted).toBe(5);
    expect(thisWeek.accepted).toBe(2); // accepted + fixed
    expect(thisWeek.dismissed).toBe(1);
    expect(thisWeek.acceptancePct).toBe(67); // 2/3 rounded
    expect(thisWeek.noisePct).toBe(20); // 1/5 posted
    expect(thisWeek.medianLatencyMin).toBe(2.5); // median(120s,180s) = 150s = 2.5min
  });

  it("drops data outside the requested window", () => {
    const runs = [{ startedAt: "2026-01-01T00:00:00Z", posted: 99, latencyMs: 1000 }];
    const result = buildWeeklyAnalytics(runs, [], 2, NOW);
    expect(result.every((w) => w.findingsPosted === 0)).toBe(true);
  });

  it("handles a run with null latency without crashing the median", () => {
    const runs = [{ startedAt: "2026-07-09T10:00:00Z", posted: 1, latencyMs: null }];
    const result = buildWeeklyAnalytics(runs, [], 1, NOW);
    expect(result[0]?.medianLatencyMin).toBe(0);
  });
});

describe("categoryCounts", () => {
  it("counts and sorts descending", () => {
    const findings = [
      { category: "logic" }, { category: "logic" }, { category: "security" }, { category: "logic" }, { category: "tests" },
    ];
    expect(categoryCounts(findings)).toEqual([
      { category: "logic", count: 3 },
      { category: "security", count: 1 },
      { category: "tests", count: 1 },
    ]);
  });

  it("respects the limit", () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({ category: `cat${i}` }));
    expect(categoryCounts(findings, 3)).toHaveLength(3);
  });

  it("returns an empty array for no findings", () => {
    expect(categoryCounts([])).toEqual([]);
  });
});
