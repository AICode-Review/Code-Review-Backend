import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  createQueue: vi.fn(),
  stop: vi.fn(),
  constructed: vi.fn(),
}));
vi.mock("pg-boss", () => ({
  default: class {
    constructor() {
      mocks.constructed();
    }
    on() {}
    start = mocks.start;
    stop = mocks.stop;
    createQueue = mocks.createQueue;
  },
}));
vi.mock("../config.js", () => ({
  env: () => ({ DATABASE_URL: "postgresql://test" }),
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.createQueue.mockResolvedValue(undefined);
});

describe("queue lifecycle", () => {
  it("waits for one shared initialization before returning to concurrent callers", async () => {
    let release!: () => void;
    mocks.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { getBoss, JOBS } = await import("./index.js");
    let ready = false;
    const first = getBoss();
    const second = getBoss().then((value) => {
      ready = true;
      return value;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(mocks.constructed).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(await second);
    expect(mocks.createQueue).toHaveBeenCalledTimes(Object.keys(JOBS).length);
  });
  it.each(["start", "createQueue"] as const)(
    "cleans up and permits recovery after %s fails",
    async (operation) => {
      mocks[operation].mockRejectedValueOnce(new Error("database unavailable"));
      const { getBoss } = await import("./index.js");
      await expect(getBoss()).rejects.toThrow("database unavailable");
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      await expect(getBoss()).resolves.toBeDefined();
      expect(mocks.constructed).toHaveBeenCalledTimes(2);
    },
  );
  it("waits for initialization before shutdown and allows a fresh start", async () => {
    let release!: () => void;
    mocks.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { getBoss, stopBoss } = await import("./index.js");
    const pending = getBoss();
    const stopping = stopBoss();
    expect(mocks.stop).not.toHaveBeenCalled();
    release();
    await pending;
    await stopping;
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    await getBoss();
    expect(mocks.constructed).toHaveBeenCalledTimes(2);
  });
});
