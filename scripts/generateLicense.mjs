#!/usr/bin/env node
/**
 * Dev/test helper for the self-hosted license flow (DESIGN.md §11) — NOT
 * used in production issuance (a real keypair is generated and kept once,
 * offline, by whoever ships self-hosted licenses; this script exists so the
 * verify-side code in src/license.ts is actually exercisable end-to-end
 * without that separate process existing yet).
 *
 * Usage: node scripts/generateLicense.mjs [org] [plan] [seats]
 * Prints LICENSE_PUBLIC_KEY and LICENSE_KEY as .env-ready lines.
 */
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";

const [, , org = "acme-selfhosted", plan = "enterprise", seatsArg = "50"] = process.argv;

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const token = jwt.sign({ org, plan, seats: Number(seatsArg) }, privateKey, {
  algorithm: "RS256",
  expiresIn: "365d",
});

console.log("# Add these to .env.selfhosted:");
console.log(`LICENSE_PUBLIC_KEY=${JSON.stringify(publicKey)}`);
console.log(`LICENSE_KEY=${token}`);
