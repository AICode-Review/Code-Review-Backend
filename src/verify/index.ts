import type { LlmRouter } from "../llm/types.js";
import type { Candidate } from "../engine/schemas.js";
import { staticExistenceCheck } from "./staticCheck.js";
import { crossExamine } from "./crossExamine.js";
import { generateRepro } from "./reproGen.js";
import { runInSandbox, sandboxLanguageFor, type SandboxResult } from "./sandbox.js";

export { staticExistenceCheck } from "./staticCheck.js";
export type { StaticCheckResult } from "./staticCheck.js";

export interface VerifyOutcome {
  status: "verified" | "rejected";
  method: "static" | "cross_exam" | "execution";
  verifiedHow: string;
  costUsd: number;
  /** Anthropic: repro-gen (when needsExecution). OpenAI: skeptic cross-exam. */
  anthropicCostUsd: number;
  openaiCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface Usage {
  costUsd: number;
  anthropicCostUsd: number;
  openaiCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** A sandbox `not_reproduced` still yields to a cross-exam "upheld" at this confidence bar — DESIGN.md §7.3's "unless cross-exam upheld with high confidence." */
const HIGH_CONFIDENCE_THRESHOLD = 0.75;

function sumUsage(...parts: Usage[]): Usage {
  return parts.reduce(
    (acc, p) => ({
      costUsd: acc.costUsd + p.costUsd,
      anthropicCostUsd: acc.anthropicCostUsd + p.anthropicCostUsd,
      openaiCostUsd: acc.openaiCostUsd + p.openaiCostUsd,
      inputTokens: acc.inputTokens + p.inputTokens,
      outputTokens: acc.outputTokens + p.outputTokens,
    }),
    { costUsd: 0, anthropicCostUsd: 0, openaiCostUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
}

/**
 * DESIGN.md §6.5/§7.3 — static existence check (always, cheap), then
 * cross-examination by a different model vendor, plus — only for
 * `needsExecution` findings on a sandbox-supported language (node/python/jvm)
 * — an attempt to reproduce the defect in an isolated, no-network Docker
 * sandbox. A confirmed reproduction is the strongest possible signal and
 * verifies on its own; a sandbox that runs but fails to reproduce still
 * yields to a high-confidence cross-exam "upheld" rather than auto-rejecting
 * (§7.3's own escape hatch, since a repro test can itself be imperfect).
 * Docker being unavailable degrades silently to the cross-exam-only path —
 * it is never treated as a rejection signal.
 *
 * Precision-first policy otherwise unchanged: absent a sandbox reproduction,
 * ONLY an explicit "upheld" cross-exam verdict counts as verified.
 * "refuted", "uncertain", and an unparseable skeptic response are all
 * rejected — an unconfirmed finding must never reach a PR, even at the cost
 * of occasionally dropping a real bug. When in doubt, say nothing.
 */
export async function verifyFinding(
  router: LlmRouter,
  candidate: Candidate,
  files: Map<string, string>,
  runSandbox: (language: NonNullable<ReturnType<typeof sandboxLanguageFor>>, testCode: string) => Promise<SandboxResult> = runInSandbox,
): Promise<VerifyOutcome> {
  const staticResult = staticExistenceCheck(candidate, files);
  if (!staticResult.passed) {
    return {
      status: "rejected",
      method: "static",
      verifiedHow: staticResult.reason,
      costUsd: 0,
      anthropicCostUsd: 0,
      openaiCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const fileContent = files.get(candidate.path) ?? "";
  const sandboxLang = candidate.needsExecution ? sandboxLanguageFor(candidate.path) : null;

  const [crossExam, repro] = await Promise.all([
    crossExamine(router, candidate, fileContent),
    sandboxLang ? generateRepro(router, candidate, fileContent) : Promise.resolve(null),
  ]);

  let sandboxAttempted = false;
  let sandboxReproduced = false;
  let sandboxOutput = "";
  if (sandboxLang && repro?.data?.canGenerate && repro.data.testCode) {
    const sandbox = await runSandbox(sandboxLang, repro.data.testCode);
    if (sandbox.available) {
      sandboxAttempted = true;
      sandboxReproduced = sandbox.reproduced;
      sandboxOutput = sandbox.output;
    }
  }

  // Cross-exam → OpenAI skeptic; repro-gen → Anthropic mid (same vendor as specialist passes).
  const usage = sumUsage(
    {
      costUsd: crossExam.costUsd,
      anthropicCostUsd: 0,
      openaiCostUsd: crossExam.costUsd,
      inputTokens: crossExam.inputTokens,
      outputTokens: crossExam.outputTokens,
    },
    repro
      ? {
          costUsd: repro.costUsd,
          anthropicCostUsd: repro.costUsd,
          openaiCostUsd: 0,
          inputTokens: repro.inputTokens,
          outputTokens: repro.outputTokens,
        }
      : { costUsd: 0, anthropicCostUsd: 0, openaiCostUsd: 0, inputTokens: 0, outputTokens: 0 },
  );

  if (sandboxAttempted && sandboxReproduced) {
    return {
      status: "verified",
      method: "execution",
      verifiedHow: `Reproduced the described defect in an isolated sandbox run.${sandboxOutput ? ` Output: ${sandboxOutput.slice(0, 300)}` : ""}`,
      ...usage,
    };
  }

  if (!crossExam.data) {
    return {
      status: "rejected",
      method: "cross_exam",
      verifiedHow: "Cross-examination response could not be parsed — no confirming signal, so this was not posted.",
      ...usage,
    };
  }

  const crossExamVerified = crossExam.data.verdict === "upheld";

  if (sandboxAttempted && !sandboxReproduced) {
    if (crossExamVerified && candidate.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      return { status: "verified", method: "cross_exam", verifiedHow: crossExam.data.reasoning, ...usage };
    }
    return {
      status: "rejected",
      method: "execution",
      verifiedHow: "The sandbox ran the generated repro test and it passed — the described defect did not reproduce.",
      ...usage,
    };
  }

  // No sandbox attempt (not needsExecution, unsupported language, no generatable repro, or Docker unavailable) — cross-exam-only, as in v1.
  return crossExamVerified
    ? { status: "verified", method: "cross_exam", verifiedHow: crossExam.data.reasoning, ...usage }
    : { status: "rejected", method: "cross_exam", verifiedHow: crossExam.data.reasoning, ...usage };
}
