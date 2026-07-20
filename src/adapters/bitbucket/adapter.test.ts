import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BitbucketAdapter } from "./adapter.js";

const SECRET = "test-webhook-secret";
const adapter = new BitbucketAdapter({ webhookSecret: SECRET });

function sign(body: Buffer): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

const REPOSITORY = {
  uuid: "{repo-uuid}",
  full_name: "acme-team/payments-api",
  workspace: { slug: "acme-team", uuid: "{workspace-uuid}" },
};

describe("verifyWebhook", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));

  it("accepts a valid signature", () => {
    expect(adapter.verifyWebhook({ "x-hub-signature": sign(body) }, body)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ hello: "attacker" }));
    expect(adapter.verifyWebhook({ "x-hub-signature": sign(body) }, tampered)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(adapter.verifyWebhook({}, body)).toBe(false);
  });
});

describe("parseEvent", () => {
  it("normalizes pullrequest:created to pr_opened", () => {
    const event = adapter.parseEvent({
      name: "pullrequest:created",
      payload: {
        pullrequest: { id: 42, title: "Fix the thing", author: { nickname: "octocat" }, source: { commit: { hash: "abc123" } } },
        repository: REPOSITORY,
      },
    });
    expect(event).toMatchObject({
      kind: "pr_opened",
      headSha: "abc123",
      pr: {
        number: 42,
        title: "Fix the thing",
        author: "octocat",
        repo: { platform: "bitbucket", owner: "acme-team", name: "payments-api", externalId: "{repo-uuid}", orgExternalId: "{workspace-uuid}" },
      },
    });
  });

  it("normalizes pullrequest:updated to pr_updated", () => {
    const event = adapter.parseEvent({
      name: "pullrequest:updated",
      payload: {
        pullrequest: { id: 42, title: "Fix the thing", source: { commit: { hash: "def456" } } },
        repository: REPOSITORY,
      },
    });
    expect(event?.kind).toBe("pr_updated");
  });

  it("normalizes a /review comment to a command", () => {
    const event = adapter.parseEvent({
      name: "pullrequest:comment_created",
      payload: {
        comment: { id: 1, content: { raw: "/review" }, user: { nickname: "octocat" } },
        pullrequest: { id: 42 },
        repository: REPOSITORY,
      },
    });
    expect(event).toMatchObject({ kind: "command", command: "review", author: "octocat" });
  });

  it("normalizes a threaded reply to a scope:finding feedback event", () => {
    const event = adapter.parseEvent({
      name: "pullrequest:comment_created",
      payload: {
        comment: { id: 99, content: { raw: "this is intentional" }, user: { nickname: "octocat" }, parent: { id: 55 } },
        pullrequest: { id: 42 },
        repository: REPOSITORY,
      },
    });
    expect(event).toMatchObject({ kind: "feedback", type: "reply", scope: "finding", commentId: "55", body: "this is intentional" });
  });

  it("normalizes a top-level @mention to a scope:general feedback event", () => {
    const event = adapter.parseEvent({
      name: "pullrequest:comment_created",
      payload: {
        comment: { id: 7, content: { raw: "hey @codeferret is this right?" }, user: { nickname: "octocat" } },
        pullrequest: { id: 42 },
        repository: REPOSITORY,
      },
    });
    expect(event).toMatchObject({ kind: "feedback", type: "reply", scope: "general", commentId: "7" });
  });

  it("ignores non-command, non-mention, non-reply comments and our own bot's comments", () => {
    expect(
      adapter.parseEvent({
        name: "pullrequest:comment_created",
        payload: {
          comment: { id: 1, content: { raw: "nice work!" }, user: { nickname: "octocat" } },
          pullrequest: { id: 42 },
          repository: REPOSITORY,
        },
      }),
    ).toBeNull();
    expect(
      adapter.parseEvent({
        name: "pullrequest:comment_created",
        payload: {
          comment: { id: 1, content: { raw: "some reply" }, user: { nickname: "codeferret" }, parent: { id: 55 } },
          pullrequest: { id: 42 },
          repository: REPOSITORY,
        },
      }),
    ).toBeNull();
  });

  it("returns null for unknown events and garbage", () => {
    expect(adapter.parseEvent({ name: "repo:push", payload: {} })).toBeNull();
    expect(adapter.parseEvent("not-an-object")).toBeNull();
    expect(adapter.parseEvent(null)).toBeNull();
  });
});
