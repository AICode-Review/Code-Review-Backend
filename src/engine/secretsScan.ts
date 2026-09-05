import type { PrDiff } from "./diff.js";
import { isReviewableSourcePath } from "./binaryFiles.js";
import type { Candidate } from "./schemas.js";

/**
 * Deterministic secret-pattern scan — a safety net alongside the LLM security pass, not a
 * replacement for it. An LLM can miss a hardcoded credential simply because nothing about the
 * surrounding code drew its attention there; a fixed-format vendor token (an AWS access key, a
 * GitHub PAT, a private key block) is either present verbatim in the diff or it isn't, and a
 * regex never gets distracted. This is the same class of check tools like gitleaks/trufflehog
 * ship, kept deliberately small and vendor-prefix-anchored rather than generic
 * high-entropy-string detection — the latter is exactly what makes those tools noisy in
 * practice (a cache key, a translation key, a UUID all look "high entropy" too). Every pattern
 * here is a real, documented token FORMAT from that vendor, not a guess.
 *
 * Runs on added lines only (matches every specialist pass's "only flag what this diff
 * introduces" convention) and only on paths `isReviewableSourcePath` would send to an LLM pass
 * anyway (no point flagging a lockfile or binary).
 */
/** Pass name used in PassCandidates/MergedFinding.passes to mark a finding as coming from this
 * deterministic scan rather than an LLM — callers use this to route verification appropriately
 * (see verify/index.ts's verifyDeterministicFinding). */
export const SECRETS_SCAN_PASS = "secrets-scan";

export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
  severity: Candidate["severity"];
}

// Every regex is anchored to a real, documented vendor token format — never a generic
// "looks random" heuristic. Keep additions curated and cited (a comment naming the vendor
// format), not expanded into generic entropy detection.
export const SECRET_PATTERNS: SecretPattern[] = [
  { id: "aws-access-key-id", description: "AWS access key ID", regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: "critical" },
  { id: "github-token", description: "GitHub personal access / app token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/, severity: "critical" },
  { id: "github-fine-grained-pat", description: "GitHub fine-grained personal access token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, severity: "critical" },
  { id: "gitlab-token", description: "GitLab personal access token", regex: /\bglpat-[A-Za-z0-9\-_]{20,}\b/, severity: "critical" },
  { id: "slack-token", description: "Slack API token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,72}\b/, severity: "critical" },
  { id: "slack-webhook", description: "Slack incoming webhook URL (posts to this workspace on use)", regex: /\bhooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+\b/, severity: "major" },
  { id: "stripe-live-key", description: "Stripe live-mode secret/restricted key", regex: /\b(sk|rk)_live_[A-Za-z0-9]{24,}\b/, severity: "critical" },
  { id: "google-api-key", description: "Google API key", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/, severity: "critical" },
  { id: "npm-token", description: "npm publish/access token", regex: /\bnpm_[A-Za-z0-9]{36}\b/, severity: "critical" },
  { id: "sendgrid-key", description: "SendGrid API key", regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, severity: "critical" },
  { id: "twilio-key", description: "Twilio API key SID", regex: /\bSK[0-9a-fA-F]{32}\b/, severity: "major" },
  { id: "private-key-block", description: "A private key material block committed in source", regex: /-----BEGIN\s?(RSA|EC|OPENSSH|DSA|PGP)?\s?PRIVATE KEY-----/, severity: "critical" },
];

export interface SecretScanOptions {
  /** Overrides SECRET_PATTERNS — for tests only; production always uses the full curated list. */
  patterns?: SecretPattern[];
}

/**
 * Scans this PR's diff for hardcoded secrets on added lines. Returns fully-formed Candidate
 * objects (category "security", needsExecution: false) ready to merge alongside LLM pass
 * output — these skip the LLM entirely, so they're deterministic and reproducible across runs
 * by construction, not just by convention.
 */
export function scanForSecrets(prDiff: PrDiff, opts: SecretScanOptions = {}): Candidate[] {
  const patterns = opts.patterns ?? SECRET_PATTERNS;
  const candidates: Candidate[] = [];

  for (const file of prDiff.files) {
    if (!isReviewableSourcePath(file.path)) continue;
    for (const line of file.lines) {
      if (line.kind !== "add" || line.newNo == null) continue;
      for (const pattern of patterns) {
        const match = pattern.regex.exec(line.text);
        if (!match) continue;
        candidates.push({
          category: "security",
          path: file.path,
          startLine: line.newNo,
          endLine: line.newNo,
          title: `Hardcoded ${pattern.description} committed to source`,
          explanation: `This line matches the known format of a ${pattern.description}. Committing real credential material to source control means anyone with repo access (and the full git history, forever, even if this line is later removed) has it — it must be treated as compromised and rotated regardless of whether this specific PR merges.`,
          whyItMatters: `A ${pattern.description} found here grants whatever access that credential carries to anyone who can read this repository or its history.`,
          impact: "The credential must be treated as leaked the moment this commit is pushed, not just if the PR merges — git history retains it. Rotate it and remove it from history (not just this diff) rather than only reverting the line.",
          fixSteps: [
            "Rotate/revoke this credential immediately with its provider — assume it is already compromised.",
            "Remove it from source and load it from an environment variable or secret manager instead.",
            "If already pushed, purge it from git history (it remains recoverable from history otherwise), not just this diff.",
          ],
          severity: pattern.severity,
          confidence: 0.97,
          needsExecution: false,
          evidence: [match[0]],
        });
      }
    }
  }

  return candidates;
}
