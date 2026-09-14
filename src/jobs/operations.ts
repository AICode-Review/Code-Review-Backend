import { randomUUID } from "node:crypto";
import { getPool } from "../db/postgres.js";

const instance = randomUUID();
/** A single dead worker must not leave a run permanently running after retries exhaust. */
export async function maintainOperations(): Promise<void> {
  const pool = getPool();
  await pool.query(
    "insert into worker_heartbeats(id) values($1) on conflict(id) do update set updated_at=now()",
    [instance],
  );
  // An expired queue job is retried by pg-boss. Only terminal queue failures are finalized here.
  const abandoned =
    await pool.query(`update review_runs r set status='failed',finished_at=now(),
    error=case when r.delivery_started_at is null then 'Worker recovery retries exhausted. Retry this review.'
    else 'Worker interrupted during delivery. Inspect the PR before retrying.' end
    where r.status in ('queued','running') and pg_try_advisory_xact_lock(hashtextextended('review:' || r.id::text,0)) and exists (
      select 1 from pgboss.job j where j.name='review.run' and j.state='failed'
        and coalesce(j.data->>'runId',j.id::text)=r.id::text
    ) returning r.id`);
  if (abandoned.rowCount)
    console.error("[operations] exhausted review jobs", {
      runIds: abandoned.rows.map((row) => row.id),
    });
  const lag = await pool.query(
    "select count(*)::int as count from pgboss.job where state in ('created','retry') and start_after < now()-interval '10 minutes'",
  );
  if (lag.rows[0]?.count)
    console.error("[operations] queue processing delayed", {
      count: lag.rows[0].count,
    });
  await pool.query(
    "delete from worker_heartbeats where updated_at < now()-interval '1 day'",
  );
}

/** Readiness includes DB access, all queue tables, required migration and a live worker. */
export async function checkReadiness(): Promise<boolean> {
  const result = await getPool().query(`select
    exists(select 1 from schema_migrations where name='0021_launch_reliability.sql') and
    exists(select 1 from worker_heartbeats where updated_at > now()-interval '3 minutes') and
    (select count(*) from pgboss.queue where name in ('review.run','webhook.event','operations.maintenance'))=3 as ready`);
  return result.rows[0]?.ready === true;
}
