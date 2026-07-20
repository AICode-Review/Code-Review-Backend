import { extractSymbols } from "../indexer/symbols.js";
import type { PrDiff } from "./diff.js";
import type { ChangedFile } from "./contextAssembly.js";

const MAX_SYMBOL_NAMES = 20;
const MAX_SIMILARITY_QUERY_CHARS = 4000;

export interface ChangedSymbolsResult {
  names: string[];
  similarityQueryText: string | undefined;
}

/**
 * Identifies which symbols a diff actually touched (for the indexer's
 * definitions/callers/relatedTests lookup) and builds a representative text
 * sample of the added code (for the embedding-similarity lookup) — DESIGN.md
 * §6.2 step 2. Re-parses each changed file's HEAD content rather than
 * reusing the indexer's stored `symbols` rows, since those may be stale
 * relative to this exact PR's head content.
 */
export async function extractChangedSymbols(prDiff: PrDiff, files: ChangedFile[]): Promise<ChangedSymbolsResult> {
  const addedLineNumbersByPath = new Map<string, Set<number>>();
  const addedTextParts: string[] = [];
  for (const file of prDiff.files) {
    const addedLines = file.lines.filter((l) => l.kind === "add");
    if (addedLines.length > 0) {
      const lineNumbers = addedLines.map((l) => l.newNo).filter((n): n is number => n !== null);
      addedLineNumbersByPath.set(file.path, new Set(lineNumbers));
      for (const line of addedLines) addedTextParts.push(line.text);
    }
  }

  const names = new Set<string>();
  for (const file of files) {
    if (names.size >= MAX_SYMBOL_NAMES) break;
    const addedLineNumbers = addedLineNumbersByPath.get(file.path);
    if (!addedLineNumbers || addedLineNumbers.size === 0) continue;

    const symbols = await extractSymbols(file.path, file.content);
    for (const sym of symbols) {
      let overlaps = false;
      for (let line = sym.startLine; line <= sym.endLine; line++) {
        if (addedLineNumbers.has(line)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) names.add(sym.name);
      if (names.size >= MAX_SYMBOL_NAMES) break;
    }
  }

  const similarityQueryText = addedTextParts.length > 0 ? addedTextParts.join("\n").slice(0, MAX_SIMILARITY_QUERY_CHARS) : undefined;

  return { names: Array.from(names), similarityQueryText };
}
