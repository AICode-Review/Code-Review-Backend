import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeReviewConfig } from "./configInit.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codeferret-cli-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeReviewConfig", () => {
  it("writes a valid-JSON .review.yml with the expected defaults", async () => {
    const { path, wrote } = await writeReviewConfig(dir, false);
    expect(wrote).toBe(true);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content).toEqual({
      strictness: "standard",
      commentBudget: 7,
      ignoredPaths: ["**/dist/**", "**/node_modules/**", "**/*.min.js"],
      failOnCritical: true,
    });
  });

  it("does not overwrite an existing .review.yml without --force", async () => {
    const path = join(dir, ".review.yml");
    await writeFile(path, '{"strictness":"strict"}', "utf8");
    const result = await writeReviewConfig(dir, false);
    expect(result.wrote).toBe(false);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.strictness).toBe("strict"); // untouched
  });

  it("overwrites when force is true", async () => {
    const path = join(dir, ".review.yml");
    await writeFile(path, '{"strictness":"strict"}', "utf8");
    const result = await writeReviewConfig(dir, true);
    expect(result.wrote).toBe(true);
    const content = JSON.parse(await readFile(path, "utf8"));
    expect(content.strictness).toBe("standard");
  });
});
