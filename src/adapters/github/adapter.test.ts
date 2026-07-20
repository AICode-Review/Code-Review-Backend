import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GithubAdapter } from "./adapter.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

const SECRET = "test-webhook-secret";

const adapter = new GithubAdapter({
  appId: "1",
  privateKey: "unused-in-these-tests",
  webhookSecret: SECRET,
});

function sign(body: Buffer): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("verifyWebhook", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));

  it("accepts a valid signature", () => {
    expect(adapter.verifyWebhook({ "x-hub-signature-256": sign(body) }, body)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ hello: "attacker" }));
    expect(adapter.verifyWebhook({ "x-hub-signature-256": sign(body) }, tampered)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(adapter.verifyWebhook({}, body)).toBe(false);
  });

  it("rejects a malformed signature of a different length", () => {
    expect(adapter.verifyWebhook({ "x-hub-signature-256": "sha256=abc" }, body)).toBe(false);
  });
});

describe("parseEvent", () => {
  it("normalizes pull_request.opened to pr_opened", () => {
    const event = adapter.parseEvent({
      name: "pull_request",
      payload: fixture("pull_request.opened.json"),
    });
    expect(event).toMatchObject({
      kind: "pr_opened",
      headSha: "b3f1c2d4e5f60718293a4b5c6d7e8f9012345678",
      pr: {
        number: 42,
        author: "octocat",
        repo: {
          platform: "github",
          owner: "acme",
          name: "payments-api",
          externalId: "123456789",
          orgExternalId: "9876543",
          installationId: 55511,
        },
      },
    });
  });

  it("normalizes pull_request.synchronize to pr_updated", () => {
    const event = adapter.parseEvent({
      name: "pull_request",
      payload: fixture("pull_request.synchronize.json"),
    });
    expect(event?.kind).toBe("pr_updated");
  });

  it("ignores pull_request actions that don't trigger reviews", () => {
    const payload = fixture("pull_request.opened.json") as Record<string, unknown>;
    expect(adapter.parseEvent({ name: "pull_request", payload: { ...payload, action: "labeled" } })).toBeNull();
  });

  it("normalizes installation.created with repo list", () => {
    const event = adapter.parseEvent({
      name: "installation",
      payload: fixture("installation.created.json"),
    });
    expect(event).toMatchObject({
      kind: "installed",
      org: { platform: "github", externalId: "9876543", name: "acme" },
      accountType: "Organization",
      installedBy: { githubId: 42424242, login: "octocat" },
    });
    if (event?.kind !== "installed") throw new Error("expected installed event");
    expect(event.repos).toHaveLength(2);
    expect(event.repos[0]?.installationId).toBe(55511);
  });

  it("normalizes installation.deleted to uninstalled", () => {
    const payload = fixture("installation.created.json") as Record<string, unknown>;
    const event = adapter.parseEvent({ name: "installation", payload: { ...payload, action: "deleted" } });
    expect(event?.kind).toBe("uninstalled");
  });

  it("normalizes a /review issue comment to a command", () => {
    const event = adapter.parseEvent({
      name: "issue_comment",
      payload: fixture("issue_comment.review_command.json"),
    });
    expect(event).toMatchObject({ kind: "command", command: "review", author: "octocat" });
  });

  it("ignores non-command comments and bot comments", () => {
    const payload = fixture("issue_comment.review_command.json") as {
      comment: { body: string; user: { login: string } };
    };
    expect(
      adapter.parseEvent({
        name: "issue_comment",
        payload: { ...payload, comment: { ...payload.comment, body: "nice work!" } },
      }),
    ).toBeNull();
    expect(
      adapter.parseEvent({
        name: "issue_comment",
        payload: { ...payload, comment: { ...payload.comment, user: { login: "codeferret[bot]" } } },
      }),
    ).toBeNull();
  });

  it("returns null for unknown events and garbage", () => {
    expect(adapter.parseEvent({ name: "watch", payload: {} })).toBeNull();
    expect(adapter.parseEvent("not-an-object")).toBeNull();
    expect(adapter.parseEvent(null)).toBeNull();
  });

  it("normalizes an @mention in a general PR comment to a scope:general reply", () => {
    const payload = fixture("issue_comment.review_command.json") as {
      comment: { id: number; body: string; user: { login: string } };
    };
    const event = adapter.parseEvent({
      name: "issue_comment",
      payload: { ...payload, comment: { ...payload.comment, body: "hey @codeferret, is this really a bug?" } },
    });
    expect(event).toMatchObject({ kind: "feedback", type: "reply", scope: "general", commentId: "314159" });
  });

  it("normalizes a reply threaded under a review comment to a scope:finding reply", () => {
    const event = adapter.parseEvent({
      name: "pull_request_review_comment",
      payload: {
        action: "created",
        comment: { id: 999, body: "this is intentional, we handle it upstream", user: { login: "octocat" }, in_reply_to_id: 12345 },
        pull_request: { number: 42 },
        repository: {
          id: 123456789,
          name: "payments-api",
          owner: { id: 9876543, login: "acme" },
        },
        installation: { id: 55511 },
      },
    });
    expect(event).toMatchObject({
      kind: "feedback",
      type: "reply",
      scope: "finding",
      commentId: "12345",
      body: "this is intentional, we handle it upstream",
    });
  });

  it("ignores a brand-new (non-reply) review comment and the bot's own replies", () => {
    const base = {
      action: "created",
      pull_request: { number: 42 },
      repository: { id: 123456789, name: "payments-api", owner: { id: 9876543, login: "acme" } },
      installation: { id: 55511 },
    };
    expect(
      adapter.parseEvent({
        name: "pull_request_review_comment",
        payload: { ...base, comment: { id: 1, body: "new top-level comment", user: { login: "octocat" } } },
      }),
    ).toBeNull();
    expect(
      adapter.parseEvent({
        name: "pull_request_review_comment",
        payload: { ...base, comment: { id: 2, body: "reply", user: { login: "codeferret[bot]" }, in_reply_to_id: 12345 } },
      }),
    ).toBeNull();
  });
});
