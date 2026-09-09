import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/client.js";

const TrackVisitSchema = z.object({
  /** Client-generated (frontend/src/lib/tracking.ts, localStorage) — never tied to an
   * account, so a visitor is countable across page loads without any sign-in. */
  visitorId: z.string().uuid(),
  path: z.string().trim().min(1).max(500),
});

/**
 * Public "how many people visited the marketing site" beacon (console's Visitors panel) —
 * the one other unauthenticated write route in the API besides /api/contact, so it gets the
 * same per-IP rate limit rather than the per-org one everything else uses. Always replies
 * 200 even on a validation failure — a tracking beacon must never surface an error to a
 * real visitor or retry-storm the endpoint, and losing an occasional malformed ping costs
 * nothing.
 */
export async function trackRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/track/visit",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const parsed = TrackVisitSchema.safeParse(req.body);
      if (!parsed.success) return reply.send({ ok: true });

      await getDb().from("site_visits").insert({ visitor_id: parsed.data.visitorId, path: parsed.data.path });
      return reply.send({ ok: true });
    },
  );
}
