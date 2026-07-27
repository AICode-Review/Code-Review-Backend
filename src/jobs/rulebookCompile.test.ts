import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeRule {
  id: string;
  org_id: string;
  repo_id: string;
  category: string;
  rule_text: string;
  weight: number;
  active: boolean;
  evidence_count: number;
  source: string;
}

function makeRulesQuery(rules: FakeRule[], filters: Record<string, string> = {}) {
  return {
    eq(col: string, val: string) {
      return makeRulesQuery(rules, { ...filters, [col]: val });
    },
    async maybeSingle() {
      const match = rules.find((r) => Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v));
      return { data: match ?? null, error: null };
    },
  };
}

function makeFakeDb(learningEventRows: unknown[], rules: FakeRule[]) {
  let nextId = rules.length + 1;
  return {
    from(table: string) {
      if (table === "learning_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: learningEventRows, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "rulebook_rules") {
        return {
          select: () => makeRulesQuery(rules),
          update: (patch: Partial<FakeRule>) => ({
            eq: async (_col: string, id: string) => {
              const rule = rules.find((r) => r.id === id);
              if (rule) Object.assign(rule, patch);
              return { data: null, error: null };
            },
          }),
          insert: async (row: Omit<FakeRule, "id">) => {
            rules.push({ id: String(nextId++), ...row } as FakeRule);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

const completeMock = vi.fn();
vi.mock("../db/client.js", () => ({ getDb: () => currentDb }));
vi.mock("../llm/router.js", () => ({ createLlmRouter: () => ({ complete: completeMock }) }));

let currentDb: ReturnType<typeof makeFakeDb>;

const { handleRulebookCompile } = await import("./rulebookCompile.js");

afterEach(() => {
  completeMock.mockReset();
});

function learningEvent(category: string, eventType: "dismissed" | "ignored" = "dismissed") {
  return { event_type: eventType, findings: { category, title: "Some finding", body_md: "explanation" } };
}

describe("handleRulebookCompile", () => {
  it("does nothing when there are no negative (dismissed/ignored) learning events", async () => {
    currentDb = makeFakeDb([{ event_type: "accepted", findings: { category: "style", title: "x", body_md: "y" } }], []);
    await handleRulebookCompile({ orgId: "org-1", repoId: "repo-1" });
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("creates a new rule with evidence_count 1 — NOT the size of the event cluster it came from", async () => {
    completeMock.mockResolvedValueOnce({
      data: { proposals: [{ ruleText: "Don't flag console.log in test files", category: "style" }] },
      costUsd: 0.001,
      inputTokens: 10,
      outputTokens: 5,
      model: "fake",
      provider: "anthropic",
    });
    const rules: FakeRule[] = [];
    // 5 unrelated dismissal events in the same category — previously this alone would
    // have set evidence_count to 5 (the full cluster size) on a brand-new rule.
    currentDb = makeFakeDb(Array.from({ length: 5 }, () => learningEvent("style")), rules);

    await handleRulebookCompile({ orgId: "org-1", repoId: "repo-1" });

    expect(rules).toHaveLength(1);
    expect(rules[0]?.evidence_count).toBe(1);
    expect(rules[0]?.active).toBe(false); // below MIN_EVIDENCE_TO_AUTO_ACTIVATE (2)
  });

  it("only auto-activates once the SAME rule is independently re-proposed across a second, separate compile run", async () => {
    const rules: FakeRule[] = [];
    const proposal = { proposals: [{ ruleText: "Don't flag console.log in test files", category: "style" }] };

    completeMock.mockResolvedValueOnce({ data: proposal, costUsd: 0.001, inputTokens: 10, outputTokens: 5, model: "fake", provider: "anthropic" });
    currentDb = makeFakeDb([learningEvent("style"), learningEvent("style")], rules);
    await handleRulebookCompile({ orgId: "org-1", repoId: "repo-1" });
    expect(rules[0]?.evidence_count).toBe(1);
    expect(rules[0]?.active).toBe(false);

    // A second, later compile run (e.g. triggered by new feedback) independently
    // re-derives the exact same rule.
    completeMock.mockResolvedValueOnce({ data: proposal, costUsd: 0.001, inputTokens: 10, outputTokens: 5, model: "fake", provider: "anthropic" });
    currentDb = makeFakeDb([learningEvent("style"), learningEvent("style"), learningEvent("style")], rules);
    await handleRulebookCompile({ orgId: "org-1", repoId: "repo-1" });

    expect(rules).toHaveLength(1); // same rule updated in place, not duplicated
    expect(rules[0]?.evidence_count).toBe(2);
    expect(rules[0]?.active).toBe(true); // now meets MIN_EVIDENCE_TO_AUTO_ACTIVATE
  });

  it("clusters events by category and sends each cluster to the compiler separately", async () => {
    completeMock.mockResolvedValue({
      data: { proposals: [] },
      costUsd: 0.001,
      inputTokens: 10,
      outputTokens: 5,
      model: "fake",
      provider: "anthropic",
    });
    currentDb = makeFakeDb([learningEvent("style"), learningEvent("security"), learningEvent("style")], []);
    await handleRulebookCompile({ orgId: "org-1", repoId: "repo-1" });
    expect(completeMock).toHaveBeenCalledTimes(2); // one call for "style", one for "security"
  });
});
