import { extensionOf, TREE_SITTER_LANGUAGES } from "../indexer/languages.js";
import { loadLanguage } from "../indexer/parser.js";

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

/**
 * A second, stronger check beyond validateSuggestedFix's format heuristics: splices
 * `suggestedFix` into `sourceContent` at [startLine, endLine] (1-indexed, inclusive)
 * and re-parses with the same tree-sitter grammar the indexer uses, comparing against
 * whether the ORIGINAL file already parses clean. Catches a real class of bug the
 * format-only checks above can't — a suggestion that's the right size and free of
 * placeholder text but is nonetheless syntactically broken (an unbalanced brace, a
 * stray comma, mismatched quotes) — which a developer would only discover after
 * one-click-applying it. Only ever narrows validity, never widens it — call after
 * validateSuggestedFix, not instead of it.
 *
 * Skips (returns valid:true) rather than rejects whenever this can't give a reliable
 * answer: no tree-sitter grammar for this file's extension, parsing itself fails, or
 * the original file already has parse errors unrelated to this edit (so a new error
 * can't be confidently attributed to the fix). This is a bonus signal layered on top
 * of the format checks, not a compiler — never throws, matching the "a parse failure
 * degrades gracefully rather than blocking anything" pattern used throughout indexer/.
 */
export async function validateSuggestedFixSyntax(
  path: string,
  sourceContent: string,
  startLine: number,
  endLine: number,
  suggestedFix: string,
): Promise<SuggestedFixCheck> {
  const cfg = TREE_SITTER_LANGUAGES[extensionOf(path)];
  if (!cfg) return { valid: true };

  try {
    const { parser } = await loadLanguage(cfg);

    const originalHasError = parser.parse(sourceContent)?.rootNode.hasError ?? false;
    if (originalHasError) return { valid: true };

    const lines = sourceContent.split("\n");
    const spliced = [...lines.slice(0, startLine - 1), suggestedFix, ...lines.slice(endLine)].join("\n");
    const modifiedHasError = parser.parse(spliced)?.rootNode.hasError ?? false;
    if (modifiedHasError) {
      return { valid: false, reason: "suggestedFix introduces a syntax error when spliced into the file" };
    }

    return { valid: true };
  } catch {
    return { valid: true };
  }
}
