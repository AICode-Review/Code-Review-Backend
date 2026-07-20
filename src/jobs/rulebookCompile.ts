import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/client.js";
import { createLlmRouter } from "../llm/router.js";
import { RulebookCompileOutputSchema } from "../engine/schemas.js";
import type { RulebookCompileJob } from "../queue/index.js";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../engine/prompts/rulebook_compile.v1.md");
let cachedPrompt: string | undefined;
async function loadPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(promptPath, "utf8");
  return cachedPrompt;
}

/** Single-event learned rules stay pending; DESIGN.md §6.7 auto-activates at 2+ evidence events. */
const MIN_EVIDENCE_TO_AUTO_ACTIVATE = 2;
const MAX_EVENTS_PER_CLUSTER = 8;

interface LearningEventRow {
  event_type: string;
  findings: { category: string; title: string; body_md: string } | null;
}

/** DESIGN.md §6.7 — clusters recent dismissal/downvote events into plain-language rulebook rules. */
export async function handleRulebookCompile(job: RulebookCompileJob): Promise<void> {
  const db = getDb();
  const router = createLlmRouter();

  const { data: events, error } = await db
    .from("learning_events")
    .select("event_type, created_at, findings(category, title, body_md)")
    .eq("org_id", job.orgId)
    .eq("repo_id", job.repoId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`db: failed to load learning_events: ${error.message}`);

  const negative = ((events ?? []) as unknown as LearningEventRow[]).filter(
    (e) => e.event_type === "dismissed" || e.event_type === "ignored",
  );
  if (negative.length === 0) return;

  const byCategory = new Map<string, LearningEventRow[]>();
  for (const e of negative) {
    const category = e.findings?.category ?? "style";
    const bucket = byCategory.get(category) ?? [];
    bucket.push(e);
    byCategory.set(category, bucket);
  }

  const system = await loadPrompt();

  for (const [category, clusterEvents] of byCategory) {
    const sample = clusterEvents.slice(0, MAX_EVENTS_PER_CLUSTER);
    const user = sample
      .map((e, i) => `${i + 1}. [${e.event_type}] ${e.findings?.title ?? "(unknown finding)"} — ${e.findings?.body_md ?? ""}`)
      .join("\n");

    const result = await router.complete({
      task: "rulebook.compile",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `## Category: ${category}\n\n## Events\n${user}` },
      ],
      schema: RulebookCompileOutputSchema,
      maxTokens: 512,
    });
    if (!result.data) continue;

    for (const proposal of result.data.proposals) {
      const { data: existing } = await db
        .from("rulebook_rules")
        .select("id, evidence_count")
        .eq("org_id", job.orgId)
        .eq("repo_id", job.repoId)
        .eq("category", proposal.category)
        .eq("rule_text", proposal.ruleText)
        .maybeSingle();

      if (existing) {
        const evidenceCount = (existing.evidence_count as number) + clusterEvents.length;
        await db
          .from("rulebook_rules")
          .update({ evidence_count: evidenceCount, active: evidenceCount >= MIN_EVIDENCE_TO_AUTO_ACTIVATE })
          .eq("id", existing.id);
      } else {
        const evidenceCount = clusterEvents.length;
        await db.from("rulebook_rules").insert({
          org_id: job.orgId,
          repo_id: job.repoId,
          source: "learned",
          rule_text: proposal.ruleText,
          category: proposal.category,
          weight: 1,
          active: evidenceCount >= MIN_EVIDENCE_TO_AUTO_ACTIVATE,
          evidence_count: evidenceCount,
        });
      }
    }
  }
}
