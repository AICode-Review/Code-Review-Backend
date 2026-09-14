import PgBoss from "pg-boss";
import { randomUUID } from "node:crypto";
import { transactionDb, withTransaction } from "../db/postgres.js";
import { z } from "zod";
import { env } from "../config.js";
import { PrRefSchema } from "../types/domain.js";

export const JOBS = {
  reviewRun: "review.run",
  webhookEvent: "webhook.event",
  maintenance: "operations.maintenance",
  indexRepo: "index.repo",
  verifyFinding: "verify.finding",
  rulebookCompile: "rulebook.compile",
  healthSnapshot: "health.snapshot",
  /** Weekly cron target — fans out one health.snapshot job per repo (pg-boss schedules send one static payload, not per-repo). */
  healthSnapshotFanout: "health.snapshot.fanout",
  chatReply: "chat.reply",
} as const;

export const ReviewRunJobSchema = z.object({
  pr: PrRefSchema,
  headSha: z.string(),
  reason: z.enum(["pr_opened", "pr_updated", "command", "manual", "rerun"]),
  /** When set, the worker updates this existing review_runs row instead of creating a new one — used by REST-triggered manual reviews and reruns, which create the row synchronously so the caller gets an id to navigate to immediately. */
  runId: z.string().uuid().optional(),
  /** For reruns — the run this one was cloned from, carried into review_runs.source_run_id. */
  sourceRunId: z.string().uuid().optional(),
});
export type ReviewRunJob = z.infer<typeof ReviewRunJobSchema>;

export const RulebookCompileJobSchema = z.object({
  orgId: z.string().uuid(),
  repoId: z.string().uuid(),
});
export type RulebookCompileJob = z.infer<typeof RulebookCompileJobSchema>;

export const HealthSnapshotJobSchema = z.object({
  repoId: z.string().uuid(),
});
export type HealthSnapshotJob = z.infer<typeof HealthSnapshotJobSchema>;

export const ChatReplyJobSchema = z.object({
  pr: PrRefSchema,
  /** id of OUR comment being replied to/mentioned about — the finding lookup key. */
  commentId: z.string(),
  body: z.string(),
  /** true = commentId must resolve to one of our findings or the job does nothing (never answer in a thread we don't own). false = an explicit @mention, answered even with no specific finding attached. */
  requireFinding: z.boolean(),
});
export type ChatReplyJob = z.infer<typeof ChatReplyJobSchema>;

export const IndexRepoJobSchema = z.object({
  repoId: z.string().uuid(),
  reason: z.enum(["installed", "push", "manual"]),
});
export type IndexRepoJob = z.infer<typeof IndexRepoJobSchema>;

/** Debounce window for collapsing rapid pushes to the same PR (DESIGN.md §6.1). */
export const REVIEW_DEBOUNCE_SECONDS = 90;

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

/** Share initialization across requests; never expose a partially started queue. */
export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!starting) {
    starting = (async () => {
      const candidate = new PgBoss({
        connectionString: env().DATABASE_URL,
        max: 4,
      });
      candidate.on("error", (err) => console.error("[pg-boss]", err));
      try {
        await candidate.start();
        // createQueue is idempotent. Connection/permission errors must reach the caller.
        for (const name of Object.values(JOBS))
          await candidate.createQueue(name);
        boss = candidate;
        return candidate;
      } catch (err) {
        await candidate.stop().catch(() => undefined);
        throw err;
      }
    })().finally(() => {
      starting = undefined;
    });
  }
  return starting;
}

export async function stopBoss(): Promise<void> {
  const active =
    boss ?? (starting ? await starting.catch(() => undefined) : undefined);
  if (active) {
    await active.stop();
    if (boss === active) boss = undefined;
  }
}

export function prSingletonKey(job: Pick<ReviewRunJob, "pr">): string {
  const r = job.pr.repo;
  return `review:${r.platform}:${r.externalId}:${job.pr.number}`;
}

/** Enqueue a review with a 90s debounce per PR — rapid pushes collapse into one run (webhook path). */
export async function enqueueReviewRun(
  job: ReviewRunJob,
): Promise<string | null> {
  const b = await getBoss();
  return b.sendDebounced(
    JOBS.reviewRun,
    job,
    { db: transactionDb(), retryLimit: 5, retryDelay: 30, expireInMinutes: 30 },
    REVIEW_DEBOUNCE_SECONDS,
    prSingletonKey(job),
  );
}

/** Enqueue immediately, no debounce — used for explicit user actions (manual trigger, rerun) where waiting 90s would be surprising. */
export async function enqueueReviewRunNow(
  job: ReviewRunJob,
): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.reviewRun, job, {
    db: transactionDb(),
    retryLimit: 5,
    retryDelay: 30,
    expireInMinutes: 30,
  });
}

export async function enqueueRulebookCompile(
  job: RulebookCompileJob,
): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.rulebookCompile, job, { db: transactionDb() });
}

export async function enqueueHealthSnapshot(
  job: HealthSnapshotJob,
): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.healthSnapshot, job, { db: transactionDb() });
}

export async function enqueueChatReply(
  job: ChatReplyJob,
): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.chatReply, job, { db: transactionDb() });
}

/** Debounced per-repo — "installed" fans out once per repo, a burst of pushes to the default branch shouldn't each trigger a full re-clone+re-embed. */
export async function enqueueIndexRepo(
  job: IndexRepoJob,
): Promise<string | null> {
  const b = await getBoss();
  return b.sendDebounced(
    JOBS.indexRepo,
    job,
    { db: transactionDb() },
    60,
    `index:${job.repoId}`,
  );
}

/** REST callers receive a run id only after both the row and queue job commit. */
export async function createQueuedReview(
  prId: string,
  job: ReviewRunJob,
): Promise<string> {
  await getBoss();
  return withTransaction(async (client) => {
    const id = randomUUID();
    await client.query(
      "insert into review_runs(id,pr_id,head_sha,status,trigger,source_run_id) values($1,$2,$3,'queued','manual',$4)",
      [id, prId, job.headSha, job.sourceRunId ?? null],
    );
    if (!(await enqueueReviewRunNow({ ...job, runId: id })))
      throw new Error("Review could not be queued");
    return id;
  });
}
