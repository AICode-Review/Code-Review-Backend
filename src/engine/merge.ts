import { createHash } from "node:crypto";
import type { Candidate } from "./schemas.js";

export interface MergedFinding extends Candidate {
  score: number;
  fingerprint: string;
  /** which specialist passes independently raised this finding */
  passes: string[];
}

const SEVERITY_WEIGHT: Record<Candidate["severity"], number> = { critical: 3, major: 2, minor: 1 };

/** A candidate below this self-reported confidence is speculative enough that spending a verification call on it isn't worth it — it's dropped before merge. */
export const MIN_CANDIDATE_CONFIDENCE = 0.3;

/**
 * hash(category, path, normalized snippet) — DESIGN.md §5 invariant, used to suppress
 * re-posting on force-push and carry feedback forward. Sorts + combines every evidence
 * entry (not just the first) so the fingerprint is stable even when the LLM returns the
 * same evidence set in a different order on a re-run — otherwise a real dismissal
 * wouldn't reliably carry forward for a finding with more than one evidence quote.
 */
export function computeFingerprint(c: Pick<Candidate, "category" | "path" | "title" | "evidence">): string {
  const normalizedEvidence = c.evidence
    .map((e) => e.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort()
    .join("|");
  const snippet = normalizedEvidence || c.title.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${c.category}|${c.path}|${snippet}`).digest("hex").slice(0, 16);
}

function linesOverlap(a: { path: string; startLine: number; endLine: number }, b: { path: string; startLine: number; endLine: number }): boolean {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export interface PassCandidates {
  pass: string;
  candidates: Candidate[];
}

/**
 * Returns a rulebook-driven multiplier for (category, path): 1 = no rule
 * matched, 0 = an active rule suppresses this category/path entirely, >1 =
 * an active rule boosts it (rulebook_rules.weight).
 */
export type RulebookBoost = (category: string, path: string) => number;

export const NO_RULEBOOK_BOOST: RulebookBoost = () => 1;

/**
 * Dedupe by (path, line-range overlap, category) — keep the highest-confidence
 * candidate's fields, merge evidence and contributing passes from the rest.
 * Then score = severity weight × confidence × rulebook boost, sorted
 * descending. A boost of 0 (an active suppression rule) drops the finding.
 */
export function mergeAndScore(candidatesByPass: PassCandidates[], rulebookBoost: RulebookBoost = NO_RULEBOOK_BOOST): MergedFinding[] {
  const merged: MergedFinding[] = [];

  for (const { pass, candidates } of candidatesByPass) {
    for (const candidate of candidates) {
      if (candidate.confidence < MIN_CANDIDATE_CONFIDENCE) continue;
      const dupIndex = merged.findIndex((m) => m.category === candidate.category && linesOverlap(m, candidate));
      if (dupIndex === -1) {
        merged.push({ ...candidate, fingerprint: computeFingerprint(candidate), score: 0, passes: [pass] });
        continue;
      }
      const existing = merged[dupIndex]!;
      const mergedEvidence = [...new Set([...existing.evidence, ...candidate.evidence])];
      const mergedPasses = [...existing.passes, pass];
      merged[dupIndex] =
        candidate.confidence > existing.confidence
          ? { ...candidate, fingerprint: computeFingerprint(candidate), score: 0, passes: mergedPasses, evidence: mergedEvidence }
          : { ...existing, passes: mergedPasses, evidence: mergedEvidence };
    }
  }

  const scored = merged
    .map((m) => ({ finding: m, boost: rulebookBoost(m.category, m.path) }))
    .filter(({ boost }) => boost > 0)
    .map(({ finding, boost }) => ({ ...finding, score: SEVERITY_WEIGHT[finding.severity] * finding.confidence * boost }));

  return scored.sort((a, b) => b.score - a.score);
}

export type Feedback = "accepted" | "dismissed" | "fixed" | "ignored";

/** Suppress findings whose fingerprint was dismissed/ignored in a prior run on this PR (DESIGN.md §5). */
export function suppressPreviouslyDismissed<T extends { fingerprint: string }>(
  findings: T[],
  priorFeedback: Map<string, Feedback>,
): T[] {
  return findings.filter((f) => {
    const fb = priorFeedback.get(f.fingerprint);
    return fb !== "dismissed" && fb !== "ignored";
  });
}
