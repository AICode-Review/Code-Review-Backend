import { z } from "zod";

export const DiffLineSchema = z.object({
  kind: z.enum(["context", "add", "del"]),
  oldNo: z.number().int().nullable(),
  newNo: z.number().int().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  additions: z.number().int(),
  deletions: z.number().int(),
  lines: z.array(DiffLineSchema),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const PrDiffSchema = z.object({
  baseSha: z.string(),
  headSha: z.string(),
  baseLabel: z.string(),
  headLabel: z.string(),
  files: z.array(DiffFileSchema),
  stats: z.object({
    files: z.number().int(),
    additions: z.number().int(),
    deletions: z.number().int(),
  }),
});
export type PrDiff = z.infer<typeof PrDiffSchema>;

// Cosmetic only (diff-viewer syntax highlighting) — the review engine itself
// never filters by language; every specialist pass reads any text file
// regardless of whether its extension is listed here.
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", rb: "ruby", java: "java", kt: "kotlin", kts: "kotlin",
  rs: "rust", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", sql: "sql", yml: "yaml", yaml: "yaml",
  json: "json", jsonc: "json", md: "markdown", mdx: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  css: "css", scss: "scss", less: "less", html: "html", htm: "html", xml: "xml",
  vue: "vue", svelte: "svelte", dart: "dart", scala: "scala", clj: "clojure", cljs: "clojure",
  ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", lua: "lua", pl: "perl", pm: "perl",
  r: "r", jl: "julia", zig: "zig", nim: "nim", ml: "ocaml", fs: "fsharp", fsx: "fsharp",
  tf: "hcl", hcl: "hcl", proto: "protobuf", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", toml: "toml", ini: "ini", ps1: "powershell", psm1: "powershell",
  vb: "vbnet", groovy: "groovy", gradle: "groovy", ipynb: "json",
};

function languageForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? LANG_BY_EXT[ext] : undefined;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff`/GitHub-diff-media-type unified diff text into structured
 * per-file, per-line records — the shape the frontend's DiffViewer expects
 * (pre-hunked lines with old/new line numbers, not raw diff text).
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  const pushCurrent = () => {
    if (current) files.push(current);
    current = null;
  };

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      pushCurrent();
      continue;
    }
    if (rawLine.startsWith("index ") || rawLine.startsWith("new file mode") || rawLine.startsWith("deleted file mode")) {
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      continue; // path comes from the +++ line (handles renames correctly)
    }
    if (rawLine.startsWith("+++ ")) {
      const raw = rawLine.slice(4).trim();
      const path = raw === "/dev/null" ? "(deleted)" : raw.replace(/^b\//, "");
      current = { path, language: languageForPath(path), additions: 0, deletions: 0, lines: [] };
      continue;
    }
    if (rawLine.startsWith("Binary files ") || rawLine.startsWith("GIT binary patch")) {
      continue;
    }
    const hunk = HUNK_HEADER.exec(rawLine);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      continue;
    }
    if (!current) continue; // stray line before the first file header

    if (rawLine.startsWith("\\ No newline at end of file")) continue;

    if (rawLine.startsWith("+")) {
      current.lines.push({ kind: "add", oldNo: null, newNo, text: rawLine.slice(1) });
      current.additions++;
      newNo++;
    } else if (rawLine.startsWith("-")) {
      current.lines.push({ kind: "del", oldNo, newNo: null, text: rawLine.slice(1) });
      current.deletions++;
      oldNo++;
    } else if (rawLine.startsWith(" ")) {
      current.lines.push({ kind: "context", oldNo, newNo, text: rawLine.slice(1) });
      oldNo++;
      newNo++;
    }
    // any other line (blank separator between hunks, trailing split artifact) is ignored
  }
  pushCurrent();
  return files;
}

export function buildPrDiff(args: {
  baseSha: string;
  headSha: string;
  baseLabel?: string;
  headLabel?: string;
  diffText: string;
}): PrDiff {
  const files = parseUnifiedDiff(args.diffText);
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return {
    baseSha: args.baseSha,
    headSha: args.headSha,
    baseLabel: args.baseLabel ?? `${args.baseSha.slice(0, 7)} (before PR)`,
    headLabel: args.headLabel ?? `${args.headSha.slice(0, 7)} (PR head)`,
    files,
    stats: { files: files.length, additions, deletions },
  };
}
