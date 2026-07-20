import jwt from "jsonwebtoken";
import { env } from "./config.js";

export interface LicenseClaims {
  org: string;
  plan: string;
  seats: number;
}

export type LicenseCheckResult = { valid: true; claims?: LicenseClaims } | { valid: false; error: string };

/**
 * DESIGN.md §11 — self-hosted license enforcement: a signed JWT, verified
 * offline (RS256 against LICENSE_PUBLIC_KEY, no network call, matching
 * "offline-verifiable"). Only enforced when SELF_HOSTED=true — the normal
 * SaaS deployment never sets that and this is always a no-op there.
 */
export function verifyLicense(): LicenseCheckResult {
  if (!env().SELF_HOSTED) return { valid: true };

  const { LICENSE_KEY, LICENSE_PUBLIC_KEY } = env();
  if (!LICENSE_KEY || !LICENSE_PUBLIC_KEY) {
    return { valid: false, error: "SELF_HOSTED=true but LICENSE_KEY and/or LICENSE_PUBLIC_KEY are not set" };
  }

  try {
    const decoded = jwt.verify(LICENSE_KEY, LICENSE_PUBLIC_KEY, { algorithms: ["RS256"] });
    if (typeof decoded !== "object" || decoded === null) return { valid: false, error: "license payload is not a JSON object" };

    const { org, plan, seats } = decoded as Record<string, unknown>;
    if (typeof org !== "string" || typeof plan !== "string" || typeof seats !== "number") {
      return { valid: false, error: "license is missing required claims (org, plan, seats)" };
    }
    return { valid: true, claims: { org, plan, seats } };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
