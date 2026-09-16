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
import { executeReviewJob } from "./jobs/reviewRecovery.js";
import { NormalizedEventSchema } from "./types/domain.js";
import { dispatchWebhook } from "./queue/webhookInbox.js";
import { handleNormalizedEvent } from "./routes/webhooks.js";
import { maintainOperations } from "./jobs/operations.js";
import { stopPool } from "./db/postgres.js";
import { handleRulebookCompile } from "./jobs/rulebookCompile.js";
import {
  handleHealthSnapshot,
  handleHealthSnapshotFanout,
} from "./jobs/healthSnapshot.js";
import { handleChatReply } from "./jobs/chatReply.js";
import { handleIndexRepo } from "./jobs/indexRepo.js";
import { verifyLicense } from "./license.js";
import { captureError, initSentry } from "./observability/sentry.js";

/** DESIGN.md-style entrypoint guard (same pattern as benchmarks/src/dataset/mine.ts) — every
 * side effect below (Sentry init, global process handlers, actually connecting to pg-boss,
 * calling process.exit) is real-bootstrap-only. Importing this module from a test must be
 * inert except for exposing `main` itself, so a test can call it directly against mocked
 * dependencies without registering real signal handlers or touching a real queue connection. */
export const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (isMainModule) {
  initSentry();

  process.on("uncaughtException", (err) => {
    captureError(err);
    console.error("[worker] uncaughtException:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    captureError(err);
    console.error("[worker] unhandledRejection:", err);
    process.exit(1);
  });
}

export async function main() {
  const license = verifyLicense();
  if (!license.valid) {
    console.error(
      `[worker] Self-hosted license check failed: ${license.error}`,
    );
    process.exit(1);
  }

  const boss = await getBoss();

  // TEMPORARY diagnostic (2026-09-16): the same embeddings call that hangs when invoked from
  // a review job succeeded in 1.4s when tested via a plain HTTP handler in the SERVER process
  // — but server and worker are separate Node processes (concurrently), so that didn't yet
  // prove the call is fine from the WORKER process's own environment. This fires the identical
  // call from worker.ts's own startup, independent of pg-boss job processing entirely, and
  // records the result via the same worker_heartbeats checkpoint mechanism used elsewhere —
  // isolates "worker process itself" from "something specific to the review-job code path."
  // Remove once the real hang is found.
  void (async () => {
    const { embedTexts } = await import("./indexer/embeddings.js");
    const { getPool } = await import("./db/postgres.js");
    const startedAt = Date.now();
    try {
      const result = await embedTexts(["worker startup diagnostic embedding test"]);
      await getPool().query(
        "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
        [`checkpoint:worker-embed-diag:ok:durationMs=${Date.now() - startedAt}:vectors=${result.vectors.length}`],
      );
    } catch (err) {
      const message = err instanceof Error ? `${err.name}:${err.message}` : String(err);
      await getPool()
        .query(
          "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
          [`checkpoint:worker-embed-diag:error:durationMs=${Date.now() - startedAt}:${message}`.slice(0, 200)],
        )
        .catch(() => undefined);
    }
  })();

  // batchSize > 1 + Promise.all (not a sequential for-loop) so multiple
  // review.run jobs — different PRs, or an old + a superseding new run for
  // the same PR — can genuinely overlap. That overlap is exactly the
  // scenario the in-flight cancellation checks in reviewRun.ts exist for;
  // under strictly sequential processing that code would never fire.
  //
  // Fail only the affected queue id. pg-boss completion only updates active jobs,
  // so this callback resolving does not overwrite that job's retry state. Stable
  // run ids and recovery ownership make expired attempts safe to re-deliver.
  await boss.work(JOBS.reviewRun, { batchSize: 5 }, async (jobs) => {
    await Promise.all(
      jobs.map(async (job) => {
        const parsed = ReviewRunJobSchema.safeParse(job.data);
        if (!parsed.success) {
          console.error(
            `[worker] dropping malformed ${JOBS.reviewRun} job ${job.id}:`,
            parsed.error.message,
          );
          return;
        }
        const pr = parsed.data.pr;
        console.log(
          `[worker] ${JOBS.reviewRun} ${job.id} — ${pr.repo.owner}/${pr.repo.name}#${pr.number} (${parsed.data.reason})`,
        );
        try {
          await executeReviewJob(job.id, parsed.data);
        } catch (err) {
          captureError(err);
          await boss.fail(JOBS.reviewRun, job.id, {
            message: "Review attempt failed",
          });
          console.error(
            `[worker] ${JOBS.reviewRun} ${job.id} failed (already recorded on its own run row):`,
            err,
          );
        }
      }),
    );
  });

  await boss.work(JOBS.rulebookCompile, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const parsed = RulebookCompileJobSchema.safeParse(job.data);
      if (!parsed.success) {
        console.error(
          `[worker] dropping malformed ${JOBS.rulebookCompile} job ${job.id}:`,
          parsed.error.message,
        );
        continue;
      }
      console.log(
        `[worker] ${JOBS.rulebookCompile} ${job.id} — org ${parsed.data.orgId} repo ${parsed.data.repoId}`,
      );
      await handleRulebookCompile(parsed.data);
    }
  });

  await boss.work(JOBS.healthSnapshot, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const parsed = HealthSnapshotJobSchema.safeParse(job.data);
      if (!parsed.success) {
        console.error(
          `[worker] dropping malformed ${JOBS.healthSnapshot} job ${job.id}:`,
          parsed.error.message,
        );
        continue;
      }
      console.log(
        `[worker] ${JOBS.healthSnapshot} ${job.id} — repo ${parsed.data.repoId}`,
      );
      await handleHealthSnapshot(parsed.data);
    }
  });

  await boss.work(JOBS.healthSnapshotFanout, { batchSize: 1 }, async () => {
    console.log(
      `[worker] ${JOBS.healthSnapshotFanout} — fanning out per-repo health.snapshot jobs`,
    );
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
          console.error(
            `[worker] dropping malformed ${JOBS.chatReply} job ${job.id}:`,
            parsed.error.message,
          );
          return;
        }
        console.log(
          `[worker] ${JOBS.chatReply} ${job.id} — ${parsed.data.pr.repo.owner}/${parsed.data.pr.repo.name}#${parsed.data.pr.number}`,
        );
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
        console.error(
          `[worker] dropping malformed ${JOBS.indexRepo} job ${job.id}:`,
          parsed.error.message,
        );
        continue;
      }
      console.log(
        `[worker] ${JOBS.indexRepo} ${job.id} — repo ${parsed.data.repoId} (${parsed.data.reason})`,
      );
      await handleIndexRepo(parsed.data);
    }
  });

  await boss.work(JOBS.webhookEvent, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const event = NormalizedEventSchema.parse(job.data);
      await dispatchWebhook(job.id, () =>
        handleNormalizedEvent(event, console),
      );
    }
  });
  await boss.work(JOBS.maintenance, { batchSize: 1 }, async () => {
    await maintainOperations();
  });
  await boss.schedule(JOBS.maintenance, "* * * * *", {});
  await maintainOperations();

  // Weekly health snapshots for every repo, Monday 06:00 UTC.
  try {
    await boss.schedule(
      JOBS.healthSnapshotFanout,
      "0 6 * * 1",
      {},
      { tz: "UTC" },
    );
  } catch (err) {
    console.warn(
      "[worker] could not schedule weekly health.snapshot.fanout:",
      err,
    );
  }

  console.log("[worker] ready — waiting for jobs");
}

if (isMainModule) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      await stopBoss();
      await stopPool();
      process.exit(0);
    });
  }

  main().catch((err) => {
    captureError(err);
    console.error("[worker] fatal:", err);
    process.exit(1);
  });
}
