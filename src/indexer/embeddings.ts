import OpenAI from "openai";
import { env } from "../config.js";
import { costUsd } from "../llm/pricing.js";
import { getOpenAiClient } from "../llm/openaiClientFactory.js";

export interface EmbedResult {
  vectors: number[][];
  costUsd: number;
}

const BATCH_SIZE = 96; // OpenAI embeddings endpoint accepts an array input — batch to cut request overhead

// Confirmed in production (2026-09-15): this call had no per-call timeout, unlike
// llm/openaiClient.ts's callOpenAI. It fell back to the SDK's ~10-minute default, and — unlike
// an external Promise.race-based timeout (which only stops the CALLER from waiting, never
// actually cancels the underlying HTTP request) — this uses the SDK's own AbortController-based
// timeout, which genuinely aborts the request. contextAssembly.ts's own 60s withTimeout around
// the whole getContext() call was not enough on its own: a review run got stuck for 9+ minutes
// past that 60s bound, with the abandoned embeddings request apparently still occupying
// resources in the background since nothing had actually cancelled it.
const EMBED_CALL_TIMEOUT_MS = 20_000;

/**
 * Rate-limit (429) backoff must honor the API's retry-after (seconds, often
 * several) rather than the sub-second jittered backoff used for transient
 * LLM call errors elsewhere — a TPM bucket that's already exhausted won't
 * clear in 300ms, and a large repo's indexing pass routinely burns through
 * a whole per-minute token budget across its embedding batches.
 */
async function embedBatch(client: OpenAI, model: string, batch: string[], attempts = 5): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.embeddings.create({ model, input: batch }, { timeout: EMBED_CALL_TIMEOUT_MS });
    } catch (err) {
      const isRateLimit = err instanceof OpenAI.APIError && err.status === 429;
      if (!isRateLimit || i === attempts - 1) throw err;
      const retryAfterSec = Number(err.headers?.["retry-after"]);
      const waitMs = (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 1000 * 2 ** i) + Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error("indexer: embedBatch exhausted retries"); // unreachable — loop always returns or throws
}

/** Embeds a batch of chunk texts with the configured embedding model (DESIGN.md §7/§8). */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], costUsd: 0 };

  const model = env().MODEL_EMBED;
  const client = getOpenAiClient();
  const vectors: number[][] = [];
  let totalCostUsd = 0;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await embedBatch(client, model, batch);
    for (const item of res.data) vectors.push(item.embedding);
    totalCostUsd += costUsd(model, res.usage.total_tokens, 0);
  }

  return { vectors, costUsd: totalCostUsd };
}
