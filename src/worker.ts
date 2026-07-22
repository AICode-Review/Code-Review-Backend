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

initSentry();

process.on("uncaughtException", (err) => {
  captureError(err);
  console.error("[worker] uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  captureError(err);
  console.error("[worker] unhandledRejection:", err);
});

async function main() {
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
        await handleReviewRun(parsed.data);
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

  await boss.work(JOBS.chatReply, { batchSize: 5 }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        const parsed = ChatReplyJobSchema.safeParse(job.data);
        if (!parsed.success) {
          console.error(`[worker] dropping malformed ${JOBS.chatReply} job ${job.id}:`, parsed.error.message);
          return;
        }
        console.log(`[worker] ${JOBS.chatReply} ${job.id} — ${parsed.data.pr.repo.owner}/${parsed.data.pr.repo.name}#${parsed.data.pr.number}`);
        await handleChatReply(parsed.data);
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
