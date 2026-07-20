import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { getAdapter } from "../adapters/index.js";
import { getDb } from "../db/client.js";
import { clearOrgInstallation, recordDelivery, upsertInstalledOrg, upsertRepoRef } from "../db/repositories.js";
import { enqueueChatReply, enqueueIndexRepo, enqueueReviewRun } from "../queue/index.js";
import type { NormalizedEvent } from "../types/domain.js";

/**
 * Webhook handlers do ZERO inline work: verify signature → normalize → enqueue → 200.
 * (DESIGN.md §9)
 */
/** Keys the webhook rate limit by GitHub installation id (present on nearly every event payload once the App is installed) rather than IP, so one noisy/misbehaving installation can't starve webhook processing for everyone else. */
export function installationRateLimitKey(req: { body?: unknown; ip: string }): string {
  const body = req.body as { installation?: { id?: number } } | undefined;
  const installationId = body?.installation?.id;
  return installationId !== undefined ? `gh-install-${installationId}` : req.ip;
}

/** Keys the Bitbucket webhook rate limit by workspace UUID (present on every event's repository.workspace) rather than IP. */
export function workspaceRateLimitKey(req: { body?: unknown; ip: string }): string {
  const body = req.body as { repository?: { workspace?: { uuid?: string } } } | undefined;
  const workspaceUuid = body?.repository?.workspace?.uuid;
  return workspaceUuid ? `bb-workspace-${workspaceUuid}` : req.ip;
}

/** Shared normalize→enqueue handling for every platform's webhook route. Only GitHub emits "installed"/"uninstalled" — Bitbucket workspaces are connected via the REST /api/bitbucket/connect route instead, so those cases are simply unreachable there. */
async function handleNormalizedEvent(event: NormalizedEvent, log: FastifyBaseLogger): Promise<void> {
  switch (event.kind) {
    case "pr_opened":
    case "pr_updated":
      await enqueueReviewRun({ pr: event.pr, headSha: event.headSha, reason: event.kind });
      return;
    case "command":
      if (event.command === "review") {
        await enqueueReviewRun({
          pr: event.pr,
          headSha: "", // worker resolves head sha when it runs
          reason: "command",
        });
      }
      // pause/resume/resolve land with feedback capture (Phase A step 6)
      return;
    case "installed": {
      // Authoritative org creation — "User" installs become an individual org,
      // "Organization" installs become a team org; the installer is recorded
      // so they're auto-granted ownership on their next sign-in (see auth/verifyUser.ts).
      const { repoIds } = await upsertInstalledOrg(getDb(), event.org, event.repos, event.installationId, event.accountType, event.installedBy);
      // DESIGN.md §7 — index every granted repo on install.
      for (const repoId of repoIds) await enqueueIndexRepo({ repoId, reason: "installed" });
      return;
    }
    case "uninstalled":
      // Non-destructive: keep all review history, just clear the installation link.
      await clearOrgInstallation(getDb(), event.org);
      return;
    case "repo_pushed": {
      // DESIGN.md §7 — re-index on every push to the default branch.
      const { repoId } = await upsertRepoRef(getDb(), event.repo);
      await enqueueIndexRepo({ repoId, reason: "push" });
      return;
    }
    case "feedback":
      if (event.type === "reply") {
        // Chat-with-reviewer (DESIGN.md §6.7) — queued, never handled inline.
        await enqueueChatReply({
          pr: event.pr,
          commentId: event.commentId,
          body: event.body ?? "",
          requireFinding: event.scope !== "general",
        });
      } else {
        // Reaction/dismiss-driven feedback capture (comment 👍/👎) is a later step;
        // finding feedback today goes through POST /api/findings/:id/feedback instead.
        log.info({ kind: event.kind, type: event.type }, "feedback event acknowledged (webhook-driven capture not yet implemented for this type)");
      }
      return;
  }
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/webhooks/github",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: installationRateLimitKey,
        },
      },
    },
    async (req, reply) => {
    const adapter = getAdapter("github");

    if (!req.rawBody || !adapter.verifyWebhook(req.headers, req.rawBody)) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const deliveryId = req.headers["x-github-delivery"];
    if (typeof deliveryId === "string" && deliveryId.length > 0) {
      const fresh = await recordDelivery(getDb(), "github", deliveryId);
      if (!fresh) return reply.send({ ok: true, duplicate: true });
    }

    const event = adapter.parseEvent({ name: req.headers["x-github-event"], payload: req.body });
    if (!event) return reply.send({ ok: true, ignored: true });

    await handleNormalizedEvent(event, req.log);
    return reply.send({ ok: true });
  });

  app.post(
    "/webhooks/bitbucket",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: workspaceRateLimitKey,
        },
      },
    },
    async (req, reply) => {
    const adapter = getAdapter("bitbucket");

    if (!req.rawBody || !adapter.verifyWebhook(req.headers, req.rawBody)) {
      return reply.code(401).send({ error: "invalid signature" });
    }

    const deliveryId = req.headers["x-request-uuid"];
    if (typeof deliveryId === "string" && deliveryId.length > 0) {
      const fresh = await recordDelivery(getDb(), "bitbucket", deliveryId);
      if (!fresh) return reply.send({ ok: true, duplicate: true });
    }

    const event = adapter.parseEvent({ name: req.headers["x-event-key"], payload: req.body });
    if (!event) return reply.send({ ok: true, ignored: true });

    await handleNormalizedEvent(event, req.log);
    return reply.send({ ok: true });
  });
}
