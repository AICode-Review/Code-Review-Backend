import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { insertContactSubmission } from "../db/repositories.js";
import { env } from "../config.js";
import { emailConfigured, sendEmail } from "../email/smtp.js";
import { contactSubmissionEmail } from "../email/templates.js";

const ContactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  message: z.string().trim().min(1).max(5000),
  // Honeypot — left blank and visually hidden for real visitors. Any value here means a
  // bot filled every field it could find; still reply 200 so it never learns to adapt.
  website: z.string().max(200).optional(),
});

/** Public "Contact us" form (frontend/src/pages/public/Contact.tsx) — the one unauthenticated write route in the API, so it's rate-limited per IP rather than per-org like everything else. */
export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/contact",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 hour" },
      },
    },
    async (req, reply) => {
      const parsed = ContactSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "Invalid submission",
        });
      }

      const { name, email, message, website } = parsed.data;
      if (website) return reply.send({ ok: true });

      await insertContactSubmission(getDb(), { name, email, message });

      const inbox = env().CONTACT_INBOX_EMAIL;
      if (inbox && emailConfigured()) {
        await sendEmail({ to: inbox, ...contactSubmissionEmail({ name, email, message }) });
      }

      return reply.send({ ok: true });
    },
  );
}
