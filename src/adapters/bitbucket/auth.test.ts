import { describe, expect, it } from "vitest";
import {
  bitbucketAuthorizationHeader,
  encodeBitbucketCredential,
  parseBitbucketCredential,
} from "./auth.js";

describe("bitbucket auth credentials", () => {
  it("encodes a Workspace Access Token as a raw bearer string", () => {
    expect(encodeBitbucketCredential("wat-secret")).toBe("wat-secret");
    expect(parseBitbucketCredential("wat-secret")).toEqual({ token: "wat-secret" });
    expect(bitbucketAuthorizationHeader("wat-secret")).toBe("Bearer wat-secret");
  });

  it("encodes a personal API token with email for Basic auth", () => {
    const encoded = encodeBitbucketCredential("api-token", "dev@example.com");
    expect(JSON.parse(encoded)).toEqual({ token: "api-token", email: "dev@example.com" });
    expect(parseBitbucketCredential(encoded)).toEqual({ token: "api-token", email: "dev@example.com" });
    expect(bitbucketAuthorizationHeader(encoded)).toBe(
      `Basic ${Buffer.from("dev@example.com:api-token", "utf8").toString("base64")}`,
    );
  });

  it("treats malformed JSON as an opaque bearer token", () => {
    expect(parseBitbucketCredential("{not-json")).toEqual({ token: "{not-json" });
  });
});
