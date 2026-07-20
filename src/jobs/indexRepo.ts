import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { getAdapter } from "../adapters/index.js";
import { getDb } from "../db/client.js";
import { getRepoRefById } from "../db/repositories.js";
import { isReviewableSourcePath } from "../engine/binaryFiles.js";
import { cloneShallow } from "../indexer/clone.js";
import { DISPLAY_LANGUAGE_BY_EXTENSION, extensionOf } from "../indexer/languages.js";
import { extractSymbols } from "../indexer/symbols.js";
import { chunkFile, hashContent } from "../indexer/chunk.js";
import { embedTexts } from "../indexer/embeddings.js";
import type { IndexRepoJob } from "../queue/index.js";

const MAX_FILE_BYTES = 512 * 1024; // skip pathologically large generated/vendored files

async function walkFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const relPath = relative(rootDir, full).split("\\").join("/");
        if (isReviewableSourcePath(relPath)) results.push(relPath);
      }
    }
  }
  await walk(rootDir);
  return results;
}

/**
 * DESIGN.md §7 — clone, tree-sitter symbols, chunk + embed, store in
 * Postgres/pgvector. Incremental: a file whose content hash matches what's
 * already stored for that path is skipped entirely (no re-parse, no
 * re-embed spend). The clone dir is always purged, even on failure.
 */
export async function handleIndexRepo(job: IndexRepoJob): Promise<void> {
  const db = getDb();
  const repo = await getRepoRefById(db, job.repoId);
  if (!repo) throw new Error(`indexer: repo ${job.repoId} not found`);

  await db.from("repos").update({ index_status: "indexing" }).eq("id", job.repoId);

  let cloned: Awaited<ReturnType<typeof cloneShallow>> | undefined;
  try {
    const adapter = getAdapter(repo.platform);
    const url = await adapter.cloneUrl(repo);
    cloned = await cloneShallow(url);

    const paths = await walkFiles(cloned.dir);
    const tier1Langs = new Set<string>();
    for (const path of paths) {
      const absPath = join(cloned.dir, path);
      const st = await stat(absPath);
      if (st.size > MAX_FILE_BYTES) continue;

      const content = await readFile(absPath, "utf8").catch(() => null);
      if (content === null) continue; // unreadable/binary despite the extension filter — skip, don't fail the run
      const fileHash = hashContent(content);

      const displayLang = DISPLAY_LANGUAGE_BY_EXTENSION[extensionOf(path)];
      if (displayLang) tier1Langs.add(displayLang);

      const { data: existingChunk } = await db
        .from("chunks")
        .select("sha")
        .eq("repo_id", job.repoId)
        .eq("path", path)
        .limit(1)
        .maybeSingle();
      if (existingChunk?.sha === fileHash) continue; // unchanged since the last index — skip re-parse/re-embed entirely

      const symbols = await extractSymbols(path, content);
      await db.from("symbols").delete().eq("repo_id", job.repoId).eq("path", path);
      if (symbols.length > 0) {
        await db.from("symbols").insert(
          symbols.map((s) => ({
            repo_id: job.repoId,
            path,
            kind: s.kind,
            name: s.name,
            signature: s.signature,
            start_line: s.startLine,
            end_line: s.endLine,
            sha: fileHash,
          })),
        );
      }

      const chunks = chunkFile(content);
      await db.from("chunks").delete().eq("repo_id", job.repoId).eq("path", path);
      if (chunks.length > 0) {
        const { vectors } = await embedTexts(chunks.map((c) => c.text));
        await db.from("chunks").insert(
          chunks.map((c, i) => ({
            repo_id: job.repoId,
            path,
            start_line: c.startLine,
            end_line: c.endLine,
            content_hash: c.contentHash,
            embedding: vectors[i] ?? null,
            sha: fileHash,
          })),
        );
      }
    }

    await db
      .from("repos")
      .update({ index_status: "ready", indexed_sha: cloned.headSha, tier1_langs: Array.from(tier1Langs) })
      .eq("id", job.repoId);
  } catch (err) {
    await db.from("repos").update({ index_status: "failed" }).eq("id", job.repoId);
    throw err;
  } finally {
    await cloned?.cleanup().catch(() => undefined);
  }
}
