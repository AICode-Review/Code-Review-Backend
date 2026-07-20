import { extensionOf, TREE_SITTER_LANGUAGES } from "./languages.js";
import { loadLanguage } from "./parser.js";

export interface ExtractedSymbol {
  kind: string;
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
}

/** Regex fallback for any extension without a verified tree-sitter query (DESIGN.md §7: "regex fallback for others"). Deliberately conservative — false negatives (a missed symbol) are fine, false positives would pollute the symbol graph. */
const REGEX_FALLBACK_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "function", re: /^\s*(?:public|private|protected|static|export|async|func|fn|def|function)*\s*(?:function\s+|def\s+|func\s+|fn\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
  { kind: "class", re: /^\s*(?:public\s+|export\s+)*(?:class|struct|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
];

function extractByRegex(content: string): ExtractedSymbol[] {
  const lines = content.split("\n");
  const symbols: ExtractedSymbol[] = [];
  lines.forEach((line, i) => {
    for (const { kind, re } of REGEX_FALLBACK_PATTERNS) {
      const match = re.exec(line);
      if (match?.[1]) {
        symbols.push({ kind, name: match[1], signature: line.trim().slice(0, 200), startLine: i + 1, endLine: i + 1 });
        break;
      }
    }
  });
  return symbols;
}

async function extractByTreeSitter(content: string, ext: string): Promise<ExtractedSymbol[]> {
  const cfg = TREE_SITTER_LANGUAGES[ext];
  if (!cfg) return extractByRegex(content);

  const { parser, query } = await loadLanguage(cfg);
  const tree = parser.parse(content);
  if (!tree) return extractByRegex(content);

  const matches = query.matches(tree.rootNode);
  return matches.flatMap((m): ExtractedSymbol[] => {
    const nameCap = m.captures.find((c) => c.name === "name");
    const defCap = m.captures.find((c) => c.name === "def");
    if (!nameCap || !defCap) return [];
    const startLine = defCap.node.startPosition.row + 1;
    const endLine = defCap.node.endPosition.row + 1;
    const firstLine = content.split("\n")[defCap.node.startPosition.row] ?? "";
    return [
      {
        kind: defCap.node.type,
        name: nameCap.node.text,
        signature: firstLine.trim().slice(0, 200),
        startLine,
        endLine,
      },
    ];
  });
}

/** Functions/classes/methods with signatures for one file — tree-sitter for verified languages, regex fallback otherwise (DESIGN.md §7). Never throws: a parse failure just yields no symbols for that file rather than failing the whole index run. */
export async function extractSymbols(path: string, content: string): Promise<ExtractedSymbol[]> {
  try {
    return await extractByTreeSitter(content, extensionOf(path));
  } catch {
    return extractByRegex(content);
  }
}
