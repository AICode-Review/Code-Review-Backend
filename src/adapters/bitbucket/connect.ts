import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";

/**
 * Atlassian Connect app scaffolding (DESIGN.md §4) — the Marketplace-distributable
 * installation path, additive alongside the existing manual-workspace-token flow in
 * adapter.ts (which stays the real, working install method until this is registered
 * with Atlassian and can be tested against their sandbox — something only the account
 * holder can do, not this codebase). This module covers what CAN be built and verified
 * offline: the descriptor shape and the JWT/QSH signature-verification Atlassian requires
 * for every Connect request. Wiring Connect-authenticated webhook delivery into the live
 * review pipeline is follow-up work once a real installation exists to test against.
 */

export interface ConnectDescriptorConfig {
  baseUrl: string;
  vendorName?: string;
  vendorUrl?: string;
}

/** The app descriptor Bitbucket fetches at install time — DESIGN.md §4's "Connect app (atlassian-connect.json)". */
export function buildAtlassianConnectDescriptor(cfg: ConnectDescriptorConfig): Record<string, unknown> {
  return {
    key: "codeferret-bitbucket",
    name: "CodeFerret",
    description: "AI code review with verification before anything gets posted.",
    vendor: { name: cfg.vendorName ?? "CodeFerret", url: cfg.vendorUrl ?? cfg.baseUrl },
    baseUrl: cfg.baseUrl,
    authentication: { type: "jwt" },
    lifecycle: {
      installed: "/bitbucket/connect/installed",
      uninstalled: "/bitbucket/connect/uninstalled",
    },
    scopes: ["repository", "pullrequest:write"],
    modules: {
      webhooks: [
        { event: "pullrequest:created", url: "/webhooks/bitbucket" },
        { event: "pullrequest:updated", url: "/webhooks/bitbucket" },
        { event: "pullrequest:comment_created", url: "/webhooks/bitbucket" },
      ],
    },
  };
}

/**
 * QSH ("query string hash") — Atlassian Connect's tamper-check binding a JWT to the
 * exact request it was issued for: canonical METHOD + path + sorted-and-joined query
 * params, sha256 hex. See Atlassian's Connect JWT spec; this is a direct implementation
 * of that canonicalization, not a simplification of it.
 */
export function computeQsh(method: string, path: string, query: Record<string, string | string[] | undefined>): string {
  const canonicalPath = (path.startsWith("/") ? path : `/${path}`).replace(/\/+$/, "") || "/";
  const params = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => (Array.isArray(v) ? v.map((item) => [k, item] as const) : [[k, v as string] as const]))
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalRequest = `${method.toUpperCase()}&${canonicalPath}&${params}`;
  return createHash("sha256").update(canonicalRequest).digest("hex");
}

export type ConnectJwtVerifyResult = { valid: true; clientKey: string } | { valid: false; error: string };

/** Verifies a Connect JWT's signature (against that install's stored shared secret) and its QSH binding to this exact request. */
export function verifyConnectJwt(
  token: string,
  sharedSecret: string,
  method: string,
  path: string,
  query: Record<string, string | string[] | undefined>,
): ConnectJwtVerifyResult {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, sharedSecret, { algorithms: ["HS256"] });
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : "invalid JWT" };
  }
  if (typeof decoded !== "object" || decoded === null) return { valid: false, error: "JWT payload is not an object" };

  const { iss, qsh } = decoded as Record<string, unknown>;
  if (typeof iss !== "string") return { valid: false, error: "JWT is missing the iss (client key) claim" };
  if (typeof qsh !== "string") return { valid: false, error: "JWT is missing the qsh claim" };

  const expectedQsh = computeQsh(method, path, query);
  if (qsh !== expectedQsh) return { valid: false, error: "qsh does not match this request — possible tampering or wrong endpoint" };

  return { valid: true, clientKey: iss };
}
