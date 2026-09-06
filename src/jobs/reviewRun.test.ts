import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../adapters/types.js";
import { createFakeRouter } from "../llm/fakeRouter.js";
import { createFakeSupabase } from "../testUtils/fakeSupabase.js";
import { upsertPrChain } from "../db/repositories.js";
import * as verifyIndex from "../verify/index.js";
import { scanDependencies } from "../engine/dependencyScan.js";
import type { ReviewRunJob } from "../queue/index.js";
import { handleReviewRun } from "./reviewRun.js";

// getContext() (indexer/context.ts) would otherwise attempt a real OpenAI embeddings call
// whenever the diff produces a similarity query text — this repo's .env has a real key
// loaded via config.ts's `import "dotenv/config"`. Keep these orchestrator tests offline.
vi.mock("../indexer/embeddings.js", () => ({
  embedTexts: vi.fn(async () => ({ vectors: [], costUsd: 0 })),
}));

// Real scanDependencies() would hit the live osv.dev API — default every test to "no
// vulnerabilities found" (the real, correct answer for every fixture diff below, none of
// which touch a manifest file) and let one dedicated test below override this per-call to
// prove the wiring, without any test depending on real network access.
vi.mock("../engine/dependencyScan.js", () => ({
  scanDependencies: vi.fn(async () => []),
  DEPENDENCY_SCAN_PASS: "dependency-scan",
}));


const sendMailMock = vi.fn();
const createTransportMock = vi.fn((_options: unknown) => ({ sendMail: sendMailMock }));
vi.mock("nodemailer", () => ({
  default: { createTransport: (options: unknown) => createTransportMock(options) },
}));


const NEW_FILE = "export function login(req) {\n  const token = req.headers.authorization;\n  return token;\n}\n";

const DIFF_TEXT = `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,4 @@
 export function login(req) {
+  const token = req.headers.authorization;
   return token;
 }
`;

const SECURITY_CANDIDATE = {
  category: "security",
  path: "src/auth.ts",
  startLine: 2,
  endLine: 2,
  title: "Authorization header used without validation",
  explanation: "The raw authorization header is read directly with no format or presence check.",
  whyItMatters: "An attacker can send a malformed or empty header and reach downstream logic unauthenticated.",
  impact: "Potential auth bypass.",
  fixSteps: ["Validate the header exists and matches the expected scheme before using it."],
  severity: "critical" as const,
  confidence: 0.9,
  needsExecution: false,
  evidence: ["const token = req.headers.authorization;"],
};

function fakeAdapter(calls: { postSummary: number; postLineComment: number; setStatus: number }): PlatformAdapter {
  return {
    getPrInfo: async () => ({ headSha: "head-sha", title: "Add login", author: "octocat", baseSha: "base-sha" }),
    getDiff: async () => DIFF_TEXT,
    getFile: async () => NEW_FILE,
    listOwnComments: async () => [],
    updateComment: async () => {
      throw new Error("should not update — no existing comment");
    },
    postSummary: async () => {
      calls.postSummary++;
      return "comment-1";
    },
    postLineComment: async () => {
      calls.postLineComment++;
      return "comment-2";
    },
    setStatus: async () => {
      calls.setStatus++;
    },
  } as unknown as PlatformAdapter;
}

function job(): ReviewRunJob {
  return {
    pr: {
      repo: {
        platform: "github",
        externalId: "repo-1",
        owner: "acme",
        name: "widgets",
        orgExternalId: "org-1",
        orgName: "Acme",
        isPrivate: false,
      },
      number: 42,
    },
    headSha: "head-sha",
    reason: "pr_opened",
  };
}

