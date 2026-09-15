import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdapter } from "../adapters/index.js";
import type { PlatformAdapter } from "../adapters/types.js";
import { getDb } from "../db/client.js";
import {
  canReviewRepo,
  cancelOtherRunsForPr,
  formatUsageLimitMessage,
  getActiveRulebookRules,
  getOrgOwnerEmail,
  getOrgPlan,
  getOrgUsage,
  getPriorFindingFeedback,
  getRepoConfig,
  getRunStatus,
  isRepoPrivate,
  recordAudit,
  upsertPrChain,
} from "../db/repositories.js";
import { env } from "../config.js";
import { emailConfigured, sendEmail } from "../email/smtp.js";
import { reviewCompleteEmail } from "../email/templates.js";
import { createLlmRouter } from "../llm/router.js";
import type { LlmRouter } from "../llm/types.js";
import {
  assembleContext,
  buildRepoContextBlock,
} from "../engine/contextAssembly.js";
import { diffTextForPath } from "../engine/diff.js";
import { runAllPasses } from "../engine/passRunner.js";
import {
  mergeAndScore,
  suppressPreviouslyDismissed,
  type PassCandidates,
  type RulebookBoost,
} from "../engine/merge.js";
import { isReviewableSourcePath } from "../engine/binaryFiles.js";
import { extractCodeSnippet } from "../engine/snippet.js";
import {
  validateSuggestedFix,
  validateSuggestedFixSyntax,
} from "../engine/suggestedFix.js";
import { verifyDeterministicFinding, verifyFinding } from "../verify/index.js";
import { scanForSecrets, SECRETS_SCAN_PASS } from "../engine/secretsScan.js";
import {
  scanDependencies,
  DEPENDENCY_SCAN_PASS,
} from "../engine/dependencyScan.js";
import { generateWalkthrough } from "../engine/prWalkthrough.js";
import {
  generateDiagram,
  type DiagramCallResult,
} from "../engine/prDiagram.js";
import {
  buildLineCommentBody,
  buildSummaryMarkdown,
  computeCheckState,
  computeRiskLevel,
  selectForDelivery,
  type DeliverableFinding,
} from "../engine/delivery.js";
import { enqueueRulebookCompile } from "../queue/index.js";
import type { ReviewRunJob } from "../queue/index.js";
import type { LineComment, PrRef } from "../types/domain.js";

function buildRulebookBoost(
  rules: { category: string; weight: number }[],
): RulebookBoost {
  return (category: string) => {
    const matching = rules.filter((r) => r.category === category);
    if (matching.length === 0) return 1;
    return matching.reduce((product, r) => product * r.weight, 1);
  };
}

/** GitHub and Bitbucket's web PR URLs — no adapter method returns this today, so it's built directly from the ref rather than adding a round-trip for something this cheap to compute. */
function prWebUrl(pr: PrRef): string {
  return pr.repo.platform === "bitbucket"
    ? `https://bitbucket.org/${pr.repo.owner}/${pr.repo.name}/pull-requests/${pr.number}`
    : `https://github.com/${pr.repo.owner}/${pr.repo.name}/pull/${pr.number}`;
}

/** Thrown when a newer push superseded this run — caught below and treated as a clean stop, never a failure. */
class RunCancelledError extends Error {}

// TEMPORARY diagnostic tracing (2026-09-15): two independent, verified-correct fixes to the
// LLM call layer (a 90s per-call timeout, then disabling HTTP keep-alive) produced ZERO change
// in a reproducible indefinite hang — same signature both times (stuck "running", zero
// cost/candidates, no error). That means the hang is most likely upstream of any LLM call
// entirely, and guessing at further fixes without real visibility just burns more test cycles.
// This piggybacks on the existing worker_heartbeats table (already service-role-writable, no
// migration needed) to record exactly which stage a run reached, queryable directly from
// Postgres without depending on Render's log UI or a copy-pasted excerpt. Remove once the real
// hang point is found and fixed.
async function markCheckpoint(db: SupabaseClient, traceKey: string, stage: string): Promise<void> {
  try {
    await db
      .from("worker_heartbeats")
      .upsert({ id: `checkpoint:${traceKey}:${stage}`, updated_at: new Date().toISOString() });
  } catch {
    // best-effort only — tracing must never affect the run itself
  }
}

