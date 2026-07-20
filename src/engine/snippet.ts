/**
 * Pulls the exact cited lines (plus a little surrounding context) straight
 * from the real file content already fetched for review — never asks the
 * LLM to retype code, which would risk transcription drift from the actual
 * source. This is what backs `findings.code_snippet`.
 */
export function extractCodeSnippet(content: string, startLine: number, endLine: number, contextLines = 1): string | null {
  if (startLine < 1 || endLine < startLine) return null;
  const lines = content.split("\n");
  if (startLine > lines.length) return null;

  const from = Math.max(1, startLine - contextLines);
  const to = Math.min(lines.length, endLine + contextLines);
  return lines.slice(from - 1, to).join("\n");
}
