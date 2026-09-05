import { pathToFileURL } from "node:url";
import {
  getBoss,
  stopBoss,
  JOBS,
  ReviewRunJobSchema,
  RulebookCompileJobSchema,
  HealthSnapshotJobSchema,
  ChatReplyJobSchema,
  IndexRepoJobSchema,
} from "./queue/index.js";
import { handleReviewRun } from "./jobs/reviewRun.js";
import { handleRulebookCompile } from "./jobs/rulebookCompile.js";
import { handleHealthSnapshot, handleHealthSnapshotFanout } from "./jobs/healthSnapshot.js";
import { handleChatReply } from "./jobs/chatReply.js";
import { handleIndexRepo } from "./jobs/indexRepo.js";
import { verifyLicense } from "./license.js";
import { captureError, initSentry } from "./observability/sentry.js";

/** DESIGN.md-style entrypoint guard (same pattern as benchmarks/src/dataset/mine.ts) — every
 * side effect below (Sentry init, global process handlers, actually connecting to pg-boss,
 * calling process.exit) is real-bootstrap-only. Importing this module from a test must be
 * inert except for exposing `main` itself, so a test can call it directly against mocked
 * dependencies without registering real signal handlers or touching a real queue connection. */
export const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (isMainModule) {
  initSentry();

  process.on("uncaughtException", (err) => {
    captureError(err);
    console.error("[worker] uncaughtException:", err);
  });
  process.on("unhandledRejection", (err) => {
    captureError(err);
    console.error("[worker] unhandledRejection:", err);
  });
}

export async function main() {
  const license = verifyLicense();
  if (!license.valid) {
    console.error(`[worker] Self-hosted license check failed: ${license.error}`);
    process.exit(1);
  }

  const boss = await getBoss();

  // batchSize > 1 + Promise.all (not a sequential for-loop) so multiple
  // review.run jobs — different PRs, or an old + a superseding new run for
  // the same PR — can genuinely overlap. That overlap is exactly the
  // scenario the in-flight cancellation checks in reviewRun.ts exist for;
  // under strictly sequential processing that code would never fire.
  //
  // Each job's error is caught HERE, inside the map, and never re-thrown — pg-boss's
  // onFetch (verified against the vendored source, manager.js's onFetch) calls the batch
  // callback once with the whole fetched array and, on ANY rejection, marks EVERY job id in
  // that batch as failed for retry — there is no per-job attribution with the array-callback
  // form. Before this, one PR's transient failure (a network blip, anything not already
  // absorbed by handleReviewRun's own internals) would make Promise.all reject and cause
  // pg-boss to retry up to 4 OTHER unrelated jobs that had ALREADY posted their PR comments,
  // sent their completion emails, and marked their own run "completed" — the retry would
  // then re-run those already-shipped reviews from scratch, duplicating externally-visible
  // side effects for orgs that had nothing to do with the original failure. handleReviewRun
  // already records its own failure onto that specific run's DB row before re-throwing
  // (see its own catch block) — that row is the authoritative failure record; pg-boss
  // automatically retrying the whole batch was never the right recovery mechanism for it, and
  // the product already has an explicit manual rerun endpoint for a genuinely failed review.
  await boss.work(JOBS.reviewRun, { batchSize: 5 }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        const parsed = ReviewRunJobSchema.safeParse(job.data);
        if (!parsed.success) {
          console.error(`[worker] dropping malformed ${JOBS.reviewRun} job ${job.id}:`, parsed.error.message);
          return;
        }
        const pr = parsed.data.pr;
        console.log(
          `[worker] ${JOBS.reviewRun} ${job.id} — ${pr.repo.owner}/${pr.repo.name}#${pr.number} (${parsed.data.reason})`,
        );
        try {
          await handleReviewRun(parsed.data);
        } catch (err) {
          captureError(err);
          console.error(`[worker] ${JOBS.reviewRun} ${job.id} failed (already recorded on its own run row):`, err);
        }
      }),
    );
  });

  await boss.work(JOBS.rulebookCompile, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const parsed = RulebookCompileJobSchema.safeParse(job.data);
      if (!parsed.success) {
        console.error(`[worker] dropping malformed ${JOBS.rulebookCompile} job ${job.id}:`, parsed.error.message);
        continue;
      }
      console.log(`[worker] ${JOBS.rulebookCompile} ${job.id} — org ${parsed.data.orgId} repo ${parsed.data.repoId}`);
      await handleRulebookCompile(parsed.data);
    }
  });

  await boss.work(JOBS.healthSnapshot, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const parsed = HealthSnapshotJobSchema.safeParse(job.data);
      if (!parsed.success) {
        console.error(`[worker] dropping malformed ${JOBS.healthSnapshot} job ${job.id}:`, parsed.error.message);
        continue;
      }
      console.log(`[worker] ${JOBS.healthSnapshot} ${job.id} — repo ${parsed.data.repoId}`);
      await handleHealthSnapshot(parsed.data);
    }
  });

  await boss.work(JOBS.healthSnapshotFanout, { batchSize: 1 }, async () => {
    console.log(`[worker] ${JOBS.healthSnapshotFanout} — fanning out per-repo health.snapshot jobs`);
    await handleHealthSnapshotFanout();
  });

  // Same isolation as JOBS.reviewRun above, and even more important here: handleChatReply
  // has no per-job persisted failure/idempotency record at all, so a pg-boss-driven retry
  // (which the un-caught version below would trigger for the ENTIRE batch on any one job's
  // failure) could post a second, duplicate bot reply into a thread that already got one.
  await boss.work(JOBS.chatReply, { batchSize: 5 }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        const parsed = ChatReplyJobSchema.safeParse(job.data);
        if (!parsed.success) {
          console.error(`[worker] dropping malformed ${JOBS.chatReply} job ${job.id}:`, parsed.error.message);
          return;
        }
        console.log(`[worker] ${JOBS.chatReply} ${job.id} — ${parsed.data.pr.repo.owner}/${parsed.data.pr.repo.name}#${parsed.data.pr.number}`);
        try {
          await handleChatReply(parsed.data);
        } catch (err) {
          captureError(err);
          console.error(`[worker] ${JOBS.chatReply} ${job.id} failed:`, err);
        }
      }),
    );
  });

  await boss.work(JOBS.indexRepo, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const parsed = IndexRepoJobSchema.safeParse(job.data);
      if (!parsed.success) {
        console.error(`[worker] dropping malformed ${JOBS.indexRepo} job ${job.id}:`, parsed.error.message);
        continue;
      }
      console.log(`[worker] ${JOBS.indexRepo} ${job.id} — repo ${parsed.data.repoId} (${parsed.data.reason})`);
      await handleIndexRepo(parsed.data);
    }
  });

  // Weekly health snapshots for every repo, Monday 06:00 UTC.
  try {
    await boss.schedule(JOBS.healthSnapshotFanout, "0 6 * * 1", {}, { tz: "UTC" });
  } catch (err) {
    console.warn("[worker] could not schedule weekly health.snapshot.fanout:", err);
  }

  console.log("[worker] ready — waiting for jobs");
}

if (isMainModule) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      await stopBoss();
      process.exit(0);
    });
  }

  main().catch((err) => {
    captureError(err);
    console.error("[worker] fatal:", err);
    process.exit(1);
  });
}
