import { extractCodeSnippet } from "./snippet.js";

export interface FixApplicationPlan {
  ok: true;
  newContent: string;
}

export interface FixApplicationRejection {
  ok: false;
  reason: string;
}

/**
 * Splices a verified finding's `suggestedFix` into the CURRENT file content, after confirming
 * the cited range hasn't drifted since the review ran. Re-derives the same padded snippet
 * `extractCodeSnippet()` produced at review time (same function, same contextLines=1) and
 * compares it against the finding's stored `codeSnippet` — if the file has since changed
 * anywhere in or around the cited range (a later commit, a since-applied manual fix, a rebase),
 * this refuses rather than silently overwriting code the finding was never actually about.
 * `suggestedFix` is documented (engine/suggestedFix.ts) to replace exactly [startLine, endLine],
 * no padding — the same convention as GitHub's own "one-click apply suggestion".
 */
export function planFixApplication(
  currentContent: string,
  startLine: number,
  endLine: number,
  expectedCodeSnippet: string,
  suggestedFix: string,
): FixApplicationPlan | FixApplicationRejection {
  const currentSnippet = extractCodeSnippet(currentContent, startLine, endLine, 1);
  if (currentSnippet === null) {
    return { ok: false, reason: "the finding's cited line range no longer exists in the current file" };
  }
  if (currentSnippet !== expectedCodeSnippet) {
    return {
      ok: false,
      reason: "the file has changed since this finding was posted — re-run the review before applying this fix",
    };
  }

  const lines = currentContent.split("\n");
  const newLines = [...lines.slice(0, startLine - 1), ...suggestedFix.split("\n"), ...lines.slice(endLine)];
  return { ok: true, newContent: newLines.join("\n") };
}
