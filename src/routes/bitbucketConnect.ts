import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { decryptToken, encryptToken, encryptionConfigured } from "../security/tokenCrypto.js";
import { buildAtlassianConnectDescriptor, verifyConnectJwt } from "../adapters/bitbucket/connect.js";
import { env } from "../config.js";

const InstalledPayloadSchema = z.object({
  key: z.string(),
  clientKey: z.string(),
  sharedSecret: z.string(),
  baseUrl: z.string(),
  displayUrl: z.string().optional(),
  productType: z.string().optional(),
});

/**
 * Atlassian Connect app scaffolding (DESIGN.md §4) — additive alongside the existing
 * manual-workspace-token Bitbucket flow (routes/webhooks.ts's /webhooks/bitbucket +
 * connectBitbucketWorkspace), which stays the real install path until this is registered
 * with Atlassian and can be exercised against a real installation.
 */
export function bitbucketConnectRoutes(app: FastifyInstance): void {
  app.get("/bitbucket/atlassian-connect.json", async (_req, reply) => {
    const baseUrl = env().BACKEND_PUBLIC_URL;
    if (!baseUrl) return reply.code(503).send({ error: "BACKEND_PUBLIC_URL is not configured — set it before registering this app with Atlassian" });
    return reply.send(buildAtlassianConnectDescriptor({ baseUrl }));
  });

  app.post("/bitbucket/connect/installed", async (req, reply) => {
    if (!encryptionConfigured()) return reply.code(503).send({ error: "ENCRYPTION_KEY is not configured" });
    const parsed = InstalledPayloadSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    // The first `installed` callback for a given clientKey is, by Atlassian's own Connect
    // spec, unauthenticated — there's no shared secret yet to verify a JWT against. We
    // trust the bootstrap payload as-is, exactly as Atlassian's reference apps do.
    const db = getDb();
    const { clientKey, sharedSecret, baseUrl, displayUrl, productType } = parsed.data;
    const { error } = await db.from("bitbucket_connect_installations").upsert(
      {
        client_key: clientKey,
        encrypted_secret: encryptToken(sharedSecret),
        base_url: baseUrl,
        display_url: displayUrl ?? null,
        product_type: productType ?? null,
      },
      { onConflict: "client_key" },
    );
    if (error) return reply.code(500).send({ error: error.message });
    return reply.code(204).send();
  });

  app.post("/bitbucket/connect/uninstalled", async (req, reply) => {
    const parsed = InstalledPayloadSchema.pick({ clientKey: true }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const { data: install } = await db
      .from("bitbucket_connect_installations")
      .select("encrypted_secret")
      .eq("client_key", parsed.data.clientKey)
      .maybeSingle();
    if (!install) return reply.code(204).send(); // already gone — idempotent

    const authHeader = req.headers["authorization"];
    const token = typeof authHeader === "string" ? authHeader.replace(/^JWT\s+/i, "") : undefined;
    if (!token) return reply.code(401).send({ error: "missing JWT" });

    const sharedSecret = decryptToken(install["encrypted_secret"] as string);
    const path = req.url.split("?")[0] ?? req.url;
    const result = verifyConnectJwt(token, sharedSecret, req.method, path, req.query as Record<string, string>);
    if (!result.valid) return reply.code(401).send({ error: result.error });

    await db.from("bitbucket_connect_installations").delete().eq("client_key", parsed.data.clientKey);
    return reply.code(204).send();
  });
}
