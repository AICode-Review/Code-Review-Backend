import { describe, expect, it } from "vitest";
import { costUsd } from "./pricing.js";

describe("costUsd", () => {
  it("prices plain input/output tokens with no cache activity", () => {
    const cost = costUsd("claude-sonnet-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it("prices a cache write at a premium over base input", () => {
    const withCache = costUsd("claude-sonnet-5", 0, 0, { cacheCreationInputTokens: 1_000_000 });
    expect(withCache).toBeCloseTo(3 * 1.25, 6);
  });

  it("prices a cache read at a steep discount vs base input", () => {
    const withCache = costUsd("claude-sonnet-5", 0, 0, { cacheReadInputTokens: 1_000_000 });
    expect(withCache).toBeCloseTo(3 * 0.1, 6);
  });

  it("is a strict no-op when no cache fields are passed", () => {
    expect(costUsd("claude-sonnet-5", 100, 50)).toBe(costUsd("claude-sonnet-5", 100, 50, undefined));
  });

  it("falls back to the default price table entry for an unknown model", () => {
    const known = costUsd("claude-sonnet-5", 1_000_000, 0);
    const unknown = costUsd("some-future-model", 1_000_000, 0);
    expect(unknown).toBeCloseTo(known, 6);
  });
});
