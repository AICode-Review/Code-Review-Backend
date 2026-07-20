import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "../adapters/index.js";
import { getDb } from "../db/client.js";
import { getFindingByCommentExternalId } from "../db/repositories.js";
import { createLlmRouter } from "../llm/router.js";
import { ChatReplyOutputSchema } from "../engine/schemas.js";
import { enqueueRulebookCompile, type ChatReplyJob } from "../queue/index.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../engine/prompts/chat_reply.v1.md");
let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

function buildFindingContextBlock(finding: NonNullable<Awaited<ReturnType<typeof getFindingByCommentExternalId>>>): string {
  return [
    `## Finding being discussed`,
    `**${finding.title}** (${finding.severity}, ${finding.category}) — \`${finding.path}:${finding.startLine}-${finding.endLine}\``,
    "",
    finding.bodyMd,
    "",
    `Why it matters: ${finding.whyItMatters}`,
    `If ignored: ${finding.impact}`,
    ...(finding.codeSnippet ? ["", "```", finding.codeSnippet, "```"] : []),
    ...(finding.suggestedFix ? ["", "Suggested fix:", "```suggestion", finding.suggestedFix, "```"] : []),
  ].join("\n");
}

/**
 * DESIGN.md §6.7 — "Chat: replies mentioning the bot get a contextual answer
 * (thread + finding + file). If the bot concedes, it auto-creates a learning
 * event." Runs as a queued job (never inline in the webhook handler, per
 * DESIGN.md §9) so a slow LLM call never blocks the webhook response.
 */
export async function handleChatReply(job: ChatReplyJob): Promise<void> {
  const db = getDb();
  const adapter = getAdapter(job.pr.repo.platform);
  const router = createLlmRouter();

  const finding = await getFindingByCommentExternalId(db, job.commentId);
  if (job.requireFinding && !finding) {
    // Reply landed in a thread we don't own (or the parent comment was never
    // linked to a finding) — stay out of a conversation we weren't part of.
    return;
  }

  const system = await loadPrompt();
  const contextBlock = finding
    ? buildFindingContextBlock(finding)
    : "## Context\nNo specific finding is linked to this comment — this is a general question in the PR's conversation.";

  const result = await router.complete({
    task: "chat.reply",
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${contextBlock}\n\n## Developer's reply\n${job.body}` },
    ],
    schema: ChatReplyOutputSchema,
    maxTokens: 1024,
  });
  if (!result.data) return; // dropped after schema validation failed twice — never post a broken reply

  if (finding) {
    await adapter.postReply(job.pr, job.commentId, result.data.answer);
  } else {
    await adapter.postSummary(job.pr, result.data.answer);
  }

  if (finding && result.data.concedes) {
    // Same signal as a manual "dismissed" from the web app — feeds the same
    // rulebook-compiler pipeline (jobs/rulebookCompile.ts filters on this
    // event_type), so a conceded finding actually tunes future reviews.
    if (!finding.feedback) {
      await db.from("findings").update({ feedback: "dismissed" }).eq("id", finding.findingId);
    }
    await db.from("learning_events").insert({
      org_id: finding.orgId,
      repo_id: finding.repoId,
      finding_id: finding.findingId,
      event_type: "dismissed",
      comment_text: `Conceded in reply thread — developer: "${job.body}" — bot: "${result.data.answer}"`,
    });
    await enqueueRulebookCompile({ orgId: finding.orgId, repoId: finding.repoId }).catch(() => undefined);
  }
}
