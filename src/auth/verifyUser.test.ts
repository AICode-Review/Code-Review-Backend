import { describe, expect, it } from "vitest";
import { ensureOrgAccess, type AuthedUser } from "./verifyUser.js";
import { createFakeSupabase } from "../testUtils/fakeSupabase.js";

const user: AuthedUser = {
  id: "user-1",
  authUserId: "auth-1",
  email: "alice_test@example.com",
  githubLogin: null,
  githubId: null,
  isPlatformAdmin: false,
};
function database(email: string) {
  return createFakeSupabase({
    org_invites: [
      {
        id: "invite-1",
        org_id: "org-1",
        email,
        status: "pending",
        role: "admin",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ],
  });
}

describe("invite auto-accept authorization", () => {
  it("does not treat underscores or percent signs in an email as SQL wildcards", async () => {
    for (const email of ["alice_test@example.com", "alice%test@example.com"]) {
      const { client, tables } = database("aliceXtest@example.com");
      expect(await ensureOrgAccess(client, { ...user, email }, "org-1")).toBe(
        false,
      );
      expect(tables["org_members"] ?? []).toHaveLength(0);
      expect(tables["org_invites"]?.[0]?.status).toBe("pending");
    }
  });
  it("accepts the exact email case-insensitively and grants only its invited role", async () => {
    const { client, tables } = database("alice_test@example.com");
    expect(
      await ensureOrgAccess(
        client,
        { ...user, email: "Alice_Test@Example.com" },
        "org-1",
      ),
    ).toBe(true);
    expect(tables["org_members"]?.[0]).toMatchObject({
      org_id: "org-1",
      user_id: user.id,
      role: "admin",
    });
    expect(tables["org_invites"]?.[0]?.status).toBe("accepted");
  });
  it("does not accept an expired or different-organization invite", async () => {
    const { client, tables } = database(user.email!);
    expect(await ensureOrgAccess(client, user, "other-org")).toBe(false);
    tables["org_invites"]![0]!.expires_at = "2000-01-01T00:00:00.000Z";
    expect(await ensureOrgAccess(client, user, "org-1")).toBe(false);
  });
});
