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
  /** Only set when the finding's own defect was confirmed reproducing in the sandbox AND it
   * has a suggestedFix AND repro-gen produced a fixedTestCode for it: "confirmed" means that
   * same repro was re-run with the fix applied and it passed (the strongest possible signal a
   * suggested fix actually works, not just that it's syntactically plausible); "failed" means
   * it was re-run and the defect still reproduced. Omitted whenever the check wasn't attempted
   * (no sandbox, no fix, no fixedTestCode) — that is NOT the same as "failed". */
  fixVerified?: "confirmed" | "failed";
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
/**
 * For findings whose evidence is a deterministic pattern match rather than an LLM claim —
 * e.g. engine/secretsScan.ts's vendor-token-format matches — cross-examination would add cost
 * and a real risk the skeptic wrongly "refutes" a mechanical fact (the exact string IS present
 * in the file; that's all a regex match ever claims), which would defeat the entire point of a
 * guaranteed, judgment-free safety net sitting alongside the LLM passes. The static existence
 * check alone is the right and sufficient verification here.
 */
export function verifyDeterministicFinding(candidate: Candidate, files: Map<string, string>): VerifyOutcome {
  const staticResult = staticExistenceCheck(candidate, files);
  const shared = { costUsd: 0, anthropicCostUsd: 0, openaiCostUsd: 0, inputTokens: 0, outputTokens: 0 } as const;
  return staticResult.passed
    ? { status: "verified", method: "static", verifiedHow: staticResult.reason, ...shared }
    : { status: "rejected", method: "static", verifiedHow: staticResult.reason, ...shared };
}

export async function verifyFinding(
  router: LlmRouter,
  candidate: Candidate,
  files: Map<string, string>,
  runSandbox: (language: NonNullable<ReturnType<typeof sandboxLanguageFor>>, testCode: string) => Promise<SandboxResult> = runInSandbox,
  /** This PR's diff text for candidate.path, when the caller has it — see crossExamine.ts's doc comment for why this matters. */
  diffText?: string,
  /** Best-effort repo-index text (buildRepoContextBlock output) — see crossExamine.ts's doc
   * comment. Only forwarded for `contracts` findings: that category's entire nature is
   * cross-file impact, so the skeptic needs the same caller/definition visibility the pass
   * had; other categories are file-local enough that the extra tokens on every verify call
   * wouldn't be worth the cost. */
  repoContextText?: string,
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

  // Cross-file visibility is only worth the extra tokens for categories whose claims are
  // inherently about code elsewhere: contracts ("this breaks a caller elsewhere") and tests
  // ("no test covers this" / "existing test elsewhere is now wrong") — the skeptic needs the
  // same caller/definition/related-test evidence the pass had for either. Other categories are
  // file-local enough that this would just add cost with no real verification benefit.
  const isCrossFileClaim = candidate.category === "contracts" || candidate.category === "tests";
  const [crossExam, repro] = await Promise.all([
    crossExamine(router, candidate, fileContent, diffText, isCrossFileClaim ? files : undefined, isCrossFileClaim ? repoContextText : undefined),
    sandboxLang ? generateRepro(router, candidate, fileContent) : Promise.resolve(null),
  ]);

  // repro_gen.v1.md tells the model to report `language` matching the file's actual
  // language, but nothing enforced that until now — if the model's self-reported
  // language explicitly disagreed with sandboxLang (derived from the file's own
  // extension), the mismatched testCode would still run through sandboxLang's
  // interpreter. A crash from running code in the WRONG runtime (e.g. JS fed to
  // python3) exits non-zero same as a genuine repro, which runInSandbox reports as
  // reproduced:true — the strongest, auto-trusted verification outcome in the whole
  // pipeline. Only skip on an EXPLICIT mismatch, not a merely-omitted (optional)
  // language field, since that's much weaker evidence something is actually wrong.
  const languageMismatch = repro?.data?.language !== undefined && repro.data.language !== sandboxLang;

  let sandboxAttempted = false;
  let sandboxReproduced = false;
  let sandboxOutput = "";
  let fixVerified: "confirmed" | "failed" | undefined;
  if (sandboxLang && repro?.data?.canGenerate && repro.data.testCode && !languageMismatch) {
    const sandbox = await runSandbox(sandboxLang, repro.data.testCode);
    if (sandbox.available) {
      sandboxAttempted = true;
      sandboxReproduced = sandbox.reproduced;
      sandboxOutput = sandbox.output;

      // Only worth checking the suggested fix once the sandbox has actually confirmed the
      // defect is real — with nothing confirmed reproducing, there's no repro to re-run the
      // fix against. This is the one place a suggestedFix is ever actually EXECUTED, rather
      // than only checked for placeholders/size/syntax (engine/suggestedFix.ts) — those catch
      // an obviously bad suggestion, not one that's well-formed but doesn't actually work.
      if (sandboxReproduced && candidate.suggestedFix && repro.data.fixedTestCode) {
        const fixSandbox = await runSandbox(sandboxLang, repro.data.fixedTestCode);
        if (fixSandbox.available) {
          fixVerified = fixSandbox.reproduced ? "failed" : "confirmed";
        }
      }
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
    const fixNote =
      fixVerified === "confirmed"
        ? " The suggested fix was executed against the same repro and confirmed to resolve it."
        : fixVerified === "failed"
          ? " The suggested fix was executed against the same repro and did NOT resolve it — dropped."
          : "";
    return {
      status: "verified",
      method: "execution",
      verifiedHow: `Reproduced the described defect in an isolated sandbox run.${sandboxOutput ? ` Output: ${sandboxOutput.slice(0, 300)}` : ""}${fixNote}`,
      ...usage,
      ...(fixVerified ? { fixVerified } : {}),
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
