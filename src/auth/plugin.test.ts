import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthedUser } from "./verifyUser.js";

const verifyBearerToken = vi.fn<(token: string) => Promise<AuthedUser | null>>();
vi.mock("./verifyUser.js", () => ({ verifyBearerToken: (token: string) => verifyBearerToken(token) }));

const { requireAdmin, requireAuth } = await import("./plugin.js");

function fakeReply(): FastifyReply {
  const reply = {
    sent: false,
    code: vi.fn(function (this: typeof reply) {
      return this;
    }),
    send: vi.fn(function (this: typeof reply) {
      this.sent = true;
      return this;
    }),
  };
  return reply as unknown as FastifyReply;
}

function fakeRequest(bearer?: string): FastifyRequest {
  return { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} } as unknown as FastifyRequest;
}

const ADMIN_USER: AuthedUser = { id: "u-1", authUserId: "auth-1", email: "admin@codeferret.dev", githubLogin: null, githubId: null, isPlatformAdmin: true };
const NON_ADMIN_USER: AuthedUser = { id: "u-2", authUserId: "auth-2", email: "member@acme.dev", githubLogin: null, githubId: null, isPlatformAdmin: false };

describe("requireAdmin", () => {
  it("401s when there's no bearer token — never calls verifyBearerToken", async () => {
    verifyBearerToken.mockReset();
    const reply = fakeReply();
    await requireAdmin(fakeRequest(), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(verifyBearerToken).not.toHaveBeenCalled();
  });

  it("403s a valid session that isn't a platform admin", async () => {
    verifyBearerToken.mockReset().mockResolvedValue(NON_ADMIN_USER);
    const reply = fakeReply();
    await requireAdmin(fakeRequest("tok"), reply);
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("lets a platform admin through with no error response sent", async () => {
    verifyBearerToken.mockReset().mockResolvedValue(ADMIN_USER);
    const req = fakeRequest("tok");
    const reply = fakeReply();
    await requireAdmin(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(req.authedUser).toEqual(ADMIN_USER);
  });
});

describe("requireAuth", () => {
  it("401s an invalid/expired session", async () => {
    verifyBearerToken.mockReset().mockResolvedValue(null);
    const reply = fakeReply();
    await requireAuth(fakeRequest("tok"), reply);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("attaches the authed user for any valid session, admin or not", async () => {
    verifyBearerToken.mockReset().mockResolvedValue(NON_ADMIN_USER);
    const req = fakeRequest("tok");
    const reply = fakeReply();
    await requireAuth(req, reply);
    expect(reply.code).not.toHaveBeenCalled();
    expect(req.authedUser).toEqual(NON_ADMIN_USER);
  });
});
