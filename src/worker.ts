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

// TEMPORARY diagnostic (2026-09-16): a worker-startup IIFE test (5 calls: solo, repeat,
// 3-concurrent) all succeeded in under a second each, ruling out the OpenAI API/SDK,
// environment, worker process itself, repeat-call degradation, and plain concurrency as the
// cause. The one thing that test COULDN'T cover: running from inside an actual pg-boss
// boss.work() job callback, which is how the real, hanging call is invoked. Piggybacks on the
// existing maintenance job (already scheduled every minute) to test exactly that, guarded to
// fire once. Remove once the real hang is found.
let ranEmbedDiagFromJobCallback = false;
async function runEmbedDiagFromJobCallback(): Promise<void> {
  if (ranEmbedDiagFromJobCallback) return;
  ranEmbedDiagFromJobCallback = true;
  const { embedTexts } = await import("./indexer/embeddings.js");
  const { getPool } = await import("./db/postgres.js");
  const startedAt = Date.now();
  try {
    const result = await embedTexts(["diagnostic call from inside boss.work() callback"]);
    await getPool().query(
      "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
      [`checkpoint:worker-embed-diag:6_from_job_callback:ok:durationMs=${Date.now() - startedAt}:vectors=${result.vectors.length}`],
    );
  } catch (err) {
    const message = err instanceof Error ? `${err.name}:${err.message}` : String(err);
    await getPool()
      .query(
        "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
        [`checkpoint:worker-embed-diag:6_from_job_callback:error:durationMs=${Date.now() - startedAt}:${message}`.slice(0, 200)],
      )
      .catch(() => undefined);
  }
}

// TEMPORARY diagnostic (2026-09-16): every isolated piece of the real path has now succeeded —
// the API/SDK, the worker process, repeat calls, concurrent calls, and running inside an actual
// boss.work() callback. The one remaining structural difference between all of those tests and
// jobs/reviewRecovery.ts's executeReviewJob (the real caller) is that it acquires a raw pg
// Client via getPool().connect() and holds it open — with an 'error' listener registered — for
// the review's ENTIRE duration, including while embedTexts runs. This replicates exactly that:
// hold a real client open the same way, then call embedTexts while it's held, to test whether
// holding that connection open is itself the differentiator. Remove once the real hang is found.
let ranEmbedDiagWithHeldClient = false;
async function runEmbedDiagWithHeldClient(): Promise<void> {
  if (ranEmbedDiagWithHeldClient) return;
  ranEmbedDiagWithHeldClient = true;
  const { embedTexts } = await import("./indexer/embeddings.js");
  const { getPool } = await import("./db/postgres.js");
  const pool = getPool();
  const heldClient = await pool.connect();
  let healthy = true;
  const onError = () => {
    healthy = false;
  };
  heldClient.on("error", onError);
  const startedAt = Date.now();
  try {
    const result = await embedTexts(["diagnostic call while holding a raw pg client open"]);
    await pool.query(
      "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
      [`checkpoint:worker-embed-diag:7_with_held_client:ok:durationMs=${Date.now() - startedAt}:vectors=${result.vectors.length}`],
    );
  } catch (err) {
    const message = err instanceof Error ? `${err.name}:${err.message}` : String(err);
    await pool
      .query(
        "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
        [`checkpoint:worker-embed-diag:7_with_held_client:error:durationMs=${Date.now() - startedAt}:${message}`.slice(0, 200)],
      )
      .catch(() => undefined);
  } finally {
    heldClient.removeListener("error", onError);
    heldClient.release(!healthy);
  }
}

