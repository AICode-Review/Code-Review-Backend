import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { env } from "../config.js";
import type { LlmMessage } from "./types.js";

let client: Anthropic | undefined;
let bedrockClient: AnthropicBedrock | undefined;

/**
 * Self-hosted edition (DESIGN.md §11) — AWS_REGION configured means "use
 * Bedrock" ("router honors availability"). Bedrock's Messages API doesn't
 * reliably support the prompt-caching beta endpoint the direct path uses
 * below, so this mode skips it and just sends plain system/user messages —
 * correctness over the cache-cost optimization when self-hosted on Bedrock.
 */
function getBedrockClient(): AnthropicBedrock {
  const e = env();
  // The constructor's overloads key on which of awsAccessKey/awsSecretKey are present
  // (both/one/neither, falling back to the standard AWS credential chain when neither
  // is set) — the exact combination is only known at runtime here, which no single
  // overload signature can express statically.
  const options = {
    awsRegion: e.AWS_REGION,
    awsAccessKey: e.AWS_ACCESS_KEY_ID,
    awsSecretKey: e.AWS_SECRET_ACCESS_KEY,
  } as ConstructorParameters<typeof AnthropicBedrock>[0];
  bedrockClient ??= new AnthropicBedrock(options);
  return bedrockClient;
}

function getClient(): Anthropic {
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set — required for logic/security/contracts passes");
  client ??= new Anthropic({ apiKey });
  return client;
}

export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens that wrote a new cache entry on this call (Anthropic only; billed at a premium over base input). */
  cacheCreationInputTokens?: number;
  /** Input tokens served from an existing cache entry on this call (Anthropic only; billed at a steep discount vs base input). */
  cacheReadInputTokens?: number;
}

/**
 * Uses the prompt-caching beta endpoint so `cacheable` system blocks (the
 * diff + full file contents + rulebook, built once per review run and
 * identical across the 7 specialist passes) get an ephemeral cache
 * breakpoint — DESIGN.md §8. Non-cacheable blocks (each pass's own
 * instructions) are sent as plain system blocks with no cache_control, so
 * they never pin an unnecessary cache write.
 */
export async function callAnthropic(model: string, messages: LlmMessage[], maxTokens: number): Promise<ProviderResult> {
  const systemMessages = messages.filter((m) => m.role === "system");
  const userMessages = messages.filter((m) => m.role === "user");
  const anthropicMessages = userMessages.map((m) => ({ role: "user" as const, content: m.content }));

  if (env().AWS_REGION) {
    const res = await getBedrockClient().messages.create({
      model,
      max_tokens: maxTokens,
      ...(systemMessages.length > 0 ? { system: systemMessages.map((m) => m.content).join("\n\n") } : {}),
      messages: anthropicMessages,
    });
    // The Bedrock SDK bundles its own nested @anthropic-ai/sdk types, distinct
    // from the top-level one used elsewhere in this file — plain runtime check.
    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }

  const system = systemMessages.map((m) => ({
    type: "text" as const,
    text: m.content,
    ...(m.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));

  const res = await getClient().beta.promptCaching.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: anthropicMessages,
  });

  const text = res.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheCreationInputTokens: res.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: res.usage.cache_read_input_tokens ?? 0,
  };
}
