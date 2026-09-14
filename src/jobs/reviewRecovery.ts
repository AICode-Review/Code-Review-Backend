import { getPool } from "../db/postgres.js";
import { getDb } from "../db/client.js";
import { upsertPrChain } from "../db/repositories.js";
import { getAdapter } from "../adapters/index.js";
import { handleReviewRun } from "./reviewRun.js";
import type { ReviewRunJob } from "../queue/index.js";
import type { PlatformAdapter } from "../adapters/types.js";
import type pg from "pg";

export type RecoveryDecision = "run" | "terminal" | "uncertain";
/** Called only while holding the run's exclusive session lock. */
export async function recoverRun(
  client: Pick<pg.PoolClient, "query">,
  runId: string,
): Promise<RecoveryDecision> {
  const result = await client.query(
    "select status, delivery_started_at from review_runs where id=$1",
    [runId],
  );
  const row = result.rows[0] as
    { status: string; delivery_started_at: string | null } | undefined;
  if (!row || row.status === "queued") return "run";
  if (row.status !== "running") return "terminal";
  if (row.delivery_started_at) {
    await client.query(
      "update review_runs set status='failed',finished_at=now(),error='Worker interrupted during delivery. Some comments may already exist; inspect the PR before requesting another review.' where id=$1 and status='running'",
      [runId],
    );
    return "uncertain";
  }
  // The same id retains its reservation; recovery is not billed as another review.
  await client.query(
    "update review_runs set status='queued',error=null where id=$1 and status='running'",
    [runId],
  );
  return "run";
}

/** pg-boss retries retain job ids. Serialize attempts on that stable id, not a fresh run. */
export async function executeReviewJob(
  queueId: string,
  job: ReviewRunJob,
): Promise<void> {
  const runId = job.runId ?? queueId;
  const client = await getPool().connect();
  let locked = false;
  let healthy = true;
  const onError = () => {
    healthy = false;
  };
  client.on("error", onError);
  try {
    const lock = await client.query(
      "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
      ["review:" + runId],
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked)
      throw new Error("Review is still owned by another worker; retry later");
    const decision = await recoverRun(client, runId);
    if (decision === "terminal") return;
    if (decision === "uncertain") {
      // Do not retry ambiguous comments or completion email. Make the failure actionable.
      console.error("[review recovery] delivery outcome uncertain", { runId });
      const stored = await client.query(
        "select head_sha from review_runs where id=$1",
        [runId],
      );
      await getAdapter(job.pr.repo.platform).setStatus(job.pr, {
        headSha: String(stored.rows[0]?.head_sha ?? job.headSha),
        state: "failure",
        title: "Review interrupted",
        summary:
          "Scrutinye was interrupted during delivery. Some comments may already exist. Inspect this PR and the failed run before requesting another review.",
      });
      return;
    }
    const db = getDb();
    const { prId } = await upsertPrChain(db, job.pr, job.headSha);
    await client.query(
      "insert into review_runs(id,pr_id,head_sha,status,trigger,source_run_id) values($1,$2,$3,'queued',$4,$5) on conflict(id) do nothing",
      [
        runId,
        prId,
        job.headSha,
        job.reason === "manual" || job.reason === "rerun"
          ? "manual"
          : "automatic",
        job.sourceRunId ?? null,
      ],
    );
    const adapter = getAdapter(job.pr.repo.platform);
    const writes = new Set([
      "postSummary",
      "postLineComment",
      "updateComment",
      "setStatus",
    ]);
    const guarded = new Proxy(adapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (!writes.has(String(property))) return value.bind(target);
        return async (...args: unknown[]) => {
          if (!healthy) throw new Error("Review ownership connection was lost");
          await client.query("select 1");
          const state = await client.query(
            "select status from review_runs where id=$1",
            [runId],
          );
          if (
            state.rows[0]?.status === "cancelled" ||
            (property !== "setStatus" && state.rows[0]?.status !== "running")
          )
            throw new Error("Review was superseded before delivery");
          return value.apply(target, args);
        };
      },
    }) as PlatformAdapter;
    await handleReviewRun({ ...job, runId }, { adapter: guarded });
  } finally {
    if (locked && healthy)
      await client
        .query("select pg_advisory_unlock(hashtextextended($1,0))", [
          "review:" + runId,
        ])
        .catch(() => {
          healthy = false;
        });
    client.removeListener("error", onError);
    client.release(!healthy);
  }
}
