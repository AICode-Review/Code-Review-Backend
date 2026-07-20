import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyBearerToken, type AuthedUser } from "./verifyUser.js";

declare module "fastify" {
  interface FastifyRequest {
    authedUser?: AuthedUser;
  }
}

/** preHandler for every /api/* route — Bearer <supabase JWT> → AuthedUser, or 401. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    await reply.code(401).send({ error: "missing bearer token" });
    return;
  }
  const user = await verifyBearerToken(token).catch(() => null);
  if (!user) {
    await reply.code(401).send({ error: "invalid or expired session" });
    return;
  }
  req.authedUser = user;
}

/** preHandler for every /api/admin/* route — same bearer-token verification as requireAuth, plus a platform-admin check. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (!req.authedUser?.isPlatformAdmin) {
    await reply.code(403).send({ error: "admin access required" });
  }
}
