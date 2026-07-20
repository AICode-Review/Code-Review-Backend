export interface WeekPoint {
  week: string;
  findingsPosted: number;
  accepted: number;
  dismissed: number;
  acceptancePct: number;
  noisePct: number;
  medianLatencyMin: number;
}

export interface CategoryCount {
  category: string;
  count: number;
}

function startOfWeek(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay();
  const diffFromMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diffFromMonday);
  return date;
}

function formatWeekLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Buckets runs + finding feedback into weekly points for the analytics
 * dashboard (DESIGN.md §9, §10). Pure and deterministic given `now` — the
 * route glue supplies real DB rows, tests supply fixtures.
 */
export function buildWeeklyAnalytics(
  runs: { startedAt: string; posted: number; latencyMs: number | null }[],
  findings: { createdAt: string; feedback: string | null }[],
  weeksBack: number,
  now: Date = new Date(),
): WeekPoint[] {
  const buckets = new Map<
    string,
    { label: string; posted: number; accepted: number; dismissed: number; latencies: number[] }
  >();
  const currentWeekStart = startOfWeek(now);
  for (let i = weeksBack - 1; i >= 0; i--) {
    const start = new Date(currentWeekStart);
    start.setUTCDate(start.getUTCDate() - i * 7);
    const key = start.toISOString().slice(0, 10);
    buckets.set(key, { label: formatWeekLabel(start), posted: 0, accepted: 0, dismissed: 0, latencies: [] });
  }

  const keyFor = (iso: string) => startOfWeek(new Date(iso)).toISOString().slice(0, 10);

  for (const run of runs) {
    const bucket = buckets.get(keyFor(run.startedAt));
    if (!bucket) continue;
    bucket.posted += run.posted;
    if (run.latencyMs !== null) bucket.latencies.push(run.latencyMs);
  }
  for (const f of findings) {
    const bucket = buckets.get(keyFor(f.createdAt));
    if (!bucket) continue;
    if (f.feedback === "accepted" || f.feedback === "fixed") bucket.accepted++;
    if (f.feedback === "dismissed" || f.feedback === "ignored") bucket.dismissed++;
  }

  return [...buckets.values()].map((b) => {
    const feedbackTotal = b.accepted + b.dismissed;
    const medianLatencyMin = b.latencies.length > 0 ? median(b.latencies) / 60000 : 0;
    return {
      week: b.label,
      findingsPosted: b.posted,
      accepted: b.accepted,
      dismissed: b.dismissed,
      acceptancePct: feedbackTotal > 0 ? Math.round((b.accepted / feedbackTotal) * 100) : 0,
      noisePct: b.posted > 0 ? Math.round((b.dismissed / b.posted) * 1000) / 10 : 0,
      medianLatencyMin: Math.round(medianLatencyMin * 10) / 10,
    };
  });
}

export function categoryCounts(findings: { category: string }[], limit = 8): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
