import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOBS, type ReviewRunJob, type ChatReplyJob } from "./queue/index.js";

/**
 * worker.ts is a bootstrap entrypoint (registers real signal handlers, connects to a real
 * queue, calls process.exit on fatal errors) — importing it must be inert except for exposing
 * `main`, which `isMainModule` (worker.ts's own guard, same pattern as
 * benchmarks/src/dataset/mine.ts) ensures as long as this test never looks like `node
 * worker.js` to `process.argv[1]`. Every real dependency main() would otherwise touch is
 * mocked below so this test never opens a real DB/queue connection or registers a real
 * process-level handler.
 */

const handleReviewRunMock = vi.fn(async (_job: ReviewRunJob) => {});
vi.mock("./jobs/reviewRun.js", () => ({ handleReviewRun: (job: ReviewRunJob) => handleReviewRunMock(job) }));

const handleChatReplyMock = vi.fn(async (_job: ChatReplyJob) => {});
vi.mock("./jobs/chatReply.js", () => ({ handleChatReply: (job: ChatReplyJob) => handleChatReplyMock(job) }));

const handleRulebookCompileMock = vi.fn(async () => {});
vi.mock("./jobs/rulebookCompile.js", () => ({ handleRulebookCompile: () => handleRulebookCompileMock() }));

const handleHealthSnapshotMock = vi.fn(async () => {});
const handleHealthSnapshotFanoutMock = vi.fn(async () => {});
vi.mock("./jobs/healthSnapshot.js", () => ({
  handleHealthSnapshot: () => handleHealthSnapshotMock(),
  handleHealthSnapshotFanout: () => handleHealthSnapshotFanoutMock(),
}));

const handleIndexRepoMock = vi.fn(async () => {});
vi.mock("./jobs/indexRepo.js", () => ({ handleIndexRepo: () => handleIndexRepoMock() }));

vi.mock("./license.js", () => ({ verifyLicense: () => ({ valid: true }) }));

const captureErrorMock = vi.fn();
vi.mock("./observability/sentry.js", () => ({ captureError: (err: unknown) => captureErrorMock(err), initSentry: vi.fn() }));

interface CapturedWork {
  name: string;
  opts: unknown;
  callback: (jobs: Array<{ id: string; data: unknown }>) => Promise<void>;
}
const capturedWork: CapturedWork[] = [];
const scheduleMock = vi.fn(async () => {});
const workMock = vi.fn((name: string, opts: unknown, callback: CapturedWork["callback"]) => {
  capturedWork.push({ name, opts, callback });
  return Promise.resolve();
});

vi.mock("./queue/index.js", async (importActual) => {
  const actual = await importActual<typeof import("./queue/index.js")>();
  return {
    ...actual,
    getBoss: vi.fn(async () => ({ work: workMock, schedule: scheduleMock })),
    stopBoss: vi.fn(async () => {}),
  };
});

const BASE_PR = { repo: { platform: "github" as const, externalId: "repo-1", owner: "acme", name: "widgets", orgExternalId: "org-1", orgName: "Acme", isPrivate: false }, number: 1 };

function reviewRunJobRow(id: string, prNumber = 1) {
  const data: ReviewRunJob = { pr: { ...BASE_PR, number: prNumber }, headSha: "sha", reason: "pr_opened" };
  return { id, data };
}

function chatReplyJobRow(id: string, commentId: string) {
  const data: ChatReplyJob = { pr: BASE_PR, commentId, body: "why is this flagged?", requireFinding: true };
  return { id, data };
}

async function bootWorker() {
  capturedWork.length = 0;
  workMock.mockClear();
  scheduleMock.mockClear();
  vi.resetModules();
  const { main } = await import("./worker.js");
  await main();
}

function workFor(jobName: string): CapturedWork {
  const found = capturedWork.find((w) => w.name === jobName);
  if (!found) throw new Error(`no boss.work(...) registration captured for "${jobName}"`);
  return found;
}

