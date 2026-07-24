import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { requireAdmin } from "../auth/plugin.js";
import type { AuthedUser } from "../auth/verifyUser.js";
import { cancelOrgSubscription, changeOrgSubscriptionPlan } from "../billing/razorpaySubscriptions.js";
import { recordAudit } from "../db/repositories.js";
import {
  countPlatformAdmins,
  getOrgAdminDetail,
  getPlatformOverview,
  listAuditLogAdmin,
  listOrgsAdmin,
  getRunAdmin,
  listRunsAdmin,
  listSubscriptionsAdmin,
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

const PlatformAdminSchema = z.object({
  isPlatformAdmin: z.boolean(),
});

const ChangePlanSchema = z.object({
  tier: z.enum(["pro", "team"]),
});

/** Platform admin console — cross-org reads + operator writes, gated by requireAdmin. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/admin/overview", async (_req, reply) => {
    const overview = await getPlatformOverview(getDb());
    return reply.send(overview);
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

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/admin/users/:id", async (req, reply) => {
    const parsed = PlatformAdminSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const db = getDb();
    const targetId = req.params.id;
    const actor = req.authedUser!;

    if (!parsed.data.isPlatformAdmin && targetId === actor.id) {
      const admins = await countPlatformAdmins(db);
      if (admins <= 1) {
        return reply.code(400).send({ error: "cannot revoke the last platform admin" });
      }
    }

    const result = await setPlatformAdminFlag(db, targetId, parsed.data.isPlatformAdmin);
    if (!result) return reply.code(404).send({ error: "user not found" });

    await recordAudit(
      db,
      null,
      actorLabel(actor),
      parsed.data.isPlatformAdmin ? "platform.admin_granted" : "platform.admin_revoked",
      targetId,
      { via: "admin" },
    );
    return reply.send(result);
  });

  app.get("/api/admin/billing", async (_req, reply) => {
    const subscriptions = await listSubscriptionsAdmin(getDb());
    return reply.send({ subscriptions });
  });

  app.get<{ Querystring: { before?: string; limit?: string } }>("/api/admin/runs", async (req, reply) => {
    const limit = req.query.limit ? Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50)) : undefined;
    const runs = await listRunsAdmin(getDb(), { before: req.query.before, limit });
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