/**
 * Execution-sandbox verification (Pricing page: Pro+) — degrades exactly like a genuinely
 * unavailable Docker host (verify/sandbox.ts's own `available: false` path), so a free-tier
 * finding still gets cross-exam-only verification rather than failing outright.
 */
async function disabledSandbox(): Promise<{
  available: boolean;
  reproduced: boolean;
  output: string;
}> {
  return { available: false, reproduced: false, output: "" };
}

/** DESIGN.md §6.1: bail out (no wasted LLM spend, no stale post) if a newer push has cancelled this run. */
async function throwIfCancelled(
  db: ReturnType<typeof getDb>,
  runId: string,
): Promise<void> {
  const status = await getRunStatus(db, runId);
  if (status === "cancelled")
    throw new RunCancelledError(
      `review_run ${runId} was cancelled — a newer push superseded it`,
    );
}

export interface ReviewRunDeps {
  db: SupabaseClient;
  adapter: PlatformAdapter;
  router: LlmRouter;
}

/**
 * DESIGN.md §6 — the full review pipeline: context assembly, specialist
 * passes, merge/score, verification, budgeted delivery. Runs once per
 * review_runs row, created either by the caller (manual trigger / rerun,
 * via job.runId) or by this function itself (webhook-triggered runs).
 *
 * `deps` defaults to the real production db/adapter/router and is never
 * passed by worker.ts — it exists so orchestrator-level tests can inject a
 * fake db and fake router and exercise this whole function for real,
 * without live Supabase/GitHub/Anthropic/OpenAI access.
 */
