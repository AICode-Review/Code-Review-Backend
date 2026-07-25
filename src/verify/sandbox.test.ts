import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

// promisify(execFile) only resolves to {stdout, stderr} (rather than just the first
// callback arg) because Node's real child_process.execFile defines the
// util.promisify.custom symbol — replicate that here so execFileAsync in sandbox.ts
// behaves exactly like the real implementation once mocked.
const execFileCustom = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: execFileCustom }),
}));

const { sandboxLanguageFor, runInSandbox } = await import("./sandbox.js");

afterEach(() => {
  execFileCustom.mockReset();
});

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

describe("runInSandbox", () => {
  it("reports available:true, reproduced:false on a clean exit 0 (test passed, defect didn't reproduce)", async () => {
    execFileCustom.mockResolvedValue({ stdout: "ok\n", stderr: "" });
    const result = await runInSandbox("node", "console.log('ok')");
    expect(result).toEqual({ available: true, reproduced: false, output: "ok\n" });
  });

  it("reports available:true, reproduced:true on a genuine non-zero exit (defect reproduced)", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1, stdout: "boom\n", stderr: "" });
    execFileCustom.mockRejectedValue(err);
    const result = await runInSandbox("node", "throw new Error('boom')");
    expect(result).toEqual({ available: true, reproduced: true, output: "boom\n" });
  });

  it("reports available:false when Docker itself isn't installed (ENOENT)", async () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    execFileCustom.mockRejectedValue(err);
    const result = await runInSandbox("node", "console.log('ok')");
    expect(result.available).toBe(false);
  });

  it.each([125, 126, 127])("reports available:false for docker-CLI-level exit code %d", async (code) => {
    const err = Object.assign(new Error(`exit ${code}`), { code, stdout: "", stderr: "docker: error" });
    execFileCustom.mockRejectedValue(err);
    const result = await runInSandbox("node", "console.log('ok')");
    expect(result.available).toBe(false);
  });

  it("reports available:false (not a confident non-repro) when the run times out — a timeout is inconclusive, not a pass", async () => {
    const err = Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL", stdout: "", stderr: "" });
    execFileCustom.mockRejectedValue(err);
    const result = await runInSandbox("node", "while (true) {}");
    expect(result.available).toBe(false);
    expect(result.reproduced).toBe(false);
  });
});
