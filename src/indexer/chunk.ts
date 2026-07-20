import { createHash } from "node:crypto";
import { get_encoding } from "tiktoken";

export interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
  contentHash: string;
}

const CHUNK_LINES = 60;
const OVERLAP_LINES = 10;
// OpenAI's embedding input cap is 8192 tokens (text-embedding-3-small uses cl100k_base). A
// character-count proxy for this isn't reliable on its own — dense/symbol-heavy text can
// tokenize far worse than prose — so token count is checked exactly via the real encoder,
// capped below the actual limit to leave margin. But BPE encoding cost is not linear in
// pathological input (e.g. long runs of near-identical bytes can take tens of seconds per
// call), so text is first cheaply pre-split by character count to a size the encoder handles
// in well under a second regardless of content, *then* checked/split exactly by token count.
const MAX_PRESPLIT_CHARS = 24000;
const MAX_CHUNK_TOKENS = 8000;
const decoder = new TextDecoder();
const encoder = get_encoding("cl100k_base");

/** sha256 of raw file content — DESIGN.md §7's "compare content_hash" incremental-reindex check. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function splitByTokens(text: string, startLine: number, endLine: number): Chunk[] {
  const tokens = encoder.encode(text);
  if (tokens.length <= MAX_CHUNK_TOKENS) {
    return [{ startLine, endLine, text, contentHash: hashContent(text) }];
  }
  const pieces: Chunk[] = [];
  for (let i = 0; i < tokens.length; i += MAX_CHUNK_TOKENS) {
    const piece = decoder.decode(encoder.decode(tokens.slice(i, i + MAX_CHUNK_TOKENS)));
    pieces.push({ startLine, endLine, text: piece, contentHash: hashContent(piece) });
  }
  return pieces;
}

function toChunks(text: string, startLine: number, endLine: number): Chunk[] {
  if (text.length <= MAX_PRESPLIT_CHARS) {
    return splitByTokens(text, startLine, endLine);
  }
  const chunks: Chunk[] = [];
  for (let i = 0; i < text.length; i += MAX_PRESPLIT_CHARS) {
    chunks.push(...splitByTokens(text.slice(i, i + MAX_PRESPLIT_CHARS), startLine, endLine));
  }
  return chunks;
}

/**
 * Splits a file into ~60-line windows with 10-line overlap (DESIGN.md §7),
 * so embeddings retain enough surrounding context to be useful for
 * similarity search without needing whole-file embeddings.
 */
export function chunkFile(content: string): Chunk[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");

  const chunks: Chunk[] = [];
  const stride = CHUNK_LINES - OVERLAP_LINES;
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n");
    chunks.push(...toChunks(text, start + 1, end));
    if (end === lines.length) break;
  }
  return chunks;
}
