import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  markers: new Set<string>(),
  transactionDb: { executeSql: vi.fn() },
}));
vi.mock("../queue/index.js", () => ({
  JOBS: { webhookEvent: "webhook.event" },
  getBoss: async () => ({ send: mocks.send }),
}));
vi.mock("../db/postgres.js", () => ({
  transactionDb: () => mocks.transactionDb,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const pending = new Set(mocks.markers);
    const result = await fn({
      query: async (_sql: string, args: string[]) => {
        const key = args.join(":");
        if (pending.has(key)) return { rowCount: 0, rows: [] };
        pending.add(key);
        return { rowCount: 1, rows: [{}] };
      },
    });
    mocks.markers.clear();
    for (const key of pending) mocks.markers.add(key);
    return result;
  },
}));
import { acceptWebhook, dispatchWebhook } from "../queue/webhookInbox.js";
const event = {
  kind: "pr_opened" as const,
  headSha: "sha",
  pr: {
    number: 1,
    repo: {
      platform: "github" as const,
      externalId: "1",
      owner: "acme",
      name: "repo",
      orgExternalId: "1",
      orgName: "acme",
    },
  },
};
beforeEach(() => {
  mocks.markers.clear();
  mocks.send.mockReset().mockResolvedValue("job-1");
});
describe("transactional webhook acceptance", () => {
  it.each(["github", "bitbucket"])(
    "rolls back the %s marker if enqueue fails, then deduplicates after success",
    async (platform) => {
      mocks.send.mockRejectedValueOnce(new Error("queue unavailable"));
      await expect(
        acceptWebhook(platform, "delivery-1", event),
      ).rejects.toThrow("queue unavailable");
      expect(mocks.markers.size).toBe(0);
      expect(await acceptWebhook(platform, "delivery-1", event)).toBe(true);
      expect(await acceptWebhook(platform, "delivery-1", event)).toBe(false);
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(mocks.send).toHaveBeenLastCalledWith(
        "webhook.event",
        event,
        expect.objectContaining({ db: mocks.transactionDb }),
      );
    },
  );
  it("does not acknowledge a missing queue insert", async () => {
    mocks.send.mockResolvedValueOnce(null);
    await expect(acceptWebhook("github", "missing", event)).rejects.toThrow(
      "could not be queued",
    );
    expect(mocks.markers.size).toBe(0);
  });
  it("accepts events without delivery headers independently", async () => {
    await acceptWebhook("github", undefined, event);
    await acceptWebhook("github", undefined, event);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("dispatches once and permits retry when child enqueue fails", async () => {
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error("child unavailable"))
      .mockResolvedValue(undefined);
    await expect(dispatchWebhook("job-1", handle)).rejects.toThrow();
    await dispatchWebhook("job-1", handle);
    await dispatchWebhook("job-1", handle);
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