export async function handleReviewRun(
  job: ReviewRunJob,
  deps?: Partial<ReviewRunDeps>,
): Promise<void> {
  const startedAt = Date.now();
  const db = deps?.db ?? getDb();
  const adapter = deps?.adapter ?? getAdapter(job.pr.repo.platform);
  const router = deps?.router ?? createLlmRouter();

  let runId = job.runId;
  let knownHeadSha = job.headSha;
  let spentUsd = 0;
  let spentAnthropicUsd = 0;
  let spentOpenaiUsd = 0;
  let completedHere = false;
  const traceKey = `${job.pr.repo.owner}/${job.pr.repo.name}#${job.pr.number}`;
  try {
    await markCheckpoint(db, traceKey, "0_handler_entered");
    if (runId && (await getRunStatus(db, runId)) !== "queued") return;
    await markCheckpoint(db, traceKey, "1_before_getPrInfo");
    // Always fetch authoritative PR info — webhook `command` events arrive with
    // no head sha, and REST-triggered runs need base sha for the diff too.
    const prInfo = await adapter.getPrInfo(job.pr);
    await markCheckpoint(db, traceKey, "2_got_pr_info");
    const headSha = prInfo.headSha;
    knownHeadSha = headSha;
    const pr = { ...job.pr, title: prInfo.title, author: prInfo.author };

    const { orgId, repoId, prId } = await upsertPrChain(db, pr, headSha);
    await markCheckpoint(db, traceKey, "3_upserted_pr_chain");

    // Platform-admin suspend kill-switch — blocks all reviews for the org (webhook + manual + rerun).
    const { getOrgSuspension } = await import("../db/adminRepositories.js");
    const suspension = await getOrgSuspension(db, orgId);
    await markCheckpoint(db, traceKey, "4_checked_suspension");
    if (suspension.suspended) {
      const message = suspension.suspendedReason
        ? `This organization is suspended: ${suspension.suspendedReason}`
        : "This organization is suspended. Contact support.";
      await recordAudit(
        db,
        orgId,
        "system",
        "review.blocked_by_suspend",
        repoId,
        {
          reason: "org_suspended",
          suspendedReason: suspension.suspendedReason,
        },
      );
      if (job.runId) {
        await db
          .from("review_runs")
          .update({
            status: "failed",
            error: message,
            blocked_reason: "org_suspended",
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.runId);
      } else {
        await db.from("review_runs").insert({
          pr_id: prId,
          head_sha: headSha,
          status: "failed",
          error: message,
          blocked_reason: "org_suspended",
          trigger: "automatic",
          finished_at: new Date().toISOString(),
        });
      }
      return;
    }

    // Plan enforcement: free plan is public-repos-only. Blocked before any run row is spun
    // up/spent-on — this is a hard "review never runs," not a partial/degraded one.
    const repoIsPrivate = await isRepoPrivate(db, repoId);
    await markCheckpoint(db, traceKey, "5_checked_private");
    if (!(await canReviewRepo(db, orgId, repoIsPrivate))) {
      const message =
        "This repo is private, which requires a Pro or Team plan. Upgrade in Settings to enable reviews on it.";
      await recordAudit(db, orgId, "system", "review.blocked_by_plan", repoId, {
        reason: "private_repo_free_plan",
      });
      if (job.runId) {
        await db
          .from("review_runs")
          .update({
            status: "failed",
            error: message,
            blocked_reason: "private_repo_free_plan",
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.runId);
      } else {
        await db.from("review_runs").insert({
          pr_id: prId,
          head_sha: headSha,
          status: "failed",
          error: message,
          blocked_reason: "private_repo_free_plan",
          trigger: "automatic",
          finished_at: new Date().toISOString(),
        });
      }
      return;
    }

    // Monthly usage quota (DESIGN.md pricing — hard-block once exceeded). Checked after the
    // private-repo gate so a run blocked there never reaches (or counts against) this one.
    const usage = await getOrgUsage(db, orgId, runId);
    await markCheckpoint(db, traceKey, "6_checked_usage");
    if (usage.blocked) {
      const message = formatUsageLimitMessage(usage);
      await recordAudit(
        db,
        orgId,
        "system",
        "review.blocked_by_quota",
        repoId,
        {
          reason: "monthly_quota_exceeded",
          used: usage.used,
          quota: usage.quota,
        },
      );
      if (job.runId) {
        await db
          .from("review_runs")
          .update({
            status: "failed",
            error: message,
            blocked_reason: "monthly_quota_exceeded",
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.runId);
      } else {
        await db.from("review_runs").insert({
          pr_id: prId,
          head_sha: headSha,
          status: "failed",
          error: message,
          blocked_reason: "monthly_quota_exceeded",
          trigger: "automatic",
          finished_at: new Date().toISOString(),
        });
      }
      return;
    }

    await cancelOtherRunsForPr(db, prId, job.runId);
    await markCheckpoint(db, traceKey, "7_cancelled_other_runs");

    if (runId) {
      const claim = await db
        .from("review_runs")
        .update({
          status: "running",
          head_sha: headSha,
          quota_limit: usage.quota ?? -1,
        })
        .eq("id", runId)
        .eq("status", "queued")
        .select("id")
        .maybeSingle();
      if (claim.error)
        throw new Error(`failed to claim review_run: ${claim.error.message}`);
      if (!claim.data) return;
    } else {
      const { data: run, error } = await db
        .from("review_runs")
        .insert({
          pr_id: prId,
          head_sha: headSha,
          status: "running",
          quota_limit: usage.quota ?? -1,
          trigger: "automatic",
        })
        .select("id")
        .single();
      if (error || !run)
        throw new Error(
          `failed to create review_run: ${error?.message ?? "no row"}`,
        );
      runId = run.id as string;
    }
    await markCheckpoint(db, traceKey, "8_claimed_row");

    // Progress checkpoints, not just start/end — a run that never logs the NEXT one again
    // has hung at a specific, locatable point instead of leaving zero trace (2026-09-14:
    // a real run hung indefinitely between "running" and any LLM cost being recorded, and
    // diagnosing which await never returned took reconstructing timestamps from unrelated
    // request logs, since nothing here logged its own progress).
    console.log(`[reviewRun] ${runId} fetching repo config/rulebook/feedback`);
    await markCheckpoint(db, traceKey, "9_before_config_fetch");
    const [repoConfig, rulebookRules, priorFeedback] = await Promise.all([
      getRepoConfig(db, repoId),
      getActiveRulebookRules(db, orgId, repoId),
      getPriorFindingFeedback(db, prId, runId),
    ]);
    await markCheckpoint(db, traceKey, "10_got_config");

    console.log(`[reviewRun] ${runId} assembling context (diff + changed files + repo index)`);
    await markCheckpoint(db, traceKey, "11_before_assembleContext");
    const ctx = await assembleContext(
      adapter,
      pr,
      prInfo.baseSha,
      headSha,
      { db, repoId },
      repoConfig.ignoredPaths,
    );
    await markCheckpoint(db, traceKey, "12_after_assembleContext");
    console.log(`[reviewRun] ${runId} context ready — ${ctx.files.length} file(s) fetched, starting specialist passes`);
    const fetchedPaths = new Set(ctx.files.map((file) => file.path));
    const missingFiles = ctx.prDiff.files.filter(
      (file) =>
        file.path !== "(deleted)" &&
        isReviewableSourcePath(file.path) &&
        !fetchedPaths.has(file.path),
    ).length;
    const truncatedFiles = ctx.files.filter((file) => file.truncated).length;
    const coverageWarnings: string[] = [];
    if (missingFiles)
      coverageWarnings.push(
        "Full source was unavailable for " +
          missingFiles +
          " changed file(s), due to fetch failures or the file limit.",
      );
    if (truncatedFiles)
      coverageWarnings.push(
        truncatedFiles +
          " changed file(s) exceeded the source length limit and were truncated.",
      );

    await throwIfCancelled(db, runId);

    const costCap = env().RUN_COST_CAP_USD;
    // The PR-summary diagram (DESIGN.md §10) is GitHub-only: GitHub renders Mermaid natively
    // in comment markdown, Bitbucket does not, so a Bitbucket PR never even pays for the
    // generation call — not just "generated but not shown."
    const wantsDiagram = pr.repo.platform === "github";
    const NO_DIAGRAM: DiagramCallResult = {
      data: null,
      costUsd: 0,
      anthropicCostUsd: 0,
      openaiCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const [
      {
        results,
        totalCostUsd: passesCostUsd,
        anthropicCostUsd: passesAnthropicCostUsd,
        openaiCostUsd: passesOpenaiCostUsd,
        skippedPasses,
      },
      walkthrough,
      diagram,
    ] = await (async () => {
      await markCheckpoint(db, traceKey, "13_before_passes");
      const result = await Promise.all([
        runAllPasses(router, ctx, {
          rulebook: rulebookRules,
          costCapUsd: costCap,
        }),
        generateWalkthrough(router, ctx.prDiff),
        wantsDiagram
          ? generateDiagram(router, ctx.prDiff)
          : Promise.resolve(NO_DIAGRAM),
      ]);
      await markCheckpoint(db, traceKey, "14_after_passes");
      return result;
    })();
    console.log(`[reviewRun] ${runId} specialist passes complete — ${results.length} candidate(s), verifying`);
    // The walkthrough and diagram are bonus orientation, not specialist passes — neither
    // competes for the pass budget above, but their (typically small) cost still counts
    // toward the run's total spend and per-provider tracking, same as everything else.
    const passCostUsd = passesCostUsd + walkthrough.costUsd + diagram.costUsd;
    const passAnthropicCostUsd =
      passesAnthropicCostUsd +
      walkthrough.anthropicCostUsd +
      diagram.anthropicCostUsd;
    const passOpenaiCostUsd =
      passesOpenaiCostUsd + walkthrough.openaiCostUsd + diagram.openaiCostUsd;

    spentUsd = passCostUsd;
    spentAnthropicUsd = passAnthropicCostUsd;
    spentOpenaiUsd = passOpenaiCostUsd;
    const droppedPasses = results
      .filter((result) => result.dropped)
      .map((result) => result.pass);
    if (droppedPasses.length)
      coverageWarnings.push(
        "Analysis unavailable: " + droppedPasses.join(", ") + ".",
      );
    if (skippedPasses.length)
      coverageWarnings.push(
        "Analysis skipped at the cost limit: " + skippedPasses.join(", ") + ".",
      );
    let verificationSkipped = 0;
    let verificationUnavailable = 0;
    const candidatesByPass: PassCandidates[] = results.map((r) => ({
      pass: r.pass,
      candidates: r.candidates,
    }));
    // Deterministic scans (engine/secretsScan.ts, engine/dependencyScan.ts) — run regardless of
    // the cost cap and every LLM pass's own output, since neither costs an LLM call and neither
    // should depend on an LLM happening to notice. Findings from either "pass" skip
    // cross-examination in the verify loop below (verifyDeterministicFinding) rather than
    // risking a skeptic wrongly refuting a mechanical, database/regex-backed match. A
    // dependency-scan failure (OSV.dev unreachable) degrades to zero findings, same as the
    // repo index timing out — it never fails the run.
    candidatesByPass.push({
      pass: SECRETS_SCAN_PASS,
      candidates: scanForSecrets(ctx.prDiff),
    });
    candidatesByPass.push({
      pass: DEPENDENCY_SCAN_PASS,
      candidates: await scanDependencies(ctx.prDiff),
    });
    const rulebookBoost = buildRulebookBoost(rulebookRules);
    const merged = suppressPreviouslyDismissed(
      mergeAndScore(candidatesByPass, rulebookBoost),
      priorFeedback,
    );

    await throwIfCancelled(db, runId);

    const filesByPath = new Map(ctx.files.map((f) => [f.path, f.content]));
    const repoContextText = buildRepoContextBlock(ctx.repoContext) ?? undefined;
    const deliverable: DeliverableFinding[] = [];
    let verifyCostUsd = 0;
    let verifyAnthropicCostUsd = 0;
    let verifyOpenaiCostUsd = 0;

    // Execution-sandbox verification is Pro+ (Pricing page) — free-tier orgs verify via
    // cross-examination only, same as when Docker itself is unavailable.
    const orgPlan = await getOrgPlan(db, orgId);
    const sandboxOverride = orgPlan === "free" ? disabledSandbox : undefined;

    for (const m of merged) {
      // A deterministic-scan-only finding never touched the LLM to produce, so it doesn't need
      // the cost cap guard either — checked first, before the cap check below would otherwise
      // silently drop a real leaked credential or vulnerable dependency purely because other
      // LLM passes used up the run's budget first.
      if (
        m.passes.includes(SECRETS_SCAN_PASS) ||
        m.passes.includes(DEPENDENCY_SCAN_PASS)
      ) {
        const outcome = verifyDeterministicFinding(m, filesByPath);
        const sourceContent = filesByPath.get(m.path);
        deliverable.push({
          ...m,
          verificationStatus: outcome.status,
          verificationMethod: outcome.method,
          verifiedHow: outcome.verifiedHow,
          codeSnippet: env().ZERO_RETENTION
            ? null
            : sourceContent
              ? extractCodeSnippet(sourceContent, m.startLine, m.endLine)
              : null,
        });
        continue;
      }

      if (passCostUsd + verifyCostUsd >= costCap) {
        verificationSkipped++;
        // Cost cap reached — remaining candidates are dropped from this run entirely (never posted unverified).
        continue;
      }
      const outcome = await verifyFinding(
        router,
        m,
        filesByPath,
        sandboxOverride,
        diffTextForPath(ctx.prDiff, m.path) ?? undefined,
        repoContextText,
      );
      if (outcome.incomplete) verificationUnavailable++;
      verifyCostUsd += outcome.costUsd;
      verifyAnthropicCostUsd += outcome.anthropicCostUsd;
      verifyOpenaiCostUsd += outcome.openaiCostUsd;
      spentUsd = passCostUsd + verifyCostUsd;
      spentAnthropicUsd = passAnthropicCostUsd + verifyAnthropicCostUsd;
      spentOpenaiUsd = passOpenaiCostUsd + verifyOpenaiCostUsd;
      const sourceContent = filesByPath.get(m.path);

      // suggestedFix never goes through verify/ (it's not the finding, it's a proposed
      // edit), so nothing else catches a hallucinated/no-op/placeholder "fix" before a
      // developer one-click-applies it. Sanity-check against the exact cited range and
      // drop the field (never the finding) rather than ship a bad suggestion.
      let suggestedFix = m.suggestedFix;
      if (suggestedFix) {
        const exactOriginal = sourceContent
          ? extractCodeSnippet(sourceContent, m.startLine, m.endLine, 0)
          : null;
        const check = exactOriginal
          ? validateSuggestedFix(suggestedFix, exactOriginal)
          : { valid: false, reason: "original lines unavailable" };
        if (!check.valid) {
          console.warn(
            `[reviewRun] dropped suggestedFix for ${m.path}:${m.startLine} — ${check.reason}`,
          );
          suggestedFix = undefined;
        } else if (sourceContent) {
          // Stronger than the format check above: actually re-parse the file with the
          // fix spliced in, catching a syntactically broken suggestion (unbalanced
          // brace, stray comma) the format check alone can't see.
          const syntaxCheck = await validateSuggestedFixSyntax(
            m.path,
            sourceContent,
            m.startLine,
            m.endLine,
            suggestedFix,
          );
          if (!syntaxCheck.valid) {
            console.warn(
              `[reviewRun] dropped suggestedFix for ${m.path}:${m.startLine} — ${syntaxCheck.reason}`,
            );
            suggestedFix = undefined;
          }
        }
      }
      // Strongest possible check, when it ran: verify/index.ts actually re-executed the same
      // sandbox repro with this fix applied. "failed" here outranks the format/syntax checks
      // above (both of which can pass on a fix that's well-formed but simply doesn't work) —
      // it means we have direct proof, not an inference, that the suggestion doesn't resolve
      // the defect it's attached to.
      if (suggestedFix && outcome.fixVerified === "failed") {
        console.warn(
          `[reviewRun] dropped suggestedFix for ${m.path}:${m.startLine} — executed against the sandbox repro and did not resolve it`,
        );
        suggestedFix = undefined;
      }

      deliverable.push({
        ...m,
        suggestedFix,
        verificationStatus: outcome.status,
        verificationMethod: outcome.method,
        verifiedHow: outcome.verifiedHow,
        // DESIGN.md §11/§13 zero-retention mode: never persist a verbatim source
        // excerpt, only finding metadata (the line comment itself is still posted
        // to the platform as usual — this only affects what we store ourselves).
        codeSnippet: env().ZERO_RETENTION
          ? null
          : sourceContent
            ? extractCodeSnippet(sourceContent, m.startLine, m.endLine)
            : null,
      });
    }

    await throwIfCancelled(db, runId);
    await markCheckpoint(db, traceKey, "15_after_verify_loop");

    const totalCostUsd = passCostUsd + verifyCostUsd;
    const anthropicCostUsd = passAnthropicCostUsd + verifyAnthropicCostUsd;
    const openaiCostUsd = passOpenaiCostUsd + verifyOpenaiCostUsd;
    const { posted, digest, rejected } = selectForDelivery(
      deliverable,
      repoConfig.commentBudget,
    );

    if (verificationSkipped)
      coverageWarnings.push(
        "Verification skipped for " +
          verificationSkipped +
          " candidate(s) at the cost limit.",
      );
    if (verificationUnavailable)
      coverageWarnings.push(
        "Verification unavailable for " +
          verificationUnavailable +
          " candidate(s); they were not posted.",
      );
    // Persist the point after which a retry must never blindly repeat remote writes.
    const delivery = await db
      .from("review_runs")
      .update({
        delivery_started_at: new Date().toISOString(),
        llm_cost_usd: totalCostUsd,
        anthropic_cost_usd: anthropicCostUsd,
        openai_cost_usd: openaiCostUsd,
      })
      .eq("id", runId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();
    if (delivery.error)
      throw new Error(
        "failed to persist delivery boundary: " + delivery.error.message,
      );
    if (!delivery.data) return;
    await markCheckpoint(db, traceKey, "16_delivery_started");
    const latestPr = await adapter.getPrInfo(pr);
    if (latestPr.headSha !== headSha) {
      await db
        .from("review_runs")
        .update({ status: "cancelled", finished_at: new Date().toISOString() })
        .eq("id", runId)
        .eq("status", "running");
      return;
    }
    const existingComments = await adapter.listOwnComments(pr);
    const summaryBody = buildSummaryMarkdown({
      prStats: ctx.prDiff.stats,
      posted,
      digest,
      rejected,
      skippedPasses,
      coverageWarnings,
      costUsd: totalCostUsd,
      walkthrough: walkthrough.data?.summary,
      diagram: diagram.data?.mermaid,
    });
    const firstComment = existingComments[0];
    if (firstComment) {
      await adapter.updateComment(pr, firstComment.id, summaryBody);
    } else {
      await adapter.postSummary(pr, summaryBody);
    }

    const postedWithCommentIds: {
      finding: DeliverableFinding;
      commentId: string | null;
    }[] = [];
    for (const finding of posted) {
      await throwIfCancelled(db, runId);
      const lineComment: LineComment = {
        path: finding.path,
        line: finding.endLine,
        body: buildLineCommentBody(finding),
        headSha,
      };
      try {
        const commentId = await adapter.postLineComment(pr, lineComment);
        postedWithCommentIds.push({ finding, commentId });
      } catch (err) {
        // One bad line comment (e.g. line no longer in the diff hunk) never fails the whole run.
        console.error(
          `[reviewRun] failed to post line comment for ${finding.path}:${finding.endLine}:`,
          err,
        );
        postedWithCommentIds.push({ finding, commentId: null });
      }
    }

    const findingRows = [
      ...postedWithCommentIds.map(({ finding, commentId }) =>
        toFindingRow(runId!, finding, true, false, commentId),
      ),
      ...digest.map((f) => toFindingRow(runId!, f, false, true, null)),
      ...rejected.map((f) => toFindingRow(runId!, f, false, false, null)),
    ];
    if (findingRows.length > 0) {
      const { error: insertError } = await db
        .from("findings")
        .insert(findingRows);
      if (insertError)
        throw new Error(`failed to persist findings: ${insertError.message}`);
    }

    const completion = await db
      .from("review_runs")
      .update({
        status: "completed",
        error: coverageWarnings.length
          ? `Review incomplete: ${coverageWarnings.join(" ")}`
          : null,
        finished_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAt,
        candidates: merged.length,
        verified: deliverable.filter((f) => f.verificationStatus === "verified")
          .length,
        posted: posted.length,
        digest: digest.length,
        llm_cost_usd: totalCostUsd,
        anthropic_cost_usd: anthropicCostUsd,
        openai_cost_usd: openaiCostUsd,
        summary: summaryBody,
        source_run_id: job.sourceRunId ?? null,
      })
      .eq("id", runId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();

    if (completion.error)
      throw new Error(
        `failed to complete review_run: ${completion.error.message}`,
      );

    // A newer push can cancel this run while platform comments are in flight.
    // Only a run that still owns the running state may publish completion.
    if (!completion.data) return;
    completedHere = true;

    const checkState = computeCheckState(
      deliverable,
      repoConfig.failOnCritical,
      coverageWarnings.length > 0,
    );
    await adapter.setStatus(pr, {
      headSha,
      state: checkState,
      title:
        checkState === "failure"
          ? "Critical issues found"
          : coverageWarnings.length > 0
            ? "Review incomplete"
            : "AI Review",
      summary: summaryBody,
    });

    // Best-effort: dismissal/downvote feedback compiles into rulebook rules once evidence accumulates.
    if (priorFeedback.size > 0) {
      await enqueueRulebookCompile({ orgId, repoId }).catch(() => undefined);
    }

    // Best-effort: notify the org owner that this PR has been reviewed — the one
    // stable recipient regardless of how the run was triggered (webhook, manual,
    // rerun). A missing provider, missing FRONTEND_URL, missing recipient email, or
    // a send failure all just skip this silently; the review itself already shipped.
    if (
      coverageWarnings.length === 0 &&
      emailConfigured() &&
      env().FRONTEND_URL
    ) {
      try {
        const owner = await getOrgOwnerEmail(db, orgId);
        if (owner) {
          const content = reviewCompleteEmail({
            repoName: `${pr.repo.owner}/${pr.repo.name}`,
            prNumber: pr.number,
            prTitle: pr.title ?? `PR #${pr.number}`,
            riskLevel: computeRiskLevel([...posted, ...digest]),
            posted: posted.map((f) => ({
              severity: f.severity,
              title: f.title,
              path: f.path,
              line: f.endLine,
            })),
            digestCount: digest.length,
            runUrl: `${env().FRONTEND_URL!.replace(/\/+$/, "")}/runs/${runId}`,
            prUrl: prWebUrl(pr),
          });
          const result = await sendEmail({ to: owner.email, ...content });
          if (!result.sent)
            console.warn(
              `[reviewRun] review-complete email failed for ${owner.email}: ${result.error}`,
            );
        }
      } catch (err) {
        console.warn("[reviewRun] review-complete email skipped:", err);
      }
    }
  } catch (err) {
    if (err instanceof RunCancelledError) {
      // Status is already "cancelled" (set by the newer run) — nothing more to record, and this is not a failure.
      console.log(`[reviewRun] ${err.message}`);
      return;
    }
    if (runId) {
      const failure = await db
        .from("review_runs")
        .update({
          status: "failed",
          llm_cost_usd: spentUsd,
          anthropic_cost_usd: spentAnthropicUsd,
          openai_cost_usd: spentOpenaiUsd,
          finished_at: new Date().toISOString(),
          latency_ms: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
          ...((err instanceof Error ? err.message : String(err)).includes(
            "monthly_quota_exceeded",
          )
            ? { blocked_reason: "monthly_quota_exceeded" }
            : {}),
        })
        .eq("id", runId)
        .in(
          "status",
          completedHere
            ? ["queued", "running", "completed"]
            : ["queued", "running"],
        )
        .select("id")
        .maybeSingle();
      if (failure.error)
        console.error(
          "[reviewRun] failed to record run failure:",
          failure.error.message,
        );
      else if (!failure.data) return;
    }
    if (knownHeadSha) {
      await adapter
        .setStatus(job.pr, {
          headSha: knownHeadSha,
          state: "failure",
          title: "Review could not complete",
          summary:
            "Scrutinye could not finish this review. Open the run in Scrutinye for details and retry. This is not a clean review result.",
        })
        .catch((statusError) =>
          console.error(
            "[reviewRun] failed to publish failure status:",
            statusError,
          ),
        );
    }
    throw err;
  }
}

function toFindingRow(
  runId: string,
  f: DeliverableFinding,
  posted: boolean,
  inDigest: boolean,
  commentId: string | null,
) {
  return {
    run_id: runId,
    pass: f.passes[0] ?? f.category,
    category: f.category,
    severity: f.severity,
    confidence: f.confidence,
    path: f.path,
    start_line: f.startLine,
    end_line: f.endLine,
    title: f.title,
    body_md: f.explanation,
    why_it_matters: f.whyItMatters,
    impact: f.impact,
    fix_steps: f.fixSteps,
    suggested_fix: f.suggestedFix ?? null,
    code_snippet: f.codeSnippet,
    verification_method: f.verificationMethod,
    verification_status: f.verificationStatus,
    verified_how: f.verifiedHow,
    posted,
    in_digest: inDigest,
    comment_external_id: commentId,
    fingerprint: f.fingerprint,
  };
}
