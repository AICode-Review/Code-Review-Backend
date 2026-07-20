import OpenAI, { AzureOpenAI } from "openai";
import { env } from "../config.js";

let client: OpenAI | undefined;

/**
 * Self-hosted edition (DESIGN.md §11) — auto-detects Azure OpenAI when
 * AZURE_OPENAI_ENDPOINT is configured ("router honors availability"),
 * otherwise falls back to direct OpenAI. `AzureOpenAI` extends `OpenAI` with
 * an identical `.chat.completions`/`.embeddings` surface, so callers never
 * need to branch on which one they got — for Azure, set MODEL_SKEPTIC/
 * MODEL_EMBED to the Azure *deployment* name rather than a raw model id.
 */
export function getOpenAiClient(): OpenAI {
  if (client) return client;
  const e = env();

  if (e.AZURE_OPENAI_ENDPOINT) {
    const apiKey = e.AZURE_OPENAI_API_KEY ?? e.OPENAI_API_KEY;
    if (!apiKey) throw new Error("AZURE_OPENAI_API_KEY (or OPENAI_API_KEY) is not set — required when AZURE_OPENAI_ENDPOINT is configured");
    client = new AzureOpenAI({ apiKey, endpoint: e.AZURE_OPENAI_ENDPOINT, apiVersion: e.AZURE_OPENAI_API_VERSION });
    return client;
  }

  const apiKey = e.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set — required for cross-examination verification and embeddings");
  client = new OpenAI({ apiKey });
  return client;
}
