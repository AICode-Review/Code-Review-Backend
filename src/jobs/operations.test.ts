import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db/postgres.js", () => ({
  getPool: () => ({ query: mocks.query }),
}));
import { checkReadiness, maintainOperations } from "./operations.js";
beforeEach(() => {
  mocks.query.mockReset();
});
describe("operational readiness", () => {
  it.each([true, false])(
    "reports readiness %s from database/queue/worker checks",
    async (ready) => {
      mocks.query.mockResolvedValue({ rows: [{ ready }] });
      expect(await checkReadiness()).toBe(ready);
    },
  );
  it("propagates dependency failure for the HTTP route to return 503", async () => {
    mocks.query.mockRejectedValue(new Error("database unavailable"));
    await expect(checkReadiness()).rejects.toThrow();
  });
  it("writes a heartbeat and reports stalled/exhausted jobs", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "run-1" }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValue({ rows: [] });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await maintainOperations();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
