import { describe, expect, it } from "vitest";
import { installationRateLimitKey, workspaceRateLimitKey } from "./webhooks.js";

describe("installationRateLimitKey", () => {
  it("keys by GitHub installation id when present", () => {
    const key = installationRateLimitKey({ body: { installation: { id: 55511 } }, ip: "1.2.3.4" });
    expect(key).toBe("gh-install-55511");
  });

  it("keeps two different installations from sharing a rate-limit bucket", () => {
    const a = installationRateLimitKey({ body: { installation: { id: 1 } }, ip: "1.2.3.4" });
    const b = installationRateLimitKey({ body: { installation: { id: 2 } }, ip: "1.2.3.4" });
    expect(a).not.toBe(b);
  });

  it("falls back to IP when no installation id is present (e.g. malformed payload)", () => {
    expect(installationRateLimitKey({ body: {}, ip: "9.9.9.9" })).toBe("9.9.9.9");
    expect(installationRateLimitKey({ body: undefined, ip: "9.9.9.9" })).toBe("9.9.9.9");
  });
});

describe("workspaceRateLimitKey", () => {
  it("keys by Bitbucket workspace uuid when present", () => {
    const key = workspaceRateLimitKey({ body: { repository: { workspace: { uuid: "{workspace-uuid}" } } }, ip: "1.2.3.4" });
    expect(key).toBe("bb-workspace-{workspace-uuid}");
  });

  it("falls back to IP when no workspace uuid is present", () => {
    expect(workspaceRateLimitKey({ body: {}, ip: "9.9.9.9" })).toBe("9.9.9.9");
  });
});
