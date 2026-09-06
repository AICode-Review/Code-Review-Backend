/**
 * Approximate USD-per-million-token rates, used only for cost metering /
 * budget enforcement (RUN_COST_CAP_USD) — not billing-grade. Update to match
 * each provider's published pricing page when going to production.
 *
 * Checked against Anthropic's and OpenAI's own published rates 2026-09 (previous values here
 * were stale: claude-sonnet-5 was overpriced ~50%, claude-haiku-4-5 underpriced ~20-25%, gpt-5
 * overpriced ~2-4x — all three were skewing RUN_COST_CAP_USD enforcement and the admin
 * console's per-provider spend dashboard away from real spend). gpt-5's $1.25/$10 figure is
 * OpenAI's own docs; third-party aggregators show a lower ~$0.625/$5 figure that may reflect an
 * older or promotional rate — the higher, officially-sourced number is used here deliberately
 * (the conservative direction for a cost cap).
 */
interface Price {
  inputPerM: number;
  outputPerM: number;
}

const PRICES: Record<string, Price> = {
  "claude-sonnet-5": { inputPerM: 2, outputPerM: 10 },
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5 },
  "gpt-5": { inputPerM: 1.25, outputPerM: 10 },
  "text-embedding-3-small": { inputPerM: 0.02, outputPerM: 0 },
};

const FALLBACK_PRICE: Price = { inputPerM: 2, outputPerM: 10 };

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