describe("handleReviewRun (orchestrator)", () => {
  it("includes the AI-generated walkthrough in the posted summary comment", async () => {
    const { client: db } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.walkthrough": { summary: "Reads the authorization header directly without validating it." },
    });
    let summaryBody = "";
    const adapter: PlatformAdapter = {
      getPrInfo: async () => ({ headSha: "head-sha", title: "Add login", author: "octocat", baseSha: "base-sha" }),
      getDiff: async () => DIFF_TEXT,
      getFile: async () => NEW_FILE,
      listOwnComments: async () => [],
      updateComment: async () => {
        throw new Error("should not update — no existing comment");
      },
      postSummary: async (_pr: unknown, body: string) => {
        summaryBody = body;
        return "comment-1";
      },
      postLineComment: async () => "comment-2",
      setStatus: async () => {},
    } as unknown as PlatformAdapter;

    await handleReviewRun(job(), { db, adapter, router });

    expect(summaryBody).toContain("Reads the authorization header directly without validating it.");
    // Appears before the risk line, matching delivery.ts's ordering.
    expect(summaryBody.indexOf("Reads the authorization header")).toBeLessThan(summaryBody.indexOf("Risk:"));
  });

  it("omits the walkthrough section when the model's response fails schema validation, without failing the run", async () => {
    const { client: db, tables } = createFakeSupabase();
    const router = createFakeRouter({}); // no pass.walkthrough configured — fails validation, data: null
    let summaryBody = "";
    const adapter: PlatformAdapter = {
      getPrInfo: async () => ({ headSha: "head-sha", title: "Add login", author: "octocat", baseSha: "base-sha" }),
      getDiff: async () => DIFF_TEXT,
      getFile: async () => NEW_FILE,
      listOwnComments: async () => [],
      updateComment: async () => {
        throw new Error("should not update — no existing comment");
      },
      postSummary: async (_pr: unknown, body: string) => {
        summaryBody = body;
        return "comment-1";
      },
      postLineComment: async () => "comment-2",
      setStatus: async () => {},
    } as unknown as PlatformAdapter;

    await handleReviewRun(job(), { db, adapter, router });

    expect(tables["review_runs"]?.[0]?.["status"]).toBe("completed");
    expect(summaryBody).toMatch(/### 🤖 AI Review\n\n\*\*Risk:/);
  });

  it("includes the AI-generated Mermaid diagram for a GitHub PR", async () => {
    const { client: db } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.diagram": { mermaid: "flowchart TD\n  A[auth.ts] -->|modifies| B[login()]" },
    });
    let summaryBody = "";
    const adapter: PlatformAdapter = {
      getPrInfo: async () => ({ headSha: "head-sha", title: "Add login", author: "octocat", baseSha: "base-sha" }),
      getDiff: async () => DIFF_TEXT,
      getFile: async () => NEW_FILE,
      listOwnComments: async () => [],
      updateComment: async () => {
        throw new Error("should not update — no existing comment");
      },
      postSummary: async (_pr: unknown, body: string) => {
        summaryBody = body;
        return "comment-1";
      },
      postLineComment: async () => "comment-2",
      setStatus: async () => {},
    } as unknown as PlatformAdapter;

    await handleReviewRun(job(), { db, adapter, router });

    expect(summaryBody).toContain("```mermaid");
    expect(summaryBody).toContain("A[auth.ts] -->|modifies| B[login()]");
  });

  it("never generates or shows a diagram for a Bitbucket PR", async () => {
    const { client: db } = createFakeSupabase();
    // pass.diagram IS configured — if the diagram were (wrongly) generated for Bitbucket,
    // this would prove it by appearing in the summary. It must not.
    const router = createFakeRouter({
      "pass.diagram": { mermaid: "flowchart TD\n  A[auth.ts] -->|modifies| B[login()]" },
    });
    let summaryBody = "";
    const adapter: PlatformAdapter = {
      getPrInfo: async () => ({ headSha: "head-sha", title: "Add login", author: "octocat", baseSha: "base-sha" }),
      getDiff: async () => DIFF_TEXT,
      getFile: async () => NEW_FILE,
      listOwnComments: async () => [],
      updateComment: async () => {
        throw new Error("should not update — no existing comment");
      },
      postSummary: async (_pr: unknown, body: string) => {
        summaryBody = body;
        return "comment-1";
      },
      postLineComment: async () => "comment-2",
      setStatus: async () => {},
    } as unknown as PlatformAdapter;

    const bitbucketJob = { ...job(), pr: { ...job().pr, repo: { ...job().pr.repo, platform: "bitbucket" as const } } };
    await handleReviewRun(bitbucketJob, { db, adapter, router });

    expect(summaryBody).not.toContain("Change diagram");
    expect(summaryBody).not.toContain("```mermaid");
  });

  it("runs the full pipeline for a public repo: passes -> verify -> deliver -> completed run row", async () => {
    const { client: db, tables } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.security": { candidates: [SECURITY_CANDIDATE] },
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed: header is used unvalidated at that line." },
    });
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter = fakeAdapter(calls);

    await handleReviewRun(job(), { db, adapter, router });

    expect(calls.postSummary).toBe(1);
    expect(calls.postLineComment).toBe(1);
    expect(calls.setStatus).toBe(1);

    const runs = tables["review_runs"] ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.["status"]).toBe("completed");
    expect(runs[0]?.["posted"]).toBe(1);
    expect(runs[0]?.["verified"]).toBe(1);
    expect(runs[0]?.["candidates"]).toBe(1);

    const findings = tables["findings"] ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.["verification_status"]).toBe("verified");
    expect(findings[0]?.["posted"]).toBe(true);

    // repo/org/pull_request rows were materialized along the way
    expect(tables["repos"]).toHaveLength(1);
    expect(tables["orgs"]).toHaveLength(1);
    expect(tables["pull_requests"]).toHaveLength(1);
  });

  it("never runs a review for a private repo on the free plan — no LLM calls, no comments posted", async () => {
    const { client: db, tables } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.security": { candidates: [SECURITY_CANDIDATE] },
      "verify.cross_exam": { verdict: "upheld", reasoning: "x" },
    });
    const completeSpy = vi.spyOn(router, "complete");
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter = fakeAdapter(calls);

    const privateJob = job();
    privateJob.pr.repo.isPrivate = true;

    await handleReviewRun(privateJob, { db, adapter, router });

    expect(completeSpy).not.toHaveBeenCalled();
    expect(calls.postSummary).toBe(0);
    expect(calls.postLineComment).toBe(0);
    expect(calls.setStatus).toBe(0);

    const runs = tables["review_runs"] ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.["status"]).toBe("failed");
    expect(runs[0]?.["error"]).toMatch(/private/i);

    const auditRows = tables["audit_log"] ?? [];
    expect(auditRows.some((r) => r["action"] === "review.blocked_by_plan")).toBe(true);
  });

  it("never runs a review once the org's monthly review quota is exhausted", async () => {
    process.env["FREE_MONTHLY_REVIEW_QUOTA"] = "1";
    vi.resetModules(); // config.ts memoizes env() at module scope — force a fresh read for this test.
    try {
      const { handleReviewRun: freshHandleReviewRun } = await import("./reviewRun.js");
      const { createFakeSupabase: freshCreateFakeSupabase } = await import("../testUtils/fakeSupabase.js");
      const { createFakeRouter: freshCreateFakeRouter } = await import("../llm/fakeRouter.js");

      const { client: db, tables } = freshCreateFakeSupabase();
      const router = freshCreateFakeRouter({
        "pass.security": { candidates: [SECURITY_CANDIDATE] },
        "verify.cross_exam": { verdict: "upheld", reasoning: "x" },
      });
      const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
      const adapter = fakeAdapter(calls);

      // First run consumes the org's only monthly review (quota forced to 1 above).
      await freshHandleReviewRun(job(), { db, adapter, router });
      expect(tables["review_runs"]).toHaveLength(1);
      expect(tables["review_runs"]?.[0]?.["status"]).toBe("completed");

      // A second run (e.g. a new push) is blocked before any LLM call.
      const completeSpy = vi.spyOn(router, "complete");
      await freshHandleReviewRun(job(), { db, adapter, router });

      expect(completeSpy).not.toHaveBeenCalled();
      const runs = tables["review_runs"] ?? [];
      expect(runs).toHaveLength(2);
      expect(runs[1]?.["status"]).toBe("failed");
      expect(runs[1]?.["blocked_reason"]).toBe("monthly_quota_exceeded");
      expect(String(runs[1]?.["error"])).toMatch(/monthly review limit/i);

      const auditRows = tables["audit_log"] ?? [];
      expect(auditRows.some((r) => r["action"] === "review.blocked_by_quota")).toBe(true);
    } finally {
      delete process.env["FREE_MONTHLY_REVIEW_QUOTA"];
      vi.resetModules();
    }
  });

  it("drops a candidate whose evidence cannot be found in the file — never posted, marked rejected", async () => {
    const { client: db, tables } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.security": {
        candidates: [{ ...SECURITY_CANDIDATE, evidence: ["this text does not appear anywhere in the file"] }],
      },
      "verify.cross_exam": { verdict: "upheld", reasoning: "x" },
    });
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter = fakeAdapter(calls);

    await handleReviewRun(job(), { db, adapter, router });

    expect(calls.postLineComment).toBe(0);
    const findings = tables["findings"] ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.["verification_status"]).toBe("rejected");
    expect(findings[0]?.["posted"]).toBe(false);
  });

  it("drops a placeholder suggestedFix but still posts the finding it was attached to", async () => {
    const { client: db, tables } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.security": {
        candidates: [{ ...SECURITY_CANDIDATE, suggestedFix: "// TODO: validate the header properly" }],
      },
      "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed: header is used unvalidated at that line." },
    });
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter = fakeAdapter(calls);

    await handleReviewRun(job(), { db, adapter, router });

    expect(calls.postLineComment).toBe(1); // the finding itself is real and still ships
    const findings = tables["findings"] ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.["verification_status"]).toBe("verified");
    expect(findings[0]?.["suggested_fix"]).toBeNull(); // but the bad "fix" never reaches a developer
  });

  it("catches a hardcoded secret via the deterministic scan even when no LLM pass flags it", async () => {
    const secretDiff = `diff --git a/src/config.ts b/src/config.ts
index 111..222 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,1 +1,2 @@
 export const region = "us-east-1";
+export const awsKey = "AKIAABCDEFGHIJKLMNOP";
`;
    const secretFile = 'export const region = "us-east-1";\nexport const awsKey = "AKIAABCDEFGHIJKLMNOP";\n';

    const { client: db, tables } = createFakeSupabase();
    // No pass configured to return anything (every LLM pass yields zero candidates) — proves
    // this finding comes purely from engine/secretsScan.ts, not from the LLM noticing it.
    const router = createFakeRouter({});
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter: PlatformAdapter = {
      getPrInfo: async () => ({ headSha: "head-sha", title: "Add region config", author: "octocat", baseSha: "base-sha" }),
      getDiff: async () => secretDiff,
      getFile: async () => secretFile,
      listOwnComments: async () => [],
      updateComment: async () => {
        throw new Error("should not update — no existing comment");
      },
      postSummary: async () => {
        calls.postSummary++;
        return "comment-1";
      },
      postLineComment: async () => {
        calls.postLineComment++;
        return "comment-2";
      },
      setStatus: async () => {
        calls.setStatus++;
      },
    } as unknown as PlatformAdapter;

    await handleReviewRun(job(), { db, adapter, router });

    expect(calls.postLineComment).toBe(1);
    const findings = tables["findings"] ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.["verification_status"]).toBe("verified");
    expect(findings[0]?.["verification_method"]).toBe("static");
    expect(findings[0]?.["posted"]).toBe(true);
    expect(findings[0]?.["category"]).toBe("security");
  });

  it("catches a vulnerable dependency bump via the OSV scan even when no LLM pass flags it", async () => {
    const depDiff = `diff --git a/package.json b/package.json
index 111..222 100644
--- a/package.json
+++ b/package.json
@@ -1,1 +1,2 @@
 { "name": "widgets",
+  "lodash": "4.17.20",
`;
    const depFile = '{ "name": "widgets",\n  "lodash": "4.17.20",\n}\n';

    vi.mocked(scanDependencies).mockResolvedValueOnce([
      {
        category: "security",
        path: "package.json",
        startLine: 2,
        endLine: 2,
        title: 'lodash@4.17.20 has a published vulnerability (GHSA-test-1234)',
        explanation: "npm package \"lodash\" is being pinned to a version OSV.dev lists as vulnerable.",
        whyItMatters: "Shipping this version means the vulnerability is present the moment this PR merges.",
        impact: "Treat as exploitable until confirmed otherwise.",
        fixSteps: ["Bump to a patched version."],
        severity: "critical",
        confidence: 0.9,
        needsExecution: false,
        evidence: ['"lodash": "4.17.20",'],
      },
    ]);

    const { client: db, tables } = createFakeSupabase();
    // No pass configured to return anything — proves this finding comes purely from
    // engine/dependencyScan.ts (mocked above), not from any LLM pass noticing it.
    const router = createFakeRouter({});
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter: PlatformAdapter = {
      getPrInfo: async () => ({ headSha: "head-sha", title: "Bump lodash", author: "octocat", baseSha: "base-sha" }),
      getDiff: async () => depDiff,
      getFile: async () => depFile,
      listOwnComments: async () => [],
      updateComment: async () => {
        throw new Error("should not update — no existing comment");
      },
      postSummary: async () => {
        calls.postSummary++;
        return "comment-1";
      },
      postLineComment: async () => {
        calls.postLineComment++;
        return "comment-2";
      },
      setStatus: async () => {
        calls.setStatus++;
      },
    } as unknown as PlatformAdapter;

    await handleReviewRun(job(), { db, adapter, router });

    expect(calls.postLineComment).toBe(1);
    const findings = tables["findings"] ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.["verification_status"]).toBe("verified");
    expect(findings[0]?.["verification_method"]).toBe("static");
    expect(findings[0]?.["posted"]).toBe(true);
    expect(findings[0]?.["category"]).toBe("security");
  });

  it("emails the org owner a detailed review-complete summary once SMTP + FRONTEND_URL are configured", async () => {
    process.env["SMTP_HOST"] = "smtp.example.com";
    process.env["SMTP_USER"] = "user@example.com";
    process.env["SMTP_PASS"] = "secret";
    process.env["FRONTEND_URL"] = "https://app.codeferret.dev";
    vi.resetModules(); // config.ts memoizes env() at module scope — force a fresh read for this test.
    sendMailMock.mockReset();
    createTransportMock.mockClear();
    sendMailMock.mockResolvedValue({});
    try {
      const { handleReviewRun: freshHandleReviewRun } = await import("./reviewRun.js");
      const { createFakeSupabase: freshCreateFakeSupabase } = await import("../testUtils/fakeSupabase.js");
      const { createFakeRouter: freshCreateFakeRouter } = await import("../llm/fakeRouter.js");
      const { upsertPrChain: freshUpsertPrChain } = await import("../db/repositories.js");

      const { client: db, tables } = freshCreateFakeSupabase();

      // Materialize org/repo/pr up front (same idempotent upsert handleReviewRun itself
      // does — matches on external_id, so this is a no-op duplicate, not a second row)
      // so the owner can be seeded against a real orgId before the run happens.
      const testJob = job();
      const { orgId } = await freshUpsertPrChain(db, testJob.pr, testJob.headSha);
      tables["users"] = [{ id: "user-owner", email: "owner@acme.dev", handle: "owner-dev" }];
      tables["org_members"] = [{ org_id: orgId, user_id: "user-owner", role: "owner" }];

      const router = freshCreateFakeRouter({
        "pass.security": { candidates: [SECURITY_CANDIDATE] },
        "verify.cross_exam": { verdict: "upheld", reasoning: "Confirmed: header is used unvalidated at that line." },
      });
      const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
      const adapter = fakeAdapter(calls);

      await freshHandleReviewRun(testJob, { db, adapter, router });

      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const sent = sendMailMock.mock.calls[0]![0] as { to: string; subject: string; html: string };
      expect(sent.to).toBe("owner@acme.dev");
      expect(sent.subject).toContain("widgets");
      expect(sent.html).toContain("https://app.codeferret.dev/runs/");
    } finally {
      delete process.env["SMTP_HOST"];
      delete process.env["SMTP_USER"];
      delete process.env["SMTP_PASS"];
      delete process.env["FRONTEND_URL"];
      vi.resetModules();
    }
  });

  it("never attempts to send email when no provider is configured", async () => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
    const { client: db } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.security": { candidates: [SECURITY_CANDIDATE] },
      "verify.cross_exam": { verdict: "upheld", reasoning: "x" },
    });
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter = fakeAdapter(calls);

    await handleReviewRun(job(), { db, adapter, router });

    expect(createTransportMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("disables sandbox execution verification for a free-plan org — degrades exactly like Docker being unavailable", async () => {
    // spyOn (no mockImplementation) calls through to the real verifyFinding — preserves its
    // actual static-check/cross-exam behavior for every other test, while letting this one
    // inspect the runSandbox argument reviewRun.ts decided to pass.
    const spy = vi.spyOn(verifyIndex, "verifyFinding");
    const { client: db } = createFakeSupabase();
    const router = createFakeRouter({
      "pass.security": { candidates: [SECURITY_CANDIDATE] },
      "verify.cross_exam": { verdict: "upheld", reasoning: "x" },
    });
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter = fakeAdapter(calls);

    await handleReviewRun(job(), { db, adapter, router });

    expect(spy).toHaveBeenCalledTimes(1);
    const sandboxOverride = spy.mock.calls[0]?.[3] as (() => Promise<{ available: boolean; reproduced: boolean; output: string }>) | undefined;
    expect(sandboxOverride).toBeTypeOf("function");
    await expect(sandboxOverride!()).resolves.toEqual({ available: false, reproduced: false, output: "" });
    spy.mockRestore();
  });

  it("leaves sandbox execution verification enabled for a pro-plan org", async () => {
    const spy = vi.spyOn(verifyIndex, "verifyFinding");
    const { client: db, tables } = createFakeSupabase();
    const testJob = job();
    const { orgId } = await upsertPrChain(db, testJob.pr, testJob.headSha);
    tables["subscriptions"] = [{ org_id: orgId, tier: "pro", status: "active", seats: 1 }];

    const router = createFakeRouter({
      "pass.security": { candidates: [SECURITY_CANDIDATE] },
      "verify.cross_exam": { verdict: "upheld", reasoning: "x" },
    });
    const calls = { postSummary: 0, postLineComment: 0, setStatus: 0 };
    const adapter = fakeAdapter(calls);

    await handleReviewRun(testJob, { db, adapter, router });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[3]).toBeUndefined(); // undefined = verifyFinding's own real default (runInSandbox)
    spy.mockRestore();
  });
});
