import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBootstrapAdmin } from "./adminBootstrap.js";

const ORIGINAL = process.env["ADMIN_BOOTSTRAP_EMAILS"];

beforeEach(() => {
  delete process.env["ADMIN_BOOTSTRAP_EMAILS"];
  vi.resetModules(); // config.ts memoizes env() at module scope — force a fresh read per test.
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["ADMIN_BOOTSTRAP_EMAILS"];
  else process.env["ADMIN_BOOTSTRAP_EMAILS"] = ORIGINAL;
});

async function freshIsBootstrapAdmin() {
  const mod = await import("./adminBootstrap.js");
  return mod.isBootstrapAdmin;
}

describe("isBootstrapAdmin", () => {
  it("is false when ADMIN_BOOTSTRAP_EMAILS is unset", async () => {
    const isBootstrapAdmin = await freshIsBootstrapAdmin();
    expect(isBootstrapAdmin("owner@scrutinye.dev")).toBe(false);
  });

  it("matches a listed email case-insensitively", async () => {
    process.env["ADMIN_BOOTSTRAP_EMAILS"] = "Owner@Scrutinye.dev, second@scrutinye.dev";
    const isBootstrapAdmin = await freshIsBootstrapAdmin();
    expect(isBootstrapAdmin("owner@scrutinye.dev")).toBe(true);
    expect(isBootstrapAdmin("SECOND@scrutinye.dev")).toBe(true);
    expect(isBootstrapAdmin("nobody@scrutinye.dev")).toBe(false);
  });

  it("tolerates surrounding whitespace in the allowlist", async () => {
    process.env["ADMIN_BOOTSTRAP_EMAILS"] = " owner@scrutinye.dev , second@scrutinye.dev ";
    const isBootstrapAdmin = await freshIsBootstrapAdmin();
    expect(isBootstrapAdmin("second@scrutinye.dev")).toBe(true);
  });

  it("is false for a null/undefined email", () => {
    expect(isBootstrapAdmin(null)).toBe(false);
    expect(isBootstrapAdmin(undefined)).toBe(false);
  });
});
