import { describe, expect, it } from "vitest";
import { matchesIgnoredPath } from "./ignorePaths.js";

describe("matchesIgnoredPath", () => {
  it("matches an exact path", () => {
    expect(matchesIgnoredPath("src/foo.ts", ["src/foo.ts"])).toBe(true);
    expect(matchesIgnoredPath("src/bar.ts", ["src/foo.ts"])).toBe(false);
  });

  it("matches a single-level wildcard within a directory", () => {
    expect(matchesIgnoredPath("src/foo.gen.ts", ["src/*.gen.ts"])).toBe(true);
    expect(matchesIgnoredPath("src/nested/foo.gen.ts", ["src/*.gen.ts"])).toBe(false);
  });

  it("matches a globstar across any depth", () => {
    expect(matchesIgnoredPath("a/b/c/foo.gen.ts", ["**/*.gen.ts"])).toBe(true);
    expect(matchesIgnoredPath("foo.gen.ts", ["**/*.gen.ts"])).toBe(true);
    expect(matchesIgnoredPath("a/b/vendor/lib.ts", ["vendor/**"])).toBe(false);
    expect(matchesIgnoredPath("vendor/lib.ts", ["vendor/**"])).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchesIgnoredPath("src/foo.ts", ["**/*.gen.ts", "vendor/**"])).toBe(false);
  });

  it("returns false for an empty pattern list", () => {
    expect(matchesIgnoredPath("src/foo.ts", [])).toBe(false);
  });
});
