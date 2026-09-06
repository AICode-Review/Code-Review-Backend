import { describe, expect, it } from "vitest";
import { createFakeSupabase, type FakeTables } from "../testUtils/fakeSupabase.js";
import { countActiveSeats } from "./repositories.js";

describe("countActiveSeats", () => {
  it("counts only members whose user row has seat_active = true", async () => {
    const tables: FakeTables = {
      org_members: [
        { org_id: "org-1", user_id: "u1", role: "owner" },
        { org_id: "org-1", user_id: "u2", role: "member" },
        { org_id: "org-1", user_id: "u3", role: "member" },
        { org_id: "org-2", user_id: "u4", role: "owner" }, // different org — must not count
      ],
      users: [
        { id: "u1", seat_active: true },
        { id: "u2", seat_active: true },
        { id: "u3", seat_active: false },
        { id: "u4", seat_active: true },
      ],
    };
    const { client } = createFakeSupabase(tables);
    expect(await countActiveSeats(client, "org-1")).toBe(2);
  });

  it("never returns less than 1, even with zero active seats — Razorpay requires a positive quantity", async () => {
    const tables: FakeTables = {
      org_members: [{ org_id: "org-1", user_id: "u1", role: "owner" }],
      users: [{ id: "u1", seat_active: false }],
    };
    const { client } = createFakeSupabase(tables);
    expect(await countActiveSeats(client, "org-1")).toBe(1);
  });

  it("is 1 for an org with no members at all", async () => {
    const { client } = createFakeSupabase({ org_members: [], users: [] });
    expect(await countActiveSeats(client, "org-1")).toBe(1);
  });
});
