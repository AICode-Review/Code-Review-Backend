import { describe, expect, it } from "vitest";
import { sandboxLanguageFor } from "./sandbox.js";

describe("sandboxLanguageFor", () => {
  it("maps JS/TS extensions to node", () => {
    expect(sandboxLanguageFor("src/foo.ts")).toBe("node");
    expect(sandboxLanguageFor("src/foo.tsx")).toBe("node");
    expect(sandboxLanguageFor("src/foo.js")).toBe("node");
    expect(sandboxLanguageFor("src/foo.mjs")).toBe("node");
  });

  it("maps .py to python", () => {
    expect(sandboxLanguageFor("app/foo.py")).toBe("python");
  });

  it("maps .java to jvm", () => {
    expect(sandboxLanguageFor("src/Foo.java")).toBe("jvm");
  });

  it("returns null for languages the sandbox doesn't cover yet", () => {
    expect(sandboxLanguageFor("src/foo.rb")).toBeNull();
    expect(sandboxLanguageFor("src/foo.go")).toBeNull();
    expect(sandboxLanguageFor("src/foo.rs")).toBeNull();
  });

  it("returns null for a path with no extension", () => {
    expect(sandboxLanguageFor("Makefile")).toBeNull();
  });
});
