import OpenAI from "openai";
import { env } from "../config.js";
import { costUsd } from "../llm/pricing.js";
import { getOpenAiClient } from "../llm/openaiClientFactory.js";

export interface EmbedResult {
  vectors: number[][];
  costUsd: number;
}

const BATCH_SIZE = 96; // OpenAI embeddings endpoint accepts an array input — batch to cut request overhead

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
      return await client.embeddings.create({ model, input: batch });
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
