import { describe, expect, it } from "vitest";
import { inviteEmail, reviewCompleteEmail } from "./templates.js";

describe("inviteEmail", () => {
  it("includes the inviter, org, role, and accept link in both html and text bodies", () => {
    const content = inviteEmail({
      orgName: "Acme",
      inviterLabel: "priya-dev",
      role: "admin",
      acceptUrl: "https://app.codeferret.dev/invite/tok123",
    });

    expect(content.subject).toContain("priya-dev");
    expect(content.subject).toContain("Acme");
    expect(content.text).toContain("https://app.codeferret.dev/invite/tok123");
    expect(content.html).toContain("https://app.codeferret.dev/invite/tok123");
    expect(content.html).toContain("Acme");
    expect(content.html).toContain("admin");
  });

  it("escapes HTML-significant characters in untrusted fields (org name, inviter label)", () => {
    const content = inviteEmail({
      orgName: "<script>alert(1)</script>",
      inviterLabel: "Bob & \"Alice\"",
      role: "member",
      acceptUrl: "https://app.codeferret.dev/invite/tok123",
    });

    expect(content.html).not.toContain("<script>alert(1)</script>");
    expect(content.html).toContain("&lt;script&gt;");
    expect(content.html).toContain("&amp;");
    expect(content.html).toContain("&quot;Alice&quot;");
  });
});

describe("reviewCompleteEmail", () => {
  it("lists every posted finding with severity, title, and file:line", () => {
    const content = reviewCompleteEmail({
      repoName: "acme/payments-api",
      prNumber: 214,
      prTitle: "Add coupon stacking to checkout",
      riskLevel: "high",
      posted: [
        { severity: "critical", title: "Session ownership is not validated", path: "src/auth/session.ts", line: 43 },
        { severity: "major", title: "Unhandled promise rejection", path: "src/checkout.ts", line: 12 },
      ],
      digestCount: 3,
      runUrl: "https://app.codeferret.dev/runs/run-1",
      prUrl: "https://github.com/acme/payments-api/pull/214",
    });

    expect(content.subject).toContain("acme/payments-api");
    expect(content.subject).toContain("214");
    for (const text of [content.text, content.html]) {
      expect(text).toContain("Session ownership is not validated");
      expect(text).toContain("src/auth/session.ts:43");
      expect(text).toContain("Unhandled promise rejection");
      expect(text).toContain("src/checkout.ts:12");
      expect(text).toContain("https://app.codeferret.dev/runs/run-1");
      expect(text).toContain("https://github.com/acme/payments-api/pull/214");
    }
    expect(content.text).toMatch(/\+3 more/);
  });

  it("says so plainly when nothing was posted", () => {
    const content = reviewCompleteEmail({
      repoName: "acme/web",
      prNumber: 587,
      prTitle: "Refactor cart drawer",
      riskLevel: "none",
      posted: [],
      digestCount: 0,
      runUrl: "https://app.codeferret.dev/runs/run-2",
      prUrl: "https://github.com/acme/web/pull/587",
    });

    expect(content.text).toMatch(/no findings posted/i);
    expect(content.html).toMatch(/no findings posted/i);
  });
});
