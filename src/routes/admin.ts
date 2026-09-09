import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { requireAdmin } from "../auth/plugin.js";
import type { AuthedUser } from "../auth/verifyUser.js";
import { cancelOrgSubscription, changeOrgSubscriptionPlan } from "../billing/razorpaySubscriptions.js";
import { recordAudit } from "../db/repositories.js";
import {
  countPlatformAdmins,
  findUserForAdminGrant,
  getOrgAdminDetail,
  getPlatformOverview,
  getVisitorStats,
  listAuditLogAdmin,
  listOrgsAdmin,
  getRunAdmin,
  listRunsAdmin,
  listSubscriptionsAdmin,
  listPlatformAdmins,
  listUsersAdmin,
  setPlatformAdminFlag,
  suspendOrgAdmin,
  unsuspendOrgAdmin,
} from "../db/adminRepositories.js";

function actorLabel(user: AuthedUser): string {
  return user.email ?? user.id;
}

const SuspendSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const AddPlatformAdminSchema = z
  .object({
    userId: z.string().min(1).optional(),
    email: z.string().trim().email().optional(),
  })
  .refine((d) => Boolean(d.userId) !== Boolean(d.email), {
    message: "provide exactly one of userId or email",
  });

const PlatformAdminSchema = z.object({
  isPlatformAdmin: z.boolean(),
});

const ChangePlanSchema = z.object({
  tier: z.enum(["pro", "team"]),
});

type AdminWriteResult =
  | { ok: true; status: 200 | 201; body: { id: string; isPlatformAdmin: boolean } }
  | { ok: false; status: 400 | 404 | 409; error: string };

async function grantPlatformAdmin(
  actor: AuthedUser,
  lookup: { userId?: string; email?: string },
  created: boolean,
): Promise<AdminWriteResult> {
  const db = getDb();
  const target = await findUserForAdminGrant(db, lookup);
  if (!target) {
    return {
      ok: false,
      status: 404,
      error: lookup.email
        ? "no signed-in user with that email — they must sign in to the app first"
        : "user not found",
    };
  }
  if (target.isPlatformAdmin) return { ok: false, status: 409, error: "already a platform admin" };
  const result = await setPlatformAdminFlag(db, target.id, true);
  if (!result) return { ok: false, status: 404, error: "user not found" };
  await recordAudit(db, null, actorLabel(actor), "platform.admin_granted", target.id, { via: "admin" });
  return { ok: true, status: created ? 201 : 200, body: result };
}

async function revokePlatformAdmin(actor: AuthedUser, targetId: string): Promise<AdminWriteResult> {
  const db = getDb();
  const target = await findUserForAdminGrant(db, { userId: targetId });
  if (!target) return { ok: false, status: 404, error: "user not found" };
  if (!target.isPlatformAdmin) return { ok: false, status: 404, error: "not a platform admin" };
  if ((await countPlatformAdmins(db)) <= 1) {
    return { ok: false, status: 400, error: "cannot revoke the last platform admin" };
  }
  const result = await setPlatformAdminFlag(db, targetId, false);
  if (!result) return { ok: false, status: 404, error: "user not found" };
  await recordAudit(db, null, actorLabel(actor), "platform.admin_revoked", targetId, { via: "admin" });
  return { ok: true, status: 200, body: result };
}

