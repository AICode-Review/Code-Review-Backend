import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import type { TreeSitterLanguageConfig } from "./languages.js";

type Language = InstanceType<(typeof Parser)["Language"]>;
type Query = ReturnType<Language["query"]>;
export type SyntaxNode = Parameters<Query["matches"]>[0];

const wasmDir = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/tree-sitter-wasms/out");

let initialized: Promise<void> | undefined;
async function ensureInit(): Promise<void> {
  initialized ??= Parser.init();
  return initialized;
}

interface Loaded {
  parser: Parser;
  query: Query;
}

const cache = new Map<string, Loaded>();

/** Lazily loads and caches a tree-sitter grammar + compiled query — loading WASM is expensive, so this only ever happens once per language per process. */
export async function loadLanguage(cfg: TreeSitterLanguageConfig): Promise<Loaded> {
  const cached = cache.get(cfg.wasmFile);
  if (cached) return cached;

  await ensureInit();
  const bytes = await readFile(join(wasmDir, cfg.wasmFile));
  const language = await Parser.Language.load(bytes);
  const parser = new Parser();
  parser.setLanguage(language);
  const query = language.query(cfg.query);

  const loaded = { parser, query };
  cache.set(cfg.wasmFile, loaded);
  return loaded;
}
