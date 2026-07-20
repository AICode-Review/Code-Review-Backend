import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { buildAtlassianConnectDescriptor, computeQsh, verifyConnectJwt } from "./connect.js";

describe("buildAtlassianConnectDescriptor", () => {
  it("advertises jwt auth, the lifecycle URLs, and the pull-request webhook events", () => {
    const descriptor = buildAtlassianConnectDescriptor({ baseUrl: "https://api.example.com" });
    expect(descriptor["key"]).toBe("codeferret-bitbucket");
    expect(descriptor["baseUrl"]).toBe("https://api.example.com");
    expect((descriptor["authentication"] as { type: string }).type).toBe("jwt");
    expect((descriptor["lifecycle"] as { installed: string }).installed).toBe("/bitbucket/connect/installed");
    const events = (descriptor["modules"] as { webhooks: { event: string }[] }).webhooks.map((w) => w.event);
    expect(events).toEqual(["pullrequest:created", "pullrequest:updated", "pullrequest:comment_created"]);
  });
});

describe("computeQsh", () => {
  it("is stable regardless of query param order", () => {
    const a = computeQsh("GET", "/webhooks/bitbucket", { b: "2", a: "1" });
    const b = computeQsh("GET", "/webhooks/bitbucket", { a: "1", b: "2" });
    expect(a).toBe(b);
  });

  it("differs when the method, path, or a query value changes", () => {
    const base = computeQsh("GET", "/webhooks/bitbucket", { a: "1" });
    expect(computeQsh("POST", "/webhooks/bitbucket", { a: "1" })).not.toBe(base);
    expect(computeQsh("GET", "/other", { a: "1" })).not.toBe(base);
    expect(computeQsh("GET", "/webhooks/bitbucket", { a: "2" })).not.toBe(base);
  });

  it("normalizes a trailing slash on the path", () => {
    expect(computeQsh("GET", "/webhooks/bitbucket/", {})).toBe(computeQsh("GET", "/webhooks/bitbucket", {}));
  });
});

describe("verifyConnectJwt", () => {
  const SECRET = "test-shared-secret";
  const METHOD = "POST";
  const PATH = "/webhooks/bitbucket";
  const QUERY = {};

  function signValid(overrides: Record<string, unknown> = {}): string {
    return jwt.sign({ iss: "client-key-1", qsh: computeQsh(METHOD, PATH, QUERY), ...overrides }, SECRET, { algorithm: "HS256" });
  }

  it("accepts a correctly signed token whose qsh matches the request", () => {
    const result = verifyConnectJwt(signValid(), SECRET, METHOD, PATH, QUERY);
    expect(result).toEqual({ valid: true, clientKey: "client-key-1" });
  });

  it("rejects a token signed with the wrong shared secret", () => {
    const result = verifyConnectJwt(signValid(), "wrong-secret", METHOD, PATH, QUERY);
    expect(result.valid).toBe(false);
  });

  it("rejects a token whose qsh doesn't match this request (tampering / wrong endpoint)", () => {
    const token = signValid({ qsh: computeQsh(METHOD, "/some/other/path", QUERY) });
    const result = verifyConnectJwt(token, SECRET, METHOD, PATH, QUERY);
    expect(result).toEqual({ valid: false, error: expect.stringContaining("qsh") });
  });

  it("rejects a token missing the iss claim", () => {
    const token = jwt.sign({ qsh: computeQsh(METHOD, PATH, QUERY) }, SECRET, { algorithm: "HS256" });
    const result = verifyConnectJwt(token, SECRET, METHOD, PATH, QUERY);
    expect(result.valid).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = jwt.sign({ iss: "client-key-1", qsh: computeQsh(METHOD, PATH, QUERY) }, SECRET, {
      algorithm: "HS256",
      expiresIn: -10,
    });
    const result = verifyConnectJwt(token, SECRET, METHOD, PATH, QUERY);
    expect(result.valid).toBe(false);
  });
});
