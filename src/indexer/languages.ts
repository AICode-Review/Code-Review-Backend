/**
 * Tree-sitter-backed symbol extraction (DESIGN.md §7) for the languages
 * whose grammar queries are verified in this codebase. Every other
 * extension falls back to the regex-based extractor in symbols.ts — the
 * same "regex fallback for others" DESIGN.md itself specifies, just scoped
 * to a smaller verified core set rather than the full language list, since
 * writing correct tree-sitter queries for a grammar with no way to run
 * sample code against it risks silently wrong (not just missing) symbols.
 */
export interface TreeSitterLanguageConfig {
  /** file under node_modules/tree-sitter-wasms/out */
  wasmFile: string;
  /** tree-sitter query source capturing @name (identifier) within @def (the whole declaration node) */
  query: string;
}

// JavaScript's grammar has no separate "type" node kind — class names are plain `identifier`.
const JS_QUERY = `
  (function_declaration name: (identifier) @name) @def
  (class_declaration name: (identifier) @name) @def
  (method_definition name: (property_identifier) @name) @def
  (variable_declarator name: (identifier) @name value: (arrow_function)) @def
`;

// TypeScript's grammar (a superset used by both the "typescript" and "tsx" wasm variants)
// types class/interface names as `type_identifier`, distinct from JS's plain `identifier`.
const TS_QUERY = `
  (function_declaration name: (identifier) @name) @def
  (class_declaration name: (type_identifier) @name) @def
  (method_definition name: (property_identifier) @name) @def
  (variable_declarator name: (identifier) @name value: (arrow_function)) @def
`;

export const TREE_SITTER_LANGUAGES: Record<string, TreeSitterLanguageConfig> = {
  ts: { wasmFile: "tree-sitter-typescript.wasm", query: TS_QUERY },
  js: { wasmFile: "tree-sitter-javascript.wasm", query: JS_QUERY },
  mjs: { wasmFile: "tree-sitter-javascript.wasm", query: JS_QUERY },
  cjs: { wasmFile: "tree-sitter-javascript.wasm", query: JS_QUERY },
  tsx: { wasmFile: "tree-sitter-tsx.wasm", query: TS_QUERY },
  jsx: { wasmFile: "tree-sitter-javascript.wasm", query: JS_QUERY },
  py: {
    wasmFile: "tree-sitter-python.wasm",
    query: `
      (function_definition name: (identifier) @name) @def
      (class_definition name: (identifier) @name) @def
    `,
  },
  go: {
    wasmFile: "tree-sitter-go.wasm",
    query: `
      (function_declaration name: (identifier) @name) @def
      (method_declaration name: (field_identifier) @name) @def
      (type_spec name: (type_identifier) @name type: (struct_type)) @def
    `,
  },
  rs: {
    wasmFile: "tree-sitter-rust.wasm",
    query: `
      (function_item name: (identifier) @name) @def
      (struct_item name: (type_identifier) @name) @def
      (impl_item type: (type_identifier) @name) @def
      (trait_item name: (type_identifier) @name) @def
    `,
  },
  java: {
    wasmFile: "tree-sitter-java.wasm",
    query: `
      (method_declaration name: (identifier) @name) @def
      (class_declaration name: (identifier) @name) @def
      (interface_declaration name: (identifier) @name) @def
    `,
  },
  kt: {
    wasmFile: "tree-sitter-kotlin.wasm",
    query: `
      (function_declaration (simple_identifier) @name) @def
      (class_declaration (type_identifier) @name) @def
      (object_declaration (type_identifier) @name) @def
    `,
  },
  swift: {
    wasmFile: "tree-sitter-swift.wasm",
    query: `
      (function_declaration name: (simple_identifier) @name) @def
      (class_declaration name: (type_identifier) @name) @def
      (protocol_declaration name: (type_identifier) @name) @def
    `,
  },
  // .dart is intentionally absent: tree-sitter-wasms' current build targets
  // grammar ABI version 15, but web-tree-sitter 0.22.6 (pinned so the other
  // languages here load at all — 0.26.x can't load THEIR wasm files) only
  // supports versions 13-14. Falls back to the regex extractor until either
  // side's version lands in a compatible range.
};

export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Canonical display name for `repos.tier1_langs` (DESIGN.md §6.1 step 4 — "Tier-1 (AST-enhanced)") — several extensions share one language. */
export const DISPLAY_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
};
