import type { Candidate } from "../engine/schemas.js";

export interface StaticCheckResult {
  passed: boolean;
  reason: string;
}

/** Minimum non-whitespace characters an evidence snippet needs before a file-content match counts as real. */
const MIN_EVIDENCE_CHARS = 8;

/**
 * DESIGN.md §6.5 step 1 — always run, cheap: does the referenced code exist
 * at those lines? This alone kills most hallucinations before spending a
 * cross-examination call on them.
 */
export function staticExistenceCheck(candidate: Candidate, files: Map<string, string>): StaticCheckResult {
  const content = files.get(candidate.path);
  if (content === undefined) {
    return { passed: false, reason: `File "${candidate.path}" was not among the files fetched for this review — likely hallucinated.` };
  }

  if (candidate.startLine > candidate.endLine) {
    return { passed: false, reason: `startLine ${candidate.startLine} is after endLine ${candidate.endLine}.` };
  }

  const lineCount = content.split("\n").length;
  if (candidate.startLine > lineCount || candidate.endLine > lineCount) {
    return {
      passed: false,
      reason: `Cited lines ${candidate.startLine}-${candidate.endLine} are beyond the file's ${lineCount} lines.`,
    };
  }

  const normalizedContent = content.toLowerCase().replace(/\s+/g, " ");
  const hasMatchingEvidence = candidate.evidence.some((e) => {
    const snippet = e.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
    // A short/trivial snippet ("x", "if", "return") will match almost any file by
    // coincidence — that's not evidence, it's noise. Require enough specific
    // (non-whitespace) characters that a match actually means something.
    const specificChars = snippet.replace(/\s/g, "").length;
    return specificChars >= MIN_EVIDENCE_CHARS && normalizedContent.includes(snippet);
  });
  if (!hasMatchingEvidence) {
    return {
      passed: false,
      reason: "None of the cited evidence is both specific enough and present in the file — likely hallucinated or too vague to verify.",
    };
  }

  return { passed: true, reason: "Cited lines exist and evidence text was found in the file." };
}