beforeEach(() => {
  handleReviewRunMock.mockReset().mockImplementation(async () => {});
  handleChatReplyMock.mockReset().mockImplementation(async () => {});
  captureErrorMock.mockReset();
});

describe("worker.ts main() — job registration", () => {
  it("registers every job type with pg-boss, batchSize 5 for reviewRun/chatReply and 1 for the sequential ones", async () => {
    await bootWorker();
    const names = capturedWork.map((w) => w.name);
    expect(names).toEqual(
      expect.arrayContaining([JOBS.reviewRun, JOBS.rulebookCompile, JOBS.healthSnapshot, JOBS.healthSnapshotFanout, JOBS.chatReply, JOBS.indexRepo]),
    );
    expect(workFor(JOBS.reviewRun).opts).toMatchObject({ batchSize: 5 });
    expect(workFor(JOBS.chatReply).opts).toMatchObject({ batchSize: 5 });
    expect(workFor(JOBS.rulebookCompile).opts).toMatchObject({ batchSize: 1 });
  });

  it("schedules the weekly health.snapshot.fanout cron", async () => {
    await bootWorker();
    expect(scheduleMock).toHaveBeenCalledWith(JOBS.healthSnapshotFanout, "0 6 * * 1", {}, { tz: "UTC" });
  });
});

describe("worker.ts main() — review.run batch isolation (the actual bug fix)", () => {
  it("processes every job in a batch even when one of them throws — a batch callback must never reject", async () => {
    await bootWorker();
    handleReviewRunMock.mockImplementation(async (job: ReviewRunJob) => {
      if (job.pr.number === 2) throw new Error("transient failure for PR #2");
    });

    const jobs = [reviewRunJobRow("job-1", 1), reviewRunJobRow("job-2", 2), reviewRunJobRow("job-3", 3)];

    // The whole point of the fix: this must resolve, not reject. Before the fix, pg-boss's
    // onFetch would see this reject and mark ALL THREE job ids as failed for retry — including
    // #1 and #3, which had already succeeded.
    await expect(workFor(JOBS.reviewRun).callback(jobs)).resolves.toBeUndefined();

    expect(handleReviewRunMock).toHaveBeenCalledTimes(3);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((captureErrorMock.mock.calls[0]?.[0] as Error).message).toContain("PR #2");
  });

  it("drops a malformed job without invoking the handler or affecting its batch-mates", async () => {
    await bootWorker();
    const jobs = [{ id: "job-1", data: { not: "a valid review run job" } }, reviewRunJobRow("job-2", 2)];

    await expect(workFor(JOBS.reviewRun).callback(jobs)).resolves.toBeUndefined();
    expect(handleReviewRunMock).toHaveBeenCalledTimes(1);
  });
});

describe("worker.ts main() — chat.reply batch isolation", () => {
  it("processes every job in a batch even when one of them throws", async () => {
    await bootWorker();
    handleChatReplyMock.mockImplementation(async (job: ChatReplyJob) => {
      if (job.commentId === "comment-2") throw new Error("duplicate-reply risk avoided");
    });

    const jobs = [chatReplyJobRow("job-1", "comment-1"), chatReplyJobRow("job-2", "comment-2"), chatReplyJobRow("job-3", "comment-3")];

    await expect(workFor(JOBS.chatReply).callback(jobs)).resolves.toBeUndefined();
    expect(handleChatReplyMock).toHaveBeenCalledTimes(3);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("worker.ts main() — sequential (batchSize 1) job types are unaffected by the isolation fix", () => {
  it("still processes rulebook.compile jobs one at a time via a plain for-loop", async () => {
    await bootWorker();
    const jobs = [{ id: "job-1", data: { orgId: "00000000-0000-0000-0000-000000000001", repoId: "00000000-0000-0000-0000-000000000002" } }];
    await workFor(JOBS.rulebookCompile).callback(jobs);
    expect(handleRulebookCompileMock).toHaveBeenCalledTimes(1);
  });
});
