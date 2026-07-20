import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SandboxLanguage = "node" | "python" | "jvm";

const IMAGE_BY_LANGUAGE: Record<SandboxLanguage, string> = {
  node: "node:20-slim",
  python: "python:3.12-slim",
  jvm: "eclipse-temurin:21-jdk-alpine",
};

const FILE_BY_LANGUAGE: Record<SandboxLanguage, string> = {
  node: "test.js",
  python: "test.py",
  jvm: "Test.java",
};

const RUN_COMMAND_BY_LANGUAGE: Record<SandboxLanguage, string[]> = {
  node: ["node", "/repro/test.js"],
  python: ["python3", "/repro/test.py"],
  // Compiling + running in one shell invocation — Test.java's public class name is fixed by the prompt.
  jvm: ["sh", "-c", "cd /repro && javac Test.java && java Test"],
};

const TIMEOUT_MS = 60_000;
const MEMORY_LIMIT = "512m";
const CPU_LIMIT = "2";
const OUTPUT_CAP = 4000;

const LANGUAGE_BY_EXTENSION: Record<string, SandboxLanguage> = {
  js: "node", mjs: "node", cjs: "node", ts: "node", tsx: "node", jsx: "node",
  py: "python",
  java: "jvm",
};

/** DESIGN.md §7.3 — sandbox execution starts with node/python/jvm only ("Tier-1 depth to 5+ languages" is a later phase); every other extension returns null and the caller falls back to cross-exam-only verification. */
export function sandboxLanguageFor(path: string): SandboxLanguage | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

export interface SandboxResult {
  /** false = Docker itself wasn't usable (not installed, daemon down, image unavailable) — no verification signal either way, never treat as "not reproduced". */
  available: boolean;
  /** Only meaningful when available === true: the generated test failed (non-zero exit), i.e. the defect reproduced. */
  reproduced: boolean;
  output: string;
}

interface ExecFileError {
  code?: number | string;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * DESIGN.md §7.3 (M6+) — runs a generated repro test in an isolated Docker
 * container: no network, 512MB/2vCPU, 60s timeout, a locked-down security
 * profile (all Linux capabilities dropped, no-new-privileges, read-only
 * container root FS — Docker's default seccomp profile applies automatically
 * and is not further restricted here). Never throws: any Docker/infra
 * failure degrades to `available: false` so the caller falls back to
 * cross-exam-only verification instead of failing the whole run.
 */
export async function runInSandbox(language: SandboxLanguage, testCode: string): Promise<SandboxResult> {
  const dir = await mkdtemp(join(tmpdir(), "codeferret-sandbox-"));
  const containerName = `codeferret-repro-${randomUUID()}`;

  try {
    await writeFile(join(dir, FILE_BY_LANGUAGE[language]), testCode, "utf8");

    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--network", "none",
      "--memory", MEMORY_LIMIT,
      "--cpus", CPU_LIMIT,
      "--pids-limit", "128",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,size=64m",
      "-v", `${dir}:/repro`,
      IMAGE_BY_LANGUAGE[language],
      ...RUN_COMMAND_BY_LANGUAGE[language],
    ];

    try {
      const { stdout, stderr } = await execFileAsync("docker", args, { timeout: TIMEOUT_MS, killSignal: "SIGKILL" });
      // Exit 0 — the test passed, i.e. the code behaved correctly and the defect did not reproduce.
      return { available: true, reproduced: false, output: `${stdout}${stderr}`.slice(0, OUTPUT_CAP) };
    } catch (rawErr) {
      const err = rawErr as ExecFileError;
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(0, OUTPUT_CAP);

      if (err.code === "ENOENT") return { available: false, reproduced: false, output: "docker is not installed on this host" };
      if (err.killed) return { available: true, reproduced: false, output: `sandbox timed out after ${TIMEOUT_MS}ms\n${output}` };
      // Docker documents these as "the docker/container command itself failed to run" rather than the
      // test's own exit status — e.g. 125 = docker CLI error (daemon unreachable, bad flags), 126/127 =
      // the command inside the container couldn't be invoked/found at all. Any other code is the test's
      // real exit status, i.e. a genuine "the defect reproduced" signal.
      if (typeof err.code === "number" && [125, 126, 127].includes(err.code)) {
        return { available: false, reproduced: false, output };
      }
      return { available: true, reproduced: true, output };
    }
  } catch {
    return { available: false, reproduced: false, output: "" };
  } finally {
    await execFileAsync("docker", ["kill", containerName]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
