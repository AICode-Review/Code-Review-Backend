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
import { assembleContext } from "../engine/contextAssembly.js";
import { runAllPasses } from "../engine/passRunner.js";
import { mergeAndScore, suppressPreviouslyDismissed, type PassCandidates, type RulebookBoost } from "../engine/merge.js";
import { matchesIgnoredPath } from "../engine/ignorePaths.js";
import { extractCodeSnippet } from "../engine/snippet.js";
import { validateSuggestedFix } from "../engine/suggestedFix.js";
import { verifyFinding } from "../verify/index.js";
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

function buildRulebookBoost(rules: { category: string; weight: number }[]): RulebookBoost {
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

/** DESIGN.md §6.1: bail out (no wasted LLM spend, no stale post) if a newer push has cancelled this run. */
async function throwIfCancelled(db: ReturnType<typeof getDb>, runId: string): Promise<void> {
  const status = await getRunStatus(db, runId);
  if (status === "cancelled") throw new RunCancelledError(`review_run ${runId} was cancelled — a newer push superseded it`);
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
export async function handleReviewRun(job: ReviewRunJob, deps?: Partial<ReviewRunDeps>): Promise<void> {
  const startedAt = Date.now();
  const db = deps?.db ?? getDb();
  const adapter = deps?.adapter ?? getAdapter(job.pr.repo.platform);
  const router = deps?.router ?? createLlmRouter();

  // Always fetch authoritative PR info — webhook `command` events arrive with
  // no head sha, and REST-triggered runs need base sha for the diff too.
  const prInfo = await adapter.getPrInfo(job.pr);
  const headSha = prInfo.headSha;
  const pr = { ...job.pr, title: prInfo.title, author: prInfo.author };

  const { orgId, repoId, prId } = await upsertPrChain(db, pr, headSha);

  // Platform-admin suspend kill-switch — blocks all reviews for the org (webhook + manual + rerun).
  const { getOrgSuspension } = await import("../db/adminRepositories.js");
  const suspension = await getOrgSuspension(db, orgId);
  if (suspension.suspended) {
    const message = suspension.suspendedReason
      ? `This organization is suspended: ${suspension.suspendedReason}`
      : "This organization is suspended. Contact support.";
    await recordAudit(db, orgId, "system", "review.blocked_by_suspend", repoId, {
      reason: "org_suspended",
      suspendedReason: suspension.suspendedReason,
    });
    if (job.runId) {
      await db
        .from("review_runs")
        .update({ status: "failed", error: message, blocked_reason: "org_suspended", finished_at: new Date().toISOString() })
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
  if (!(await canReviewRepo(db, orgId, repoIsPrivate))) {
    const message = "This repo is private, which requires a Pro or Team plan. Upgrade in Settings to enable reviews on it.";
    await recordAudit(db, orgId, "system", "review.blocked_by_plan", repoId, { reason: "private_repo_free_plan" });
    if (job.runId) {
      await db
        .from("review_runs")
        .update({ status: "failed", error: message, blocked_reason: "private_repo_free_plan", finished_at: new Date().toISOString() })
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
  const usage = await getOrgUsage(db, orgId);
  if (usage.blocked) {
    const message = formatUsageLimitMessage(usage);
    await recordAudit(db, orgId, "system", "review.blocked_by_quota", repoId, {
      reason: "monthly_quota_exceeded",
      used: usage.used,
      quota: usage.quota,
    });
    if (job.runId) {
      await db
        .from("review_runs")
        .update({ status: "failed", error: message, blocked_reason: "monthly_quota_exceeded", finished_at: new Date().toISOString() })
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

  let runId = job.runId;
  if (runId) {
    await db.from("review_runs").update({ status: "running", head_sha: headSha }).eq("id", runId);
  } else {
    const { data: run, error } = await db
      .from("review_runs")
      .insert({ pr_id: prId, head_sha: headSha, status: "running", trigger: "automatic" })
      .select("id")
      .single();
    if (error || !run) throw new Error(`failed to create review_run: ${error?.message ?? "no row"}`);
    runId = run.id as string;
  }

  try {
    const [repoConfig, rulebookRules, priorFeedback] = await Promise.all([
      getRepoConfig(db, repoId),
      getActiveRulebookRules(db, orgId, repoId),
      getPriorFindingFeedback(db, prId, runId),
    ]);

    const ctx = await assembleContext(adapter, pr, prInfo.baseSha, headSha, { db, repoId });
    ctx.files = ctx.files.filter((f) => !matchesIgnoredPath(f.path, repoConfig.ignoredPaths));
    ctx.prDiff = {
      ...ctx.prDiff,
      files: ctx.prDiff.files.filter((f) => !matchesIgnoredPath(f.path, repoConfig.ignoredPaths)),
    };

    await throwIfCancelled(db, runId);

    const costCap = env().RUN_COST_CAP_USD;
    const {
      results,
      totalCostUsd: passCostUsd,
      anthropicCostUsd: passAnthropicCostUsd,
      skippedPasses,
    } = await runAllPasses(router, ctx, {
      rulebook: rulebookRules,
      costCapUsd: costCap,
    });

    const candidatesByPass: PassCandidates[] = results.map((r) => ({ pass: r.pass, candidates: r.candidates }));
    const rulebookBoost = buildRulebookBoost(rulebookRules);
    const merged = suppressPreviouslyDismissed(mergeAndScore(candidatesByPass, rulebookBoost), priorFeedback);

    await throwIfCancelled(db, runId);

    const filesByPath = new Map(ctx.files.map((f) => [f.path, f.content]));
    const deliverable: DeliverableFinding[] = [];
    let verifyCostUsd = 0;
    let verifyAnthropicCostUsd = 0;
    let verifyOpenaiCostUsd = 0;

    for (const m of merged) {
      if (passCostUsd + verifyCostUsd >= costCap) {
        // Cost cap reached — remaining candidates are dropped from this run entirely (never posted unverified).
        continue;
      }
      const outcome = await verifyFinding(router, m, filesByPath);
      verifyCostUsd += outcome.costUsd;
      verifyAnthropicCostUsd += outcome.anthropicCostUsd;
      verifyOpenaiCostUsd += outcome.openaiCostUsd;
      const sourceContent = filesByPath.get(m.path);

      // suggestedFix never goes through verify/ (it's not the finding, it's a proposed
      // edit), so nothing else catches a hallucinated/no-op/placeholder "fix" before a
      // developer one-click-applies it. Sanity-check against the exact cited range and
      // drop the field (never the finding) rather than ship a bad suggestion.
      let suggestedFix = m.suggestedFix;
      if (suggestedFix) {
        const exactOriginal = sourceContent ? extractCodeSnippet(sourceContent, m.startLine, m.endLine, 0) : null;
        const check = exactOriginal ? validateSuggestedFix(suggestedFix, exactOriginal) : { valid: false, reason: "original lines unavailable" };
        if (!check.valid) {
          console.warn(`[reviewRun] dropped suggestedFix for ${m.path}:${m.startLine} — ${check.reason}`);
          suggestedFix = undefined;
        }
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
        codeSnippet: env().ZERO_RETENTION ? null : sourceContent ? extractCodeSnippet(sourceContent, m.startLine, m.endLine) : null,
      });
    }

    await throwIfCancelled(db, runId);

    const totalCostUsd = passCostUsd + verifyCostUsd;
    const anthropicCostUsd = passAnthropicCostUsd + verifyAnthropicCostUsd;
    const openaiCostUsd = verifyOpenaiCostUsd;
    const { posted, digest, rejected } = selectForDelivery(deliverable, repoConfig.commentBudget);

    const existingComments = await adapter.listOwnComments(pr);
    const summaryBody = buildSummaryMarkdown({
      prStats: ctx.prDiff.stats,
      posted,
      digest,
      rejected,
      skippedPasses,
      costUsd: totalCostUsd,
    });
    const firstComment = existingComments[0];
    if (firstComment) {
      await adapter.updateComment(pr, firstComment.id, summaryBody);
    } else {
      await adapter.postSummary(pr, summaryBody);
    }

    const postedWithCommentIds: { finding: DeliverableFinding; commentId: string | null }[] = [];
    for (const finding of posted) {
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
        console.error(`[reviewRun] failed to post line comment for ${finding.path}:${finding.endLine}:`, err);
        postedWithCommentIds.push({ finding, commentId: null });
      }
    }

    const checkState = computeCheckState(deliverable, repoConfig.failOnCritical);
    await adapter.setStatus(pr, {
      headSha,
      state: checkState,
      title: checkState === "failure" ? "Critical issues found" : "AI Review",
      summary: summaryBody,
    });

    const findingRows = [
      ...postedWithCommentIds.map(({ finding, commentId }) => toFindingRow(runId!, finding, true, false, commentId)),
      ...digest.map((f) => toFindingRow(runId!, f, false, true, null)),
      ...rejected.map((f) => toFindingRow(runId!, f, false, false, null)),
    ];
    if (findingRows.length > 0) {
      const { error: insertError } = await db.from("findings").insert(findingRows);
      if (insertError) console.error("[reviewRun] failed to insert findings:", insertError.message);
    }

    await db
      .from("review_runs")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAt,
        candidates: merged.length,
        verified: deliverable.filter((f) => f.verificationStatus === "verified").length,
        posted: posted.length,
        digest: digest.length,
        llm_cost_usd: totalCostUsd,
        anthropic_cost_usd: anthropicCostUsd,
        openai_cost_usd: openaiCostUsd,
        summary: summaryBody,
        source_run_id: job.sourceRunId ?? null,
      })
      .eq("id", runId);

    // Best-effort: dismissal/downvote feedback compiles into rulebook rules once evidence accumulates.
    if (priorFeedback.size > 0) {
      await enqueueRulebookCompile({ orgId, repoId }).catch(() => undefined);
    }

    // Best-effort: notify the org owner that this PR has been reviewed — the one
    // stable recipient regardless of how the run was triggered (webhook, manual,
    // rerun). A missing provider, missing FRONTEND_URL, missing recipient email, or
    // a send failure all just skip this silently; the review itself already shipped.
    if (emailConfigured() && env().FRONTEND_URL) {
      try {
        const owner = await getOrgOwnerEmail(db, orgId);
        if (owner) {
          const content = reviewCompleteEmail({
            repoName: `${pr.repo.owner}/${pr.repo.name}`,
            prNumber: pr.number,
            prTitle: pr.title ?? `PR #${pr.number}`,
            riskLevel: computeRiskLevel(posted),
            posted: posted.map((f) => ({ severity: f.severity, title: f.title, path: f.path, line: f.endLine })),
            digestCount: digest.length,
            runUrl: `${env().FRONTEND_URL!.replace(/\/+$/, "")}/runs/${runId}`,
            prUrl: prWebUrl(pr),
          });
          const result = await sendEmail({ to: owner.email, ...content });
          if (!result.sent) console.warn(`[reviewRun] review-complete email failed for ${owner.email}: ${result.error}`);
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
    await db
      .from("review_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      })
      .eq("id", runId);
    throw err;
  }
}

function toFindingRow(runId: string, f: DeliverableFinding, posted: boolean, inDigest: boolean, commentId: string | null) {
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
