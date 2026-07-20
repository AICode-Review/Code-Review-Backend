import { describe, expect, it } from "vitest";
import { extractCodeSnippet } from "./snippet.js";

const CONTENT = ["one", "two", "three", "four", "five", "six"].join("\n");

describe("extractCodeSnippet", () => {
  it("extracts the exact cited single line with one line of context on each side", () => {
    expect(extractCodeSnippet(CONTENT, 3, 3)).toBe("two\nthree\nfour");
  });

  it("extracts a multi-line range with context", () => {
    expect(extractCodeSnippet(CONTENT, 2, 4)).toBe("one\ntwo\nthree\nfour\nfive");
  });

  it("clamps context at the start of the file", () => {
    expect(extractCodeSnippet(CONTENT, 1, 1)).toBe("one\ntwo");
  });

  it("clamps context at the end of the file", () => {
    expect(extractCodeSnippet(CONTENT, 6, 6)).toBe("five\nsix");
  });

  it("returns null when startLine is beyond the file's length", () => {
    expect(extractCodeSnippet(CONTENT, 99, 99)).toBeNull();
  });

  it("returns null for an invalid line range", () => {
    expect(extractCodeSnippet(CONTENT, 0, 1)).toBeNull();
    expect(extractCodeSnippet(CONTENT, 4, 2)).toBeNull();
  });

  it("respects a custom contextLines value", () => {
    expect(extractCodeSnippet(CONTENT, 3, 3, 0)).toBe("three");
    expect(extractCodeSnippet(CONTENT, 3, 3, 2)).toBe("one\ntwo\nthree\nfour\nfive");
  });
});
