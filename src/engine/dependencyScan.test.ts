import { describe, expect, it } from "vitest";
import { extractDependencyBumps, scanDependencies, type OsvVuln } from "./dependencyScan.js";
import { buildPrDiff } from "./diff.js";

function diffAdding(path: string, ...addedLines: string[]): ReturnType<typeof buildPrDiff> {
  const hunk = addedLines.map((l) => `+${l}`).join("\n");
  const diffText = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${addedLines.length} @@\n${hunk}\n`;
  return buildPrDiff({ baseSha: "base", headSha: "head", diffText });
}

describe("extractDependencyBumps", () => {
  it("extracts an npm dependency version from an added package.json line", () => {
    const prDiff = diffAdding("package.json", '"lodash": "4.17.20",');
    const bumps = extractDependencyBumps(prDiff);
    expect(bumps).toEqual([{ path: "package.json", lineNo: 1, ecosystem: "npm", name: "lodash", version: "4.17.20", lineText: '"lodash": "4.17.20",' }]);
  });

  it("strips a caret/tilde/range prefix down to the concrete version", () => {
    const prDiff = diffAdding("package.json", '"express": "^4.18.2"');
    const [bump] = extractDependencyBumps(prDiff);
    expect(bump?.version).toBe("4.18.2");
  });

  it("extracts a PyPI dependency from an added requirements.txt line", () => {
    const prDiff = diffAdding("requirements.txt", "requests==2.25.0");
    const bumps = extractDependencyBumps(prDiff);
    expect(bumps).toEqual([{ path: "requirements.txt", lineNo: 1, ecosystem: "PyPI", name: "requests", version: "2.25.0", lineText: "requests==2.25.0" }]);
  });

  it("ignores non-dependency string fields in package.json (name, description, scripts)", () => {
    const prDiff = diffAdding(
      "package.json",
      '"name": "my-app",',
      '"description": "does a thing",',
      '"scripts": {',
      '"test": "vitest"',
    );
    expect(extractDependencyBumps(prDiff)).toHaveLength(0);
  });

  it("ignores a package.json line whose value isn't semver-shaped", () => {
    const prDiff = diffAdding("package.json", '"main": "index.js",');
    expect(extractDependencyBumps(prDiff)).toHaveLength(0);
  });

  it("ignores requirements.txt lines using >= rather than an exact pin", () => {
    // >= doesn't name one concrete version to check — out of scope for this curated parser.
    const prDiff = diffAdding("requirements.txt", "flask>=2.0.0");
    expect(extractDependencyBumps(prDiff)).toHaveLength(0);
  });

  it("ignores files that aren't a recognized manifest", () => {
    const prDiff = diffAdding("src/config.ts", 'const version = "4.17.20";');
    expect(extractDependencyBumps(prDiff)).toHaveLength(0);
  });

  it("does not flag a deleted or context line, only what this diff adds", () => {
    const diffText = [
      "diff --git a/package.json b/package.json",
      "index 1111111..2222222 100644",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,1 +1,1 @@",
      '-"lodash": "4.17.19",',
      '+"lodash": "4.17.20",',
      "",
    ].join("\n");
    const prDiff = buildPrDiff({ baseSha: "base", headSha: "head", diffText });
    expect(extractDependencyBumps(prDiff)).toHaveLength(1);
    expect(extractDependencyBumps(prDiff)[0]?.version).toBe("4.17.20");
  });

  it("skips package-lock.json even though it also contains version-shaped strings", () => {
    const prDiff = diffAdding("package-lock.json", '"lodash": "4.17.20",');
    expect(extractDependencyBumps(prDiff)).toHaveLength(0);
  });
});

describe("scanDependencies", () => {
  const VULNERABLE: OsvVuln = { id: "GHSA-test-1234", summary: "Prototype pollution.", severity: "CRITICAL", detailsUrl: "https://osv.dev/vulnerability/GHSA-test-1234" };

  it("reports a candidate for each vulnerability OSV returns for an introduced version", async () => {
    const prDiff = diffAdding("package.json", '"lodash": "4.17.20",');
    const found = await scanDependencies(prDiff, { fetchVulns: async () => [VULNERABLE] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ category: "security", path: "package.json", startLine: 1, severity: "critical" });
    expect(found[0]!.title).toContain("GHSA-test-1234");
    expect(found[0]!.evidence[0]).toBe('"lodash": "4.17.20",');
  });

  it("reports nothing when OSV has no known vulnerabilities for that version", async () => {
    const prDiff = diffAdding("package.json", '"lodash": "4.17.21",');
    const found = await scanDependencies(prDiff, { fetchVulns: async () => [] });
    expect(found).toHaveLength(0);
  });

  it("maps OSV severities to Candidate severities conservatively", async () => {
    const prDiff = diffAdding("package.json", '"pkg-a": "1.0.0",');
    const moderate = await scanDependencies(prDiff, { fetchVulns: async () => [{ ...VULNERABLE, severity: "MODERATE" }] });
    expect(moderate[0]?.severity).toBe("major");
    const low = await scanDependencies(prDiff, { fetchVulns: async () => [{ ...VULNERABLE, severity: "LOW" }] });
    expect(low[0]?.severity).toBe("minor");
    const unknown = await scanDependencies(prDiff, { fetchVulns: async () => [{ ...VULNERABLE, severity: "UNKNOWN" }] });
    expect(unknown[0]?.severity).toBe("major"); // never silently downgrade an unrated CVE
  });

  it("queries each distinct dependency bump with its own ecosystem/name/version", async () => {
    const prDiff = diffAdding("package.json", '"lodash": "4.17.20",', '"express": "4.18.2",');
    const queried: Array<{ ecosystem: string; name: string; version: string }> = [];
    await scanDependencies(prDiff, {
      fetchVulns: async (pkg) => {
        queried.push(pkg);
        return [];
      },
    });
    expect(queried).toEqual(
      expect.arrayContaining([
        { ecosystem: "npm", name: "lodash", version: "4.17.20" },
        { ecosystem: "npm", name: "express", version: "4.18.2" },
      ]),
    );
  });

  it("caps the number of bumps checked per run", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `"pkg${i}": "1.0.${i}",`);
    const prDiff = diffAdding("package.json", ...lines);
    let calls = 0;
    await scanDependencies(prDiff, {
      fetchVulns: async () => {
        calls++;
        return [];
      },
      maxBumpsPerRun: 5,
    });
    expect(calls).toBe(5);
  });

  it("produces every field CandidateSchema requires as non-empty", async () => {
    const prDiff = diffAdding("package.json", '"lodash": "4.17.20",');
    const [found] = await scanDependencies(prDiff, { fetchVulns: async () => [VULNERABLE] });
    expect(found!.title.length).toBeGreaterThan(0);
    expect(found!.title.length).toBeLessThanOrEqual(120);
    expect(found!.explanation.length).toBeGreaterThan(0);
    expect(found!.fixSteps.length).toBeGreaterThan(0);
    expect(found!.evidence.length).toBeGreaterThan(0);
  });
});
