/**
 * Approximate USD-per-million-token rates, used only for cost metering /
 * budget enforcement (RUN_COST_CAP_USD) — not billing-grade. Update to match
 * each provider's published pricing page when going to production.
 */
interface Price {
  inputPerM: number;
  outputPerM: number;
}

const PRICES: Record<string, Price> = {
  "claude-sonnet-5": { inputPerM: 3, outputPerM: 15 },
  "claude-haiku-4-5": { inputPerM: 0.8, outputPerM: 4 },
  "gpt-5": { inputPerM: 5, outputPerM: 15 },
  "text-embedding-3-small": { inputPerM: 0.02, outputPerM: 0 },
};

const FALLBACK_PRICE: Price = { inputPerM: 3, outputPerM: 15 };

// Anthropic prompt-caching multipliers on the base input rate (5-minute ephemeral cache):
// writing a cache entry costs more than a normal input token, reading one costs far less.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number },
): number {
  const price = PRICES[model] ?? FALLBACK_PRICE;
  const cacheWriteTokens = cache?.cacheCreationInputTokens ?? 0;
  const cacheReadTokens = cache?.cacheReadInputTokens ?? 0;
  return (
    (inputTokens / 1_000_000) * price.inputPerM +
    (outputTokens / 1_000_000) * price.outputPerM +
    (cacheWriteTokens / 1_000_000) * price.inputPerM * CACHE_WRITE_MULTIPLIER +
    (cacheReadTokens / 1_000_000) * price.inputPerM * CACHE_READ_MULTIPLIER
  );
}
