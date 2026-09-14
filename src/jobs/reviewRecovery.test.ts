import { describe, expect, it, vi } from "vitest";
import { recoverRun } from "./reviewRecovery.js";
import type pg from "pg";
function client(status: string, delivery_started_at: string | null = null) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ status, delivery_started_at }] })
    .mockResolvedValue({ rows: [] });
  return { query };
}
describe("review recovery", () => {
  it("requeues interrupted analysis on the same reservation", async () => {
    const db = client("running");
    expect(await recoverRun(db as unknown as pg.PoolClient, "run-1")).toBe(
      "run",
    );
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining("status='queued'"),
      ["run-1"],
    );
    expect(db.query.mock.calls[1]?.[0]).not.toContain("quota_reserved_at");
  });
  it("does not repeat ambiguous remote writes", async () => {
    const db = client("running", new Date().toISOString());
    expect(await recoverRun(db as unknown as pg.PoolClient, "run-1")).toBe(
      "uncertain",
    );
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining("status='failed'"),
      ["run-1"],
    );
  });
  it.each(["completed", "failed", "cancelled"])(
    "leaves %s runs untouched",
    async (status) => {
      const db = client(status);
      expect(await recoverRun(db as unknown as pg.PoolClient, "run-1")).toBe(
        "terminal",
      );
      expect(db.query).toHaveBeenCalledTimes(1);
    },
  );
});
