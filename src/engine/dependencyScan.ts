import type { PrDiff } from "./diff.js";
import type { Candidate } from "./schemas.js";

/**
 * Deterministic dependency-vulnerability scan — a security safety net alongside the LLM
 * security pass and engine/secretsScan.ts. A PR that bumps a dependency to a version with a
 * known, published CVE is a real, common, and entirely mechanical risk an LLM pass has no
 * reliable way to catch (it would need an up-to-date vulnerability database in its training
 * data for that exact package/version, which it doesn't). This queries OSV.dev
 * (osv.dev — Google-run, free, public, no API key) for the exact package+version a diff
 * introduces, the same open vulnerability database GitHub's own Dependabot is built on.
 *
 * Scope is deliberately curated, not exhaustive: npm (package.json) and PyPI
 * (requirements.txt) cover the large majority of real-world manifest changes. Add more
 * ecosystems by extending MANIFEST_PARSERS — the OSV query/candidate-building logic is already
 * ecosystem-agnostic.
 */

/** Pass name used in PassCandidates/MergedFinding.passes to mark a finding as coming from
 * this deterministic scan rather than an LLM — see engine/secretsScan.ts's SECRETS_SCAN_PASS
 * for the same pattern; jobs/reviewRun.ts routes both to verifyDeterministicFinding. */
export const DEPENDENCY_SCAN_PASS = "dependency-scan";

export type OsvSeverity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";

export interface OsvVuln {
  id: string;
  summary: string;
  severity: OsvSeverity;
  /** e.g. "https://osv.dev/vulnerability/GHSA-..." */
  detailsUrl: string;
}

export interface DependencyBump {
  path: string;
  lineNo: number;
  ecosystem: "npm" | "PyPI";
  name: string;
  version: string;
  /** The exact added line, verbatim — used as evidence rather than the bare version string,
   * which is both too short for staticExistenceCheck's minimum-specificity bar and less useful
   * as a citation than the full declaration. */
  lineText: string;
}

interface ManifestParser {
  ecosystem: DependencyBump["ecosystem"];
  /** Matches the manifest's basename exactly — deliberately not lockfiles (already excluded
   * from LLM review by engine/binaryFiles.ts, and a lockfile's own resolved-version lines are
   * far noisier to parse reliably than the manifest's own declared version). */
  matchesPath: (path: string) => boolean;
  /** Extracts a {name, version} pair from one added line, or null if the line doesn't declare
   * a dependency version (most lines in a manifest diff won't). */
  parseLine: (line: string) => { name: string; version: string } | null;
}

/** Strips a semver range prefix (^, ~, >=, etc.) down to the concrete version OSV expects —
 * approximate (a real range could resolve to a different installed version) but reasonable for
 * a manifest line that just introduced this exact string. */
function stripRangePrefix(version: string): string {
  return version.replace(/^[\^~>=<\s]+/, "").trim();
}

const MANIFEST_PARSERS: ManifestParser[] = [
  {
    ecosystem: "npm",
    matchesPath: (path) => path.endsWith("package.json"),
    parseLine: (line) => {
      const match = /^\s*"([^"@][^"]*)"\s*:\s*"([^"]+)"\s*,?\s*$/.exec(line);
      if (!match) return null;
      const [, name, rawVersion] = match;
      if (!name || !rawVersion) return null;
      // package.json has plenty of non-dependency string fields ("name", "version",
      // "description", scripts, etc.) that would otherwise false-positive here — a dependency
      // value always looks like a semver/range, so require that shape.
      const version = stripRangePrefix(rawVersion);
      if (!/^\d+\.\d+\.\d+/.test(version)) return null;
      return { name, version };
    },
  },
  {
    ecosystem: "PyPI",
    matchesPath: (path) => path.endsWith("requirements.txt"),
    parseLine: (line) => {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([0-9][A-Za-z0-9_.+-]*)\s*$/.exec(line);
      if (!match) return null;
      const [, name, version] = match;
      if (!name || !version) return null;
      return { name, version };
    },
  },
];

/** Pure — which dependency bumps this diff introduces, per the curated manifest parsers above. */
export function extractDependencyBumps(prDiff: PrDiff): DependencyBump[] {
  const bumps: DependencyBump[] = [];
  for (const file of prDiff.files) {
    const parser = MANIFEST_PARSERS.find((p) => p.matchesPath(file.path));
    if (!parser) continue;
    for (const line of file.lines) {
      if (line.kind !== "add" || line.newNo == null) continue;
      const parsed = parser.parseLine(line.text);
      if (!parsed) continue;
      bumps.push({
        path: file.path,
        lineNo: line.newNo,
        ecosystem: parser.ecosystem,
        name: parsed.name,
        version: parsed.version,
        lineText: line.text.trim(),
      });
    }
  }
  return bumps;
}

