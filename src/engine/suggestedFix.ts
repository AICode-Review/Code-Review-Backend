/**
 * `suggestedFix` is delivered as a GitHub one-click "Apply suggestion" — unlike the
 * finding itself, it never goes through verify/ (static check + cross-examination), so
 * nothing today catches a hallucinated or lazy suggestion before a developer blindly
 * applies it. This is a cheap, deterministic sanity pass, not a correctness proof: it
 * only catches the specific failure modes an LLM predictably produces despite explicit
 * prompt instructions ("no placeholders, no partial snippets").
 */
export interface SuggestedFixCheck {
  valid: boolean;
  reason?: string;
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\.\.\./,
  /\btodo\b/i,
  /\bfixme\b/i,
  /<your code/i,
  /<existing code/i,
  /\brest of (the )?(code|function|file|method)\b/i,
  /\bunchanged\b/i,
  /\bexisting code\b/i,
  /\bsame as (before|above)\b/i,
  /\[\s*\.\.\.\s*]/,
];

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * `originalLines` should be the EXACT cited range (startLine-endLine, no padding) —
 * suggestedFix is documented to replace exactly that range, so padding would make the
 * identical-to-original check unreliable.
 */
export function validateSuggestedFix(suggestedFix: string, originalLines: string): SuggestedFixCheck {
  const trimmed = suggestedFix.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "suggestedFix was empty" };
  }

  if (normalize(trimmed) === normalize(originalLines)) {
    return { valid: false, reason: "suggestedFix is identical to the original code — not an actual change" };
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: "suggestedFix contains a placeholder marker rather than a concrete replacement" };
    }
  }

  const originalLineCount = Math.max(1, originalLines.split("\n").length);
  const fixLineCount = trimmed.split("\n").length;
  if (fixLineCount > originalLineCount * 3 + 10) {
    return { valid: false, reason: "suggestedFix is far larger than the cited range — likely includes unrelated surrounding code" };
  }

  return { valid: true };
}
