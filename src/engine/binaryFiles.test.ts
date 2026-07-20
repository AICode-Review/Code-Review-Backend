import { describe, expect, it } from "vitest";
import { isReviewableSourcePath } from "./binaryFiles.js";

describe("isReviewableSourcePath", () => {
  it("accepts source files across many languages", () => {
    for (const path of [
      "src/main.ts", "app/models.py", "cmd/server.go", "lib.rs", "Main.java",
      "index.html", "styles.scss", "schema.graphql", "main.tf", "module.ml",
    ]) {
      expect(isReviewableSourcePath(path)).toBe(true);
    }
  });

  it("rejects binary/media/archive extensions", () => {
    for (const path of [
      "logo.png", "photo.jpeg", "font.woff2", "clip.mp4", "bundle.zip",
      "app.exe", "lib.so", "report.pdf", "data.sqlite",
    ]) {
      expect(isReviewableSourcePath(path)).toBe(false);
    }
  });

  it("rejects known dependency lockfiles by basename regardless of directory", () => {
    expect(isReviewableSourcePath("package-lock.json")).toBe(false);
    expect(isReviewableSourcePath("frontend/package-lock.json")).toBe(false);
    expect(isReviewableSourcePath("yarn.lock")).toBe(false);
    expect(isReviewableSourcePath("backend/go.sum")).toBe(false);
  });

  it("does not reject a normal .json file that merely contains 'lock' in its name", () => {
    expect(isReviewableSourcePath("src/lockManager.json")).toBe(true);
  });

  it("treats an extensionless file as reviewable", () => {
    expect(isReviewableSourcePath("Makefile")).toBe(true);
    expect(isReviewableSourcePath("Dockerfile")).toBe(true);
  });

  it("rejects vendored/build-output directories regardless of nesting depth", () => {
    for (const path of [
      "node_modules/react/index.js",
      "frontend/node_modules/@electric-sql/pglite/dist/chunk.js",
      "vendor/some-lib/lib.rb",
      "backend/dist/server.js",
      "web/build/static/main.js",
      ".next/server/pages/index.js",
      "target/release/app",
      "backend/venv/lib/python3.11/site.py",
      "__pycache__/module.cpython-311.pyc",
    ]) {
      expect(isReviewableSourcePath(path)).toBe(false);
    }
  });

  it("still reviews a normal source file that merely mentions a skip-dir name in its own filename", () => {
    expect(isReviewableSourcePath("src/buildTools.ts")).toBe(true);
    expect(isReviewableSourcePath("src/vendorUtils.ts")).toBe(true);
  });
});
