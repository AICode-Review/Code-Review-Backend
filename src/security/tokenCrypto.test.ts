import { describe, expect, it, beforeAll } from "vitest";

// ENCRYPTION_KEY must be set before config.ts's env() is first called by tokenCrypto.
beforeAll(() => {
  process.env["ENCRYPTION_KEY"] = "a".repeat(64); // 32 bytes hex
});

describe("tokenCrypto", () => {
  it("round-trips a plaintext token", async () => {
    const { encryptToken, decryptToken } = await import("./tokenCrypto.js");
    const encrypted = encryptToken("ghs_super_secret_installation_token");
    expect(encrypted).not.toContain("ghs_super_secret");
    expect(decryptToken(encrypted)).toBe("ghs_super_secret_installation_token");
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", async () => {
    const { encryptToken } = await import("./tokenCrypto.js");
    const a = encryptToken("same-token");
    const b = encryptToken("same-token");
    expect(a).not.toBe(b);
  });

  it("throws on a tampered ciphertext (auth tag mismatch)", async () => {
    const { encryptToken, decryptToken } = await import("./tokenCrypto.js");
    const encrypted = encryptToken("some-token");
    const parts = encrypted.split(".");
    const tampered = [parts[0], parts[1], Buffer.from("tampered-data").toString("base64")].join(".");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws a clear error for a malformed encrypted string", async () => {
    const { decryptToken } = await import("./tokenCrypto.js");
    expect(() => decryptToken("not-the-right-format")).toThrow(/malformed/);
  });

  it("reports encryption as configured once ENCRYPTION_KEY is set", async () => {
    const { encryptionConfigured } = await import("./tokenCrypto.js");
    expect(encryptionConfigured()).toBe(true);
  });
});
