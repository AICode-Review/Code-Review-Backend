import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env } from "./config.js";
import { verifyLicense } from "./license.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { razorpayWebhookRoutes } from "./routes/razorpayWebhook.js";
import { apiRoutes } from "./routes/api.js";
import { adminRoutes } from "./routes/admin.js";
import { bitbucketConnectRoutes } from "./routes/bitbucketConnect.js";
import { stopBoss } from "./queue/index.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function buildServer() {
  const app = Fastify({
    logger: { level: env().NODE_ENV === "production" ? "info" : "debug" },
  });

  app.register(cors, {
    origin: env().NODE_ENV === "production" ? (process.env["CORS_ORIGIN"]?.split(",") ?? false) : true,
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
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      done(err as Error);
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.register(webhookRoutes);
  app.register(razorpayWebhookRoutes);
  app.register(apiRoutes);
  app.register(adminRoutes);
  app.register(bitbucketConnectRoutes);

  return app;
}

const app = buildServer();

const license = verifyLicense();
if (!license.valid) {
  app.log.fatal(`Self-hosted license check failed: ${license.error}`);
  process.exit(1);
}

app.listen({ port: env().PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await stopBoss();
    process.exit(0);
  });
}