interface OsvApiVuln {
  id: string;
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  severity?: Array<{ type: string; score: string }>;
}

function normalizeSeverity(vuln: OsvApiVuln): OsvSeverity {
  const declared = vuln.database_specific?.severity?.toUpperCase();
  if (declared === "CRITICAL" || declared === "HIGH" || declared === "MODERATE" || declared === "LOW") return declared;
  // Fall back to a CVSS score if the database didn't give a plain-English severity —
  // thresholds match the standard CVSS v3 qualitative rating bands.
  const cvss = vuln.severity?.find((s) => s.type === "CVSS_V3")?.score;
  const score = cvss ? Number.parseFloat(cvss.split("/")[0] ?? "") : NaN;
  if (!Number.isNaN(score)) {
    if (score >= 9) return "CRITICAL";
    if (score >= 7) return "HIGH";
    if (score >= 4) return "MODERATE";
    if (score > 0) return "LOW";
  }
  return "UNKNOWN";
}

/** Real OSV.dev lookup — POST /v1/query returns full vulnerability objects for one
 * package+version in a single call (no API key; osv.dev is a free public service). Never
 * throws: a network failure here should degrade this scan silently, the same way an
 * unreachable repo index degrades context assembly, not fail the whole review. */
export async function queryOsv(pkg: { ecosystem: string; name: string; version: string }): Promise<OsvVuln[]> {
  try {
    const res = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: pkg.version, package: { name: pkg.name, ecosystem: pkg.ecosystem } }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { vulns?: OsvApiVuln[] };
    return (body.vulns ?? []).map((v) => ({
      id: v.id,
      summary: v.summary ?? v.details?.slice(0, 300) ?? "No summary published.",
      severity: normalizeSeverity(v),
      detailsUrl: `https://osv.dev/vulnerability/${v.id}`,
    }));
  } catch {
    return [];
  }
}

const OSV_TO_CANDIDATE_SEVERITY: Record<OsvSeverity, Candidate["severity"]> = {
  CRITICAL: "critical",
  HIGH: "critical",
  MODERATE: "major",
  LOW: "minor",
  UNKNOWN: "major", // an unrated-but-published CVE is not something to quietly downgrade
};

export interface DependencyScanOptions {
  /** Overrides the real OSV.dev call — for tests only. */
  fetchVulns?: typeof queryOsv;
  /** Caps API calls for a PR that bumps many dependencies at once — the scan still runs, it
   * just checks the first N bumps rather than skipping the whole thing. */
  maxBumpsPerRun?: number;
}

/**
 * Scans this PR's diff for dependency bumps and checks each against OSV.dev. Returns
 * fully-formed Candidate objects (category "security") ready to merge alongside LLM pass
 * output, same pattern as engine/secretsScan.ts.
 */
export async function scanDependencies(prDiff: PrDiff, opts: DependencyScanOptions = {}): Promise<Candidate[]> {
  const fetchVulns = opts.fetchVulns ?? queryOsv;
  const maxBumps = opts.maxBumpsPerRun ?? 20;
  const bumps = extractDependencyBumps(prDiff).slice(0, maxBumps);

  const results = await Promise.all(
    bumps.map(async (bump) => {
      const vulns = await fetchVulns({ ecosystem: bump.ecosystem, name: bump.name, version: bump.version });
      return { bump, vulns };
    }),
  );

  const candidates: Candidate[] = [];
  for (const { bump, vulns } of results) {
    for (const vuln of vulns) {
      candidates.push({
        category: "security",
        path: bump.path,
        startLine: bump.lineNo,
        endLine: bump.lineNo,
        title: `${bump.name}@${bump.version} has a published vulnerability (${vuln.id})`,
        explanation: `${bump.ecosystem} package "${bump.name}" is being pinned to version ${bump.version}, which OSV.dev lists as affected by ${vuln.id}: ${vuln.summary}`,
        whyItMatters: `Shipping this version means the vulnerability is present in the dependency tree the moment this PR merges, regardless of whether the vulnerable code path is exercised today.`,
        impact: `Depends on ${vuln.id}'s specifics (see ${vuln.detailsUrl}) — treat as exploitable until confirmed otherwise for a dependency the app actually loads.`,
        fixSteps: [
          `Check ${vuln.detailsUrl} for the patched version range.`,
          `Bump ${bump.name} to a version outside the affected range.`,
          "Re-run this scan (or `npm audit`/`pip-audit`) to confirm the fix.",
        ],
        severity: OSV_TO_CANDIDATE_SEVERITY[vuln.severity],
        confidence: 0.9,
        needsExecution: false,
        evidence: [bump.lineText],
      });
    }
  }
  return candidates;
}
