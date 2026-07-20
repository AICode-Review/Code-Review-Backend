import { getDb } from "../db/client.js";
import { computeHealthMetrics } from "./healthMetrics.js";
import { enqueueHealthSnapshot, type HealthSnapshotJob } from "../queue/index.js";

function currentWeekStartISO(): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diffFromMonday);
  return date.toISOString().slice(0, 10);
}

/** DESIGN.md §14 step 14 — weekly risk/untested-change snapshot per repo (Gap 7). */
export async function handleHealthSnapshot(job: HealthSnapshotJob): Promise<void> {
  const db = getDb();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 7);

  const { data: prs } = await db.from("pull_requests").select("id").eq("repo_id", job.repoId);
  const prIds = (prs ?? []).map((p) => p.id as string);

  let findings: { severity: string; category: string }[] = [];
  if (prIds.length > 0) {
    const { data: runs } = await db
      .from("review_runs")
      .select("id")
      .in("pr_id", prIds)
      .gte("started_at", since.toISOString());
    const runIds = (runs ?? []).map((r) => r.id as string);
    if (runIds.length > 0) {
      const { data: findingRows } = await db
        .from("findings")
        .select("severity, category")
        .in("run_id", runIds)
        .eq("verification_status", "verified");
      findings = (findingRows ?? []) as { severity: string; category: string }[];
    }
  }

  const metrics = computeHealthMetrics(findings);
  const { error } = await db
    .from("health_snapshots")
    .upsert({ repo_id: job.repoId, week: currentWeekStartISO(), metrics }, { onConflict: "repo_id,week" });
  if (error) throw new Error(`db: failed to upsert health_snapshot: ${error.message}`);
}

/** Weekly cron target — enqueues one health.snapshot job per repo that has had at least one review run. */
export async function handleHealthSnapshotFanout(): Promise<void> {
  const db = getDb();
  const { data: repos, error } = await db.from("repos").select("id");
  if (error) throw new Error(`db: failed to list repos for health snapshot fanout: ${error.message}`);
  for (const repo of repos ?? []) {
    await enqueueHealthSnapshot({ repoId: repo.id as string });
  }
}
