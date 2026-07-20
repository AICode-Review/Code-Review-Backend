import { z } from "zod";

/** DESIGN.md §6.3 candidate schema — the JSON every specialist pass must emit. */
export const CandidateSchema = z.object({
  category: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  title: z.string().min(1).max(120),
  explanation: z.string().min(1),
  whyItMatters: z.string().min(1),
  impact: z.string().min(1),
  fixSteps: z.array(z.string()).min(1),
  suggestedFix: z.string().optional(),
  severity: z.enum(["critical", "major", "minor"]),
  confidence: z.number().min(0).max(1),
  needsExecution: z.boolean(),
  evidence: z.array(z.string()),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const PassOutputSchema = z.object({
  candidates: z.array(CandidateSchema),
});
export type PassOutput = z.infer<typeof PassOutputSchema>;

/** §6.5 cross-examination verdict. */
export const CrossExamOutputSchema = z.object({
  verdict: z.enum(["upheld", "refuted", "uncertain"]),
  reasoning: z.string().min(1),
});
export type CrossExamOutput = z.infer<typeof CrossExamOutputSchema>;

/** §6.7 rulebook compiler proposal — one candidate rule per cluster of learning events. */
export const RulebookProposalSchema = z.object({
  ruleText: z.string().min(1).max(400),
  category: z.string().min(1),
});
export type RulebookProposal = z.infer<typeof RulebookProposalSchema>;

export const RulebookCompileOutputSchema = z.object({
  proposals: z.array(RulebookProposalSchema),
});
export type RulebookCompileOutput = z.infer<typeof RulebookCompileOutputSchema>;

/** §6.7 chat-with-reviewer reply. `concedes: true` means the bot agrees the finding was wrong/not applicable — the caller turns that into a learning event automatically. */
export const ChatReplyOutputSchema = z.object({
  answer: z.string().min(1),
  concedes: z.boolean(),
});
export type ChatReplyOutput = z.infer<typeof ChatReplyOutputSchema>;

/**
 * §6.5 step 3 / §7.3 (M6+) — generates a minimal, self-contained repro test
 * for a `needsExecution` finding on a Tier-1 sandbox language. `canGenerate:
 * false` is a valid, expected answer (omit rather than guess) when the
 * defect can't be reproduced without external state/services/config the
 * model wasn't given.
 */
export const ReproGenOutputSchema = z.object({
  canGenerate: z.boolean(),
  language: z.enum(["node", "python", "jvm"]).optional(),
  /** Self-contained test file content — must run standalone with no network/external deps beyond the language's stdlib. */
  testCode: z.string().optional(),
});
export type ReproGenOutput = z.infer<typeof ReproGenOutputSchema>;
