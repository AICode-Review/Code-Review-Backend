import { describe, expect, it } from "vitest";
import { chunkFile, hashContent } from "./chunk.js";

describe("hashContent", () => {
  it("is deterministic for identical content", () => {
    expect(hashContent("const x = 1;\n")).toBe(hashContent("const x = 1;\n"));
  });

  it("differs for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

describe("chunkFile", () => {
  it("returns a single chunk covering the whole file when under the window size", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 10 });
  });

  it("splits a large file into overlapping 60-line windows with 10-line overlap", () => {
    const content = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile(content);
    // stride = 50: windows start at 1, 51, 101
    expect(chunks.map((c) => c.startLine)).toEqual([1, 51, 101]);
    expect(chunks.map((c) => c.endLine)).toEqual([60, 110, 130]);
  });

  it("gives adjacent chunks a real overlapping region", () => {
    const content = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkFile(content);
    // chunk 1 ends at line 60, chunk 2 starts at line 51 — lines 51-60 overlap.
    expect(chunks[1]!.startLine).toBeLessThan(chunks[0]!.endLine);
  });

  it("returns no chunks for an empty file", () => {
    expect(chunkFile("")).toEqual([]);
  });

  it("assigns each chunk a content hash matching its own text", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const [chunk] = chunkFile(content);
    expect(chunk!.contentHash).toBe(hashContent(chunk!.text));
  });

  it("further splits a window whose lines are so long the joined text would blow past the embedding input cap", { timeout: 15000 }, () => {
    // A handful of huge lines (e.g. minified bundle, long data literal) inside an otherwise
    // normal 60-line window — token count, not line count, must trigger a sub-split. The WASM
    // tokenizer takes ~1-3s for this input even in isolation, and can exceed vitest's 5s
    // default under the CPU contention of a full parallel test run — give it real headroom.
    const content = Array.from({ length: 5 }, () => "x".repeat(20000)).join("\n");
    const chunks = chunkFile(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.contentHash).toBe(hashContent(chunk.text));
    }
  });
});
