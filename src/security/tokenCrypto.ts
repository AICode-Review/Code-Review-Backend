import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config.js";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

function keyBuffer(): Buffer {
  const hex = env().ENCRYPTION_KEY;
  if (!hex) throw new Error("ENCRYPTION_KEY is not set — required to encrypt/decrypt platform tokens");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars); got ${buf.length}`);
  }
  return buf;
}

export function encryptionConfigured(): boolean {
  return Boolean(env().ENCRYPTION_KEY);
}

/** AES-256-GCM. Output: base64(iv).base64(authTag).base64(ciphertext) — for platform_tokens.encrypted_token. */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyBuffer(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(".");
  const [ivB64, tagB64, dataB64] = parts;
  if (parts.length !== 3 || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("malformed encrypted token — expected iv.authTag.ciphertext");
  }
  const decipher = createDecipheriv(ALGO, keyBuffer(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