/** Platform admin console — cross-org reads + operator writes, gated by requireAdmin. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/admin/overview", async (_req, reply) => {
    const overview = await getPlatformOverview(getDb());
    return reply.send(overview);
  });

  app.get<{ Querystring: { since?: string } }>("/api/admin/visitors", async (req, reply) => {
    const since = req.query.since ? new Date(req.query.since) : new Date(0);
    if (Number.isNaN(since.getTime())) return reply.code(400).send({ error: "invalid since" });
    const stats = await getVisitorStats(getDb(), since);
    return reply.send(stats);
  });

  app.get("/api/admin/me", async (req, reply) => {
    const user = req.authedUser!;
    return reply.send({ id: user.id, email: user.email, isPlatformAdmin: user.isPlatformAdmin });
  });

  app.get("/api/admin/orgs", async (_req, reply) => {
    const orgs = await listOrgsAdmin(getDb());
    return reply.send({ orgs });
  });

  app.get<{ Params: { id: string } }>("/api/admin/orgs/:id", async (req, reply) => {
    const detail = await getOrgAdminDetail(getDb(), req.params.id);
    if (!detail) return reply.code(404).send({ error: "org not found" });
    return reply.send(detail);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/admin/orgs/:id/suspend", async (req, reply) => {
    const parsed = SuspendSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const orgId = req.params.id;
    const reason = parsed.data.reason?.length ? parsed.data.reason : null;
    const result = await suspendOrgAdmin(db, orgId, reason);
    if (!result) return reply.code(404).send({ error: "org not found" });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "org.suspended", orgId, {
      via: "admin",
      reason,
    });
    return reply.send(result);
  });

  app.post<{ Params: { id: string } }>("/api/admin/orgs/:id/unsuspend", async (req, reply) => {
    const db = getDb();
    const orgId = req.params.id;
    const result = await unsuspendOrgAdmin(db, orgId);
    if (!result) return reply.code(404).send({ error: "org not found" });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "org.unsuspended", orgId, { via: "admin" });
    return reply.send(result);
  });

  app.post<{ Params: { id: string } }>("/api/admin/orgs/:id/billing/cancel", async (req, reply) => {
    const db = getDb();
    const orgId = req.params.id;
    const result = await cancelOrgSubscription(db, orgId);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "billing.cancel_requested", result.razorpaySubId, {
      via: "admin",
    });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/admin/orgs/:id/billing/change-plan", async (req, reply) => {
    const parsed = ChangePlanSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const orgId = req.params.id;
    const result = await changeOrgSubscriptionPlan(db, orgId, parsed.data.tier);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });

    await recordAudit(db, orgId, actorLabel(req.authedUser!), "billing.plan_changed", parsed.data.tier, {
      via: "admin",
    });
    return reply.send({ ok: true });
  });

  app.get("/api/admin/users", async (_req, reply) => {
    const users = await listUsersAdmin(getDb());
    return reply.send({ users });
  });

  app.get("/api/admin/admins", async (_req, reply) => {
    const admins = await listPlatformAdmins(getDb());
    return reply.send({ admins });
  });

  app.post<{ Body: unknown }>("/api/admin/admins", async (req, reply) => {
    const parsed = AddPlatformAdminSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const result = await grantPlatformAdmin(req.authedUser!, parsed.data, true);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.code(result.status).send(result.body);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/admins/:id", async (req, reply) => {
    const result = await revokePlatformAdmin(req.authedUser!, req.params.id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.send(result.body);
  });

  /** @deprecated Prefer POST/DELETE /api/admin/admins — kept so an older console deploy still works. */
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/admin/users/:id", async (req, reply) => {
    const parsed = PlatformAdminSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const result = parsed.data.isPlatformAdmin
      ? await grantPlatformAdmin(req.authedUser!, { userId: req.params.id }, false)
      : await revokePlatformAdmin(req.authedUser!, req.params.id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.send(result.body);
  });

  app.get("/api/admin/billing", async (_req, reply) => {
    const subscriptions = await listSubscriptionsAdmin(getDb());
    return reply.send({ subscriptions });
  });

  app.get<{ Querystring: { before?: string; limit?: string; since?: string } }>("/api/admin/runs", async (req, reply) => {
    const limit = req.query.limit ? Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50)) : undefined;
    const runs = await listRunsAdmin(getDb(), { before: req.query.before, limit, since: req.query.since });
    return reply.send({ runs });
  });

  app.get<{ Params: { id: string } }>("/api/admin/runs/:id", async (req, reply) => {
    const run = await getRunAdmin(getDb(), req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return reply.send(run);
  });

  app.get<{ Querystring: { before?: string; limit?: string } }>("/api/admin/audit", async (req, reply) => {
    const limit = req.query.limit ? Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50)) : undefined;
    const entries = await listAuditLogAdmin(getDb(), { before: req.query.before, limit });
    return reply.send({ entries });
  });
}
