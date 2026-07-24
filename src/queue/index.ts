import PgBoss from "pg-boss";
import { z } from "zod";
import { env } from "../config.js";
import { PrRefSchema } from "../types/domain.js";

export const JOBS = {
  reviewRun: "review.run",
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

export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    // Supabase's session-mode pooler caps this DATABASE_URL at 15 total connections
    // shared across every client (server + worker are separate processes, each with
    // their own pg-boss instance/pool, plus any local/dev/diagnostic connections).
    // pg-boss's own pg.Pool defaults to max:10 per instance, so two uncapped
    // instances alone can hit 20 and blow the cap — cap each process's pool small.
    boss = new PgBoss({ connectionString: env().DATABASE_URL, max: 4 });
    boss.on("error", (err) => console.error("[pg-boss]", err));
    await boss.start();
    for (const name of Object.values(JOBS)) {
      try {
        await boss.createQueue(name);
      } catch {
        // queue already exists
      }
    }
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = undefined;
  }
}

export function prSingletonKey(job: Pick<ReviewRunJob, "pr">): string {
  const r = job.pr.repo;
  return `review:${r.platform}:${r.externalId}:${job.pr.number}`;
}

/** Enqueue a review with a 90s debounce per PR — rapid pushes collapse into one run (webhook path). */
export async function enqueueReviewRun(job: ReviewRunJob): Promise<string | null> {
  const b = await getBoss();
  return b.sendDebounced(JOBS.reviewRun, job, {}, REVIEW_DEBOUNCE_SECONDS, prSingletonKey(job));
}

/** Enqueue immediately, no debounce — used for explicit user actions (manual trigger, rerun) where waiting 90s would be surprising. */
export async function enqueueReviewRunNow(job: ReviewRunJob): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.reviewRun, job);
}

export async function enqueueRulebookCompile(job: RulebookCompileJob): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.rulebookCompile, job);
}

export async function enqueueHealthSnapshot(job: HealthSnapshotJob): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.healthSnapshot, job);
}

export async function enqueueChatReply(job: ChatReplyJob): Promise<string | null> {
  const b = await getBoss();
  return b.send(JOBS.chatReply, job);
}

/** Debounced per-repo — "installed" fans out once per repo, a burst of pushes to the default branch shouldn't each trigger a full re-clone+re-embed. */
export async function enqueueIndexRepo(job: IndexRepoJob): Promise<string | null> {
  const b = await getBoss();
  return b.sendDebounced(JOBS.indexRepo, job, {}, 60, `index:${job.repoId}`);
}
