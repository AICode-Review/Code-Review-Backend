import { randomUUID } from "node:crypto";
import {
  NormalizedEventSchema,
  type NormalizedEvent,
} from "../types/domain.js";
import { withTransaction, transactionDb } from "../db/postgres.js";
import { getBoss, JOBS } from "./index.js";

/** The deduplication marker and queued event commit together or neither does. */
export async function acceptWebhook(
  platform: string,
  deliveryId: unknown,
  event: NormalizedEvent,
): Promise<boolean> {
  const parsed = NormalizedEventSchema.parse(event);
  const boss = await getBoss(); // queue initialization must finish before opening the transaction
  const id =
    typeof deliveryId === "string" && deliveryId ? deliveryId : randomUUID();
  return withTransaction(async (client) => {
    const claim = await client.query(
      "insert into webhook_deliveries(platform,delivery_id) values($1,$2) on conflict do nothing returning delivery_id",
      [platform, id],
    );
    if (!claim.rowCount) return false;
    const queued = await boss.send(JOBS.webhookEvent, parsed, {
      db: transactionDb(),
      retryLimit: 5,
      retryDelay: 15,
      retryBackoff: true,
    });
    if (!queued) throw new Error("Webhook could not be queued");
    return true;
  });
}

/** Dispatch retries cannot enqueue child work twice. Domain upserts are idempotent. */
export async function dispatchWebhook(
  id: string,
  handle: () => Promise<void>,
): Promise<void> {
  await withTransaction(async (client) => {
    const claim = await client.query(
      "insert into webhook_deliveries(platform,delivery_id) values('dispatch',$1) on conflict do nothing returning delivery_id",
      [id],
    );
    if (claim.rowCount) await handle();
  });
}
