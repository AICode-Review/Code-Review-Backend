import { pathToFileURL } from "node:url";
import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "./config.js";
import { verifyLicense } from "./license.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { razorpayWebhookRoutes } from "./routes/razorpayWebhook.js";
import { apiRoutes } from "./routes/api.js";
import { adminRoutes } from "./routes/admin.js";
import { bitbucketConnectRoutes } from "./routes/bitbucketConnect.js";
import { contactRoutes } from "./routes/contact.js";
import { trackRoutes } from "./routes/track.js";
import { checkReadiness } from "./jobs/operations.js";
import { stopPool } from "./db/postgres.js";
import { stopBoss } from "./queue/index.js";
import { captureError, initSentry } from "./observability/sentry.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function buildServer() {
  const app = Fastify({
    logger: {
      level: env().NODE_ENV === "production" ? "info" : "debug",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers",
      ],
    },
  });

  app.register(cors, {
    origin:
      env().NODE_ENV === "production"
        ? (process.env["CORS_ORIGIN"]?.split(",").map((o) => o.trim()) ?? false)
        : true,
  });

  // Baseline abuse protection for every route. The GitHub webhook route
  // overrides this with a per-installation key (see routes/webhooks.ts) —
  // DESIGN.md §9's "rate limiting per installation" — since one misbehaving
  // installation shouldn't be able to starve webhook processing for anyone else.
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });

  // Keep the raw body around for webhook signature verification.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      if ((body as Buffer).length === 0) return done(null, {});
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch (err) {
        done(Object.assign(err as Error, { statusCode: 400 }));
      }
    },
  );

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      error.statusCode && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error(
        { err: error, requestId: request.id },
        "Request failed",
      );
      captureError(error, {
        url: request.routeOptions.url ?? request.url.split("?")[0],
        method: request.method,
      });
      return reply.status(statusCode).send({
        error: "Internal server error",
        message: "The request could not be completed. Please retry.",
        requestId: request.id,
      });
    }
    return reply.status(statusCode).send(error);
  });

  app.get("/healthz", async () => ({ ok: true }));
  // TEMPORARY diagnostic route (2026-09-16) — isolates whether the confirmed embeddings-call
  // hang (getContext -> embedTexts -> client.embeddings.create) is specific to running inside
  // a pg-boss worker job, or reproduces from a plain HTTP request handler too. Bypasses the
  // whole webhook -> queue -> worker cycle so a test takes seconds instead of minutes. Gated by
  // a throwaway token (not a real secret) purely to keep it off search engines/crawlers — this
  // route is removed once the real hang is found. Remove before considering this done.
  app.get("/debug/embed-test", async (req, reply) => {
    const query = req.query as { token?: string };
    if (query.token !== "diag-embed-2026-09-16") return reply.code(404).send();
    const { embedTexts } = await import("./indexer/embeddings.js");
    const startedAt = Date.now();
    try {
      const result = await embedTexts(["hello world, this is a diagnostic embedding test"]);
      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        vectorCount: result.vectors.length,
        vectorLength: result.vectors[0]?.length ?? 0,
        costUsd: result.costUsd,
      };
    } catch (err) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
  });
  app.get("/readyz", async (_req, reply) => {
    try {
      if (await checkReadiness()) return { ok: true };
    } catch {
      /* Readiness must not expose infrastructure or credential details. */
    }
    return reply.code(503).send({ ok: false });
  });

  app.register(webhookRoutes);
  app.register(razorpayWebhookRoutes);
  app.register(apiRoutes);
  app.register(adminRoutes);
  app.register(bitbucketConnectRoutes);
  app.register(contactRoutes);
  app.register(trackRoutes);

  return app;
}

export const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1] as string).href;

if (isMainModule) {
  initSentry();
  const app = buildServer();

  const license = verifyLicense();
  if (!license.valid) {
    app.log.fatal(`Self-hosted license check failed: ${license.error}`);
    process.exit(1);
  }

  app.listen({ port: env().PORT, host: "0.0.0.0" }).catch((err) => {
    captureError(err);
    app.log.error(err);
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    captureError(err);
    app.log.fatal(err, "uncaughtException");
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    captureError(err);
    app.log.error(err, "unhandledRejection");
    process.exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      await app.close();
      await stopBoss();
      await stopPool();
      process.exit(0);
    });
  }
}
