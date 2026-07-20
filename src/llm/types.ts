import type { z } from "zod";

export type TaskKind =
  | "pass.logic"
  | "pass.security"
  | "pass.contracts"
  | "pass.concurrency"
  | "pass.errors"
  | "pass.tests"
  | "pass.style"
  | "verify.cross_exam"
  | "verify.repro_gen"
  | "rulebook.compile"
  | "chat.reply";

export interface LlmMessage {
  role: "system" | "user";
  content: string;
  /** Anthropic-only: marks this block as an ephemeral prompt-cache breakpoint (DESIGN.md §8 — file contents/rulebook shared across passes in one run). Ignored by other providers. */
  cacheable?: boolean;
}

export interface CompleteRequest<T> {
  task: TaskKind;
  messages: LlmMessage[];
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface CompleteResult<T> {
  /** null when the model's output failed schema validation even after one repair retry — caller drops it, never crashes the run. */
  data: T | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  /** Which vendor billed this call — used for per-provider spend tracking in the admin console. */
  provider: "anthropic" | "openai";
  raw?: string;
}

export interface LlmRouter {
  complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>>;
}