// TEMPORARY diagnostic (2026-09-16): embedTexts() alone has now succeeded every way it's been
// tested — solo, repeated, concurrent, from inside a real boss.work() callback, and while
// holding a raw pg client open. None of those tests called getDb() (the Supabase client) at
// all beforehand, but the real path makes two real Supabase queries (definitions, callers)
// inside getContext() immediately before reaching embedTexts. This calls the REAL getContext()
// function directly — same Supabase client, same real repoId, plausible arguments — to test
// getContext as a whole rather than embedTexts in isolation. Remove once the real hang is found.
let ranGetContextDiag = false;
async function runGetContextDiag(): Promise<void> {
  if (ranGetContextDiag) return;
  ranGetContextDiag = true;
  const { getContext } = await import("./indexer/context.js");
  const { getDb } = await import("./db/client.js");
  const { getPool } = await import("./db/postgres.js");
  const startedAt = Date.now();
  try {
    const result = await getContext(
      getDb(),
      "a5f9c966-1b12-4d9d-a21a-0b2fa38ee053",
      ["readUserFile", "listUploads"],
      "diagnostic query text for getContext",
    );
    await getPool().query(
      "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
      [`checkpoint:worker-embed-diag:8_getContext:ok:durationMs=${Date.now() - startedAt}:chunks=${result.similarChunks.length}`],
    );
  } catch (err) {
    const message = err instanceof Error ? `${err.name}:${err.message}` : String(err);
    await getPool()
      .query(
        "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
        [`checkpoint:worker-embed-diag:8_getContext:error:durationMs=${Date.now() - startedAt}:${message}`.slice(0, 200)],
      )
      .catch(() => undefined);
  }
}

// TEMPORARY diagnostic (2026-09-16): getContext() as a whole (real Supabase queries + a real
// embedTexts call) has now succeeded too, with zero GitHub API activity beforehand. The real
// review pipeline makes 1-3 real GitHub API calls via Octokit (getPrInfo, getDiff, getFile)
// immediately before reaching this same point — Octokit uses native fetch/undici, while the
// OpenAI SDK uses node-fetch, different transport stacks, but both consume the same OS file
// descriptors and the same libuv DNS/TLS threadpool. This is the one remaining untested
// combination: make real Octokit calls against the actual test PR first, then call getContext,
// in the same job invocation. Remove once the real hang is found.
let ranGithubThenGetContextDiag = false;
async function runGithubThenGetContextDiag(): Promise<void> {
  if (ranGithubThenGetContextDiag) return;
  ranGithubThenGetContextDiag = true;
  const { getAdapter } = await import("./adapters/index.js");
  const { getContext } = await import("./indexer/context.js");
  const { getDb } = await import("./db/client.js");
  const { getPool } = await import("./db/postgres.js");
  const pool = getPool();
  const startedAt = Date.now();
  const stage = { name: "start" };
  try {
    const adapter = getAdapter("github");
    const pr = {
      repo: {
        platform: "github" as const,
        externalId: "1306464091",
        owner: "dineshmagizh93",
        name: "Demo",
        orgExternalId: "225228105",
        orgName: "dineshmagizh93",
        installationId: 159476908,
      },
      number: 9,
    };
    stage.name = "getPrInfo";
    const prInfo = await adapter.getPrInfo(pr);
    await pool.query(
      "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
      [`checkpoint:worker-embed-diag:9_github_then_getContext:a_got_pr_info:${Date.now() - startedAt}ms`],
    );
    stage.name = "getDiff";
    await adapter.getDiff(pr);
    await pool.query(
      "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
      [`checkpoint:worker-embed-diag:9_github_then_getContext:b_got_diff:${Date.now() - startedAt}ms`],
    );
    stage.name = "getFile";
    await adapter.getFile(pr.repo, "scrutinye-test/launchReadinessCheck.js", prInfo.headSha);
    await pool.query(
      "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
      [`checkpoint:worker-embed-diag:9_github_then_getContext:c_got_file:${Date.now() - startedAt}ms`],
    );
    stage.name = "getContext";
    const result = await getContext(
      getDb(),
      "a5f9c966-1b12-4d9d-a21a-0b2fa38ee053",
      ["readUserFile", "listUploads"],
      "diagnostic query text after real github calls",
    );
    await pool.query(
      "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
      [`checkpoint:worker-embed-diag:9_github_then_getContext:ok:durationMs=${Date.now() - startedAt}:chunks=${result.similarChunks.length}`],
    );
  } catch (err) {
    const message = err instanceof Error ? `${err.name}:${err.message}` : String(err);
    await pool
      .query(
        "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
        [`checkpoint:worker-embed-diag:9_github_then_getContext:error_at_${stage.name}:durationMs=${Date.now() - startedAt}:${message}`.slice(0, 200)],
      )
      .catch(() => undefined);
  }
}

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
    void runEmbedDiagFromJobCallback();
    void runEmbedDiagWithHeldClient();
    void runGetContextDiag();
    void runGithubThenGetContextDiag();
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
