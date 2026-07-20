import type { BenchmarkCase } from "../types.js";

/**
 * Seed dataset (DESIGN.md §12) — a small, hand-authored starting set, NOT the 100+
 * real-mined-PR corpus the full benchmark calls for. Every case here is `source:
 * "synthetic"`: a deliberately-injected, realistic bug in a small snippet, matching
 * DESIGN.md's complementary "injected-bug PRs for controlled recall tests" category.
 *
 * Mining 100+ real "a bug shipped, was later fixed" PR pairs from OSS history is a
 * genuine data-collection project (tracing blame history, correlating fix commits back
 * to the PR that introduced the regression, verifying each pairing is actually correct)
 * — it deserves to be done properly as its own piece of work, not rushed here. Adding a
 * real_pr case later just means setting `source: "real_pr"` and `prUrl` on a new entry;
 * the schema and scoring logic already support both.
 */
export const seedCases: BenchmarkCase[] = [
  {
    id: "sql-injection-fstring",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "python",
    description: "String-interpolated SQL query replaces a parameterized one — classic SQL injection via the email field.",
    diff: `diff --git a/src/db/users.py b/src/db/users.py
index 1111111..2222222 100644
--- a/src/db/users.py
+++ b/src/db/users.py
@@ -1,4 +1,5 @@
 def get_user_by_email(conn, email):
     cursor = conn.cursor()
-    cursor.execute("SELECT id, name FROM users WHERE email = %s", (email,))
+    query = f"SELECT id, name FROM users WHERE email = '{email}'"
+    cursor.execute(query)
     return cursor.fetchone()
`,
    files: {
      "src/db/users.py": `def get_user_by_email(conn, email):
    cursor = conn.cursor()
    query = f"SELECT id, name FROM users WHERE email = '{email}'"
    cursor.execute(query)
    return cursor.fetchone()
`,
    },
    expectedFindings: [
      {
        path: "src/db/users.py",
        lineRange: [3, 4],
        category: "security",
        severity: "critical",
        description: "Unsanitized string interpolation into a SQL query — SQL injection via the email parameter.",
      },
    ],
  },
  {
    id: "off-by-one-pagination",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "typescript",
    description: "Pagination slice end bound is off by one, returning one extra item per page.",
    diff: `diff --git a/src/utils/pagination.ts b/src/utils/pagination.ts
index 1111111..2222222 100644
--- a/src/utils/pagination.ts
+++ b/src/utils/pagination.ts
@@ -1,5 +1,5 @@
 export function getPageItems<T>(items: T[], pageSize: number, pageIndex: number): T[] {
   const start = pageIndex * pageSize;
   const end = start + pageSize;
-  return items.slice(start, end);
+  return items.slice(start, end + 1);
 }
`,
    files: {
      "src/utils/pagination.ts": `export function getPageItems<T>(items: T[], pageSize: number, pageIndex: number): T[] {
  const start = pageIndex * pageSize;
  const end = start + pageSize;
  return items.slice(start, end + 1);
}
`,
    },
    expectedFindings: [
      {
        path: "src/utils/pagination.ts",
        lineRange: [4, 4],
        category: "logic",
        severity: "major",
        description: "slice(start, end + 1) returns pageSize + 1 items — an off-by-one that leaks the next page's first item.",
      },
    ],
  },
  {
    id: "missing-await-cleanup-loop",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "typescript",
    description: "A dropped `await` inside a loop lets deletes run unbounded/unordered and lets the function return before they finish.",
    diff: `diff --git a/src/jobs/cleanup.ts b/src/jobs/cleanup.ts
index 1111111..2222222 100644
--- a/src/jobs/cleanup.ts
+++ b/src/jobs/cleanup.ts
@@ -1,6 +1,6 @@
 export async function cleanupExpiredSessions(db: Db): Promise<void> {
   const expired = await db.sessions.findExpired();
   for (const session of expired) {
-    await db.sessions.delete(session.id);
+    db.sessions.delete(session.id);
   }
 }
`,
    files: {
      "src/jobs/cleanup.ts": `export async function cleanupExpiredSessions(db: Db): Promise<void> {
  const expired = await db.sessions.findExpired();
  for (const session of expired) {
    db.sessions.delete(session.id);
  }
}
`,
    },
    expectedFindings: [
      {
        path: "src/jobs/cleanup.ts",
        lineRange: [4, 4],
        category: "concurrency",
        severity: "major",
        description: "Unawaited delete inside the loop — unbounded concurrent deletes, and the function resolves before cleanup actually finishes.",
      },
    ],
  },
  {
    id: "swallowed-payment-error",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "go",
    description: "A failed charge is swallowed (returns nil instead of the real error), so the caller treats a failed payment as success.",
    diff: `diff --git a/internal/payments/charge.go b/internal/payments/charge.go
index 1111111..2222222 100644
--- a/internal/payments/charge.go
+++ b/internal/payments/charge.go
@@ -1,7 +1,7 @@
 func ChargeCard(ctx context.Context, amount int64, token string) error {
 	result, err := stripeClient.Charge(ctx, amount, token)
 	if err != nil {
-		return err
+		return nil
 	}
 	return saveCharge(ctx, result)
 }
`,
    files: {
      "internal/payments/charge.go": `func ChargeCard(ctx context.Context, amount int64, token string) error {
	result, err := stripeClient.Charge(ctx, amount, token)
	if err != nil {
		return nil
	}
	return saveCharge(ctx, result)
}
`,
    },
    expectedFindings: [
      {
        path: "internal/payments/charge.go",
        lineRange: [4, 4],
        category: "errors",
        severity: "critical",
        description: "Charge error is swallowed (return nil) — a failed payment is silently treated as successful.",
      },
    ],
  },
  {
    id: "removed-null-check-billing",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "typescript",
    description: "A null-safe accessor is replaced with a direct property access, even though the parameter type still allows null.",
    diff: `diff --git a/src/features/billing/formatPlan.ts b/src/features/billing/formatPlan.ts
index 1111111..2222222 100644
--- a/src/features/billing/formatPlan.ts
+++ b/src/features/billing/formatPlan.ts
@@ -1,3 +1,3 @@
 export function formatPlanName(subscription: Subscription | null): string {
-  return subscription?.plan?.toUpperCase() ?? "FREE";
+  return subscription.plan.toUpperCase();
 }
`,
    files: {
      "src/features/billing/formatPlan.ts": `export function formatPlanName(subscription: Subscription | null): string {
  return subscription.plan.toUpperCase();
}
`,
    },
    expectedFindings: [
      {
        path: "src/features/billing/formatPlan.ts",
        lineRange: [2, 2],
        category: "logic",
        severity: "major",
        description: "subscription is typed Subscription | null but is accessed directly — throws when null, exactly the case the old optional chaining handled.",
      },
    ],
  },
  {
    id: "signature-change-breaks-caller",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "typescript",
    description: "applyDiscount gains a required third parameter; a same-repo caller (unchanged in this diff) is left calling it with only two args. Requires cross-file awareness (repo-index context) to catch, not just the diff — a real test of engine/contextAssembly.ts's indexer wiring, not only the pass prompts.",
    diff: `diff --git a/src/lib/discount.ts b/src/lib/discount.ts
index 1111111..2222222 100644
--- a/src/lib/discount.ts
+++ b/src/lib/discount.ts
@@ -1,3 +1,3 @@
-export function applyDiscount(price: number, pct: number): number {
-  return price - price * pct;
+export function applyDiscount(price: number, pct: number, cap: number): number {
+  return Math.min(price * pct, cap) > 0 ? price - Math.min(price * pct, cap) : price;
 }
`,
    files: {
      "src/lib/discount.ts": `export function applyDiscount(price: number, pct: number, cap: number): number {
  return Math.min(price * pct, cap) > 0 ? price - Math.min(price * pct, cap) : price;
}
`,
      "src/checkout/summary.ts": `import { applyDiscount } from "../lib/discount.js";

export function computeTotal(price: number, discountPct: number): number {
  return applyDiscount(price, discountPct);
}
`,
    },
    expectedFindings: [
      {
        path: "src/lib/discount.ts",
        lineRange: [1, 2],
        category: "contracts",
        severity: "critical",
        description: "applyDiscount now requires a cap argument; src/checkout/summary.ts's computeTotal still calls it with only 2 args — a type error / broken caller.",
      },
    ],
  },
  {
    id: "stale-test-after-threshold-change",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "typescript",
    description: "The eligibility threshold changes from 30 to 90 days but the test file (included, unchanged) still asserts the old boundary — a real regression in the test suite this diff should have updated.",
    diff: `diff --git a/src/pricing/tier.ts b/src/pricing/tier.ts
index 1111111..2222222 100644
--- a/src/pricing/tier.ts
+++ b/src/pricing/tier.ts
@@ -1,3 +1,3 @@
 export function isEligibleForDiscount(accountAgeDays: number): boolean {
-  return accountAgeDays > 30;
+  return accountAgeDays > 90;
 }
`,
    files: {
      "src/pricing/tier.ts": `export function isEligibleForDiscount(accountAgeDays: number): boolean {
  return accountAgeDays > 90;
}
`,
      "src/pricing/tier.test.ts": `import { describe, it, expect } from "vitest";
import { isEligibleForDiscount } from "./tier.js";

describe("isEligibleForDiscount", () => {
  it("is true after 30 days", () => {
    expect(isEligibleForDiscount(31)).toBe(true);
  });
  it("is false at exactly 30 days", () => {
    expect(isEligibleForDiscount(30)).toBe(false);
  });
});
`,
    },
    expectedFindings: [
      {
        path: "src/pricing/tier.ts",
        lineRange: [2, 2],
        category: "tests",
        severity: "minor",
        description: "Threshold changed to 90 days but tier.test.ts still asserts the old 30-day boundary — the existing tests now fail/no longer reflect real behavior.",
      },
    ],
  },
  {
    id: "xss-unescaped-comment-render",
    source: "synthetic",
    repo: "seed/synthetic",
    language: "javascript",
    description: "HTML-escaping is dropped from a comment renderer, reopening a stored-XSS hole via author name or comment body.",
    diff: `diff --git a/src/templates/renderComment.js b/src/templates/renderComment.js
index 1111111..2222222 100644
--- a/src/templates/renderComment.js
+++ b/src/templates/renderComment.js
@@ -1,3 +1,3 @@
 export function renderComment(author, body) {
-  return \`<div class="comment"><strong>\${escapeHtml(author)}</strong><p>\${escapeHtml(body)}</p></div>\`;
+  return \`<div class="comment"><strong>\${author}</strong><p>\${body}</p></div>\`;
 }
`,
    files: {
      "src/templates/renderComment.js": `export function renderComment(author, body) {
  return \`<div class="comment"><strong>\${author}</strong><p>\${body}</p></div>\`;
}
`,
    },
    expectedFindings: [
      {
        path: "src/templates/renderComment.js",
        lineRange: [2, 2],
        category: "security",
        severity: "critical",
        description: "author/body are interpolated into HTML without escaping — stored XSS via either field.",
      },
    ],
  },
];
