import { generateKeyPairSync } from "node:crypto";
import jwtLib from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const { publicKey: otherPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function sign(claims: Record<string, unknown>): string {
  return jwtLib.sign(claims, privateKey, { algorithm: "RS256", expiresIn: "1d" });
}

// Only touch the 3 license-related keys — the rest of process.env (SUPABASE_URL,
// GITHUB_APP_ID, etc., loaded by dotenv when config.ts first imports) must survive
// untouched, since config.ts's env() validates the *entire* schema on every fresh read.
const LICENSE_KEYS = ["SELF_HOSTED", "LICENSE_KEY", "LICENSE_PUBLIC_KEY"] as const;
const ORIGINAL_LICENSE_ENV = Object.fromEntries(LICENSE_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of LICENSE_KEYS) delete process.env[k];
  vi.resetModules(); // config.ts memoizes env() at module scope — force a fresh read per test.
});
afterEach(() => {
  for (const k of LICENSE_KEYS) {
    const v = ORIGINAL_LICENSE_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function freshVerifyLicense() {
  const mod = await import("./license.js");
  return mod.verifyLicense as typeof import("./license.js").verifyLicense;
}

describe("verifyLicense", () => {
  it("is a no-op (always valid) when SELF_HOSTED is not set", async () => {
    delete process.env["SELF_HOSTED"];
    const verifyLicense = await freshVerifyLicense();
    expect(verifyLicense()).toEqual({ valid: true });
  });

  it("fails when SELF_HOSTED is true but no license key/public key is configured", async () => {
    process.env["SELF_HOSTED"] = "true";
    delete process.env["LICENSE_KEY"];
    delete process.env["LICENSE_PUBLIC_KEY"];
    const verifyLicense = await freshVerifyLicense();
    const result = verifyLicense();
    expect(result.valid).toBe(false);
  });

  it("accepts a validly-signed license with the required claims", async () => {
    process.env["SELF_HOSTED"] = "true";
    process.env["LICENSE_KEY"] = sign({ org: "acme", plan: "enterprise", seats: 50 });
    process.env["LICENSE_PUBLIC_KEY"] = publicKey;
    const verifyLicense = await freshVerifyLicense();
    const result = verifyLicense();
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.claims).toEqual({ org: "acme", plan: "enterprise", seats: 50 });
  });

  it("rejects a license signed by a different keypair (offline-verifiable, not just well-formed)", async () => {
    process.env["SELF_HOSTED"] = "true";
    process.env["LICENSE_KEY"] = sign({ org: "acme", plan: "enterprise", seats: 50 });
    process.env["LICENSE_PUBLIC_KEY"] = otherPublicKey; // wrong key for this token
    const verifyLicense = await freshVerifyLicense();
    expect(verifyLicense().valid).toBe(false);
  });

  it("rejects an expired license", async () => {
    process.env["SELF_HOSTED"] = "true";
    process.env["LICENSE_KEY"] = jwtLib.sign({ org: "acme", plan: "enterprise", seats: 50 }, privateKey, {
      algorithm: "RS256",
      expiresIn: -10,
    });
    process.env["LICENSE_PUBLIC_KEY"] = publicKey;
    const verifyLicense = await freshVerifyLicense();
    expect(verifyLicense().valid).toBe(false);
  });

  it("rejects a license missing required claims", async () => {
    process.env["SELF_HOSTED"] = "true";
    process.env["LICENSE_KEY"] = sign({ org: "acme" }); // no plan/seats
    process.env["LICENSE_PUBLIC_KEY"] = publicKey;
    const verifyLicense = await freshVerifyLicense();
    expect(verifyLicense().valid).toBe(false);
  });
});
