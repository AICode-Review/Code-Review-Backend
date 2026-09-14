import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type PgBoss from "pg-boss";

const testUrl = process.env.LAUNCH_TEST_DATABASE_URL;
/** Requires an EMPTY dedicated local database; never inherits DATABASE_URL/.env. */
describe.skipIf(!testUrl)("launch reliability against real PostgreSQL", () => {
  let pool: pg.Pool;
  let boss: PgBoss;
  let queue: typeof import("../queue/index.js");
  let postgres: typeof import("./postgres.js");
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/^\/scrutinye_test_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error(
        "Integration tests require a dedicated local scrutinye_test_* database",
      );
    pool = new pg.Pool({ connectionString: testUrl, max: 16 });
    const existing = await pool.query(
      "select tablename from pg_tables where schemaname='public'",
    );
    if (existing.rowCount)
      throw new Error("Refusing to initialize a nonempty test database");
    await pool.query(`
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
      end $$;
      create table orgs(id uuid primary key);
      create table repos(id uuid primary key,org_id uuid references orgs);
      create table pull_requests(id uuid primary key,repo_id uuid references repos);
      create table review_runs(id uuid primary key default gen_random_uuid(),pr_id uuid references pull_requests,head_sha text not null default 'sha',status text not null default 'queued',trigger text default 'automatic',source_run_id uuid,
        started_at timestamptz not null default now(),finished_at timestamptz,blocked_reason text,error text,llm_cost_usd numeric not null default 0);
      create table webhook_deliveries(platform text not null,delivery_id text not null,received_at timestamptz default now(),primary key(platform,delivery_id));
      create table schema_migrations(name text primary key);
    `);
    await pool.query(
      await readFile(
        new URL("./migrations/0021_launch_reliability.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query(
      "insert into schema_migrations values('0021_launch_reliability.sql')",
    );
    process.env.DATABASE_URL = testUrl;
    vi.resetModules();
    postgres = await import("./postgres.js");
    queue = await import("../queue/index.js");
    boss = await queue.getBoss();
  }, 30000);
  afterAll(async () => {
    await queue?.stopBoss();
    await postgres?.stopPool();
    await pool?.end();
  });
  async function pr() {
    const orgId = randomUUID(),
      repoId = randomUUID(),
      prId = randomUUID();
    await pool.query("insert into orgs values($1)", [orgId]);
    await pool.query("insert into repos values($1,$2)", [repoId, orgId]);
    await pool.query("insert into pull_requests values($1,$2)", [prId, repoId]);
    return prId;
  }
  const insert = (prId: string, limit = 1) =>
    pool.query(
      "insert into review_runs(pr_id,status,quota_limit) values($1,'running',$2) returning *",
      [prId, limit],
    );
  const event = {
    kind: "pr_opened" as const,
    headSha: "sha",
    pr: {
      number: 1,
      repo: {
        platform: "github" as const,
        externalId: "test",
        owner: "test",
        name: "test",
        orgExternalId: "test",
        orgName: "test",
      },
    },
  };

  it("admits exactly one of eight simultaneous claims for the last quota slot", async () => {
    const id = await pr();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => insert(id)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected")
        expect(String(r.reason)).toContain("monthly_quota_exceeded");
  });
  it("fails closed when admission configuration is missing and explicitly supports unlimited plans", async () => {
    const id = await pr();
    await expect(
      pool.query("insert into review_runs(pr_id,status) values($1,'running')", [
        id,
      ]),
    ).rejects.toThrow("quota_configuration_missing");
    expect((await insert(id, -1)).rowCount).toBe(1);
    expect((await insert(id, -1)).rowCount).toBe(1);
  });
  it("rolls back every child job if webhook dispatch is interrupted", async () => {
    const { dispatchWebhook } = await import("../queue/webhookInbox.js");
    const id = randomUUID();
    await expect(
      dispatchWebhook(id, async () => {
        await queue.enqueueChatReply({
          pr: event.pr,
          commentId: id,
          body: "test",
          requireFinding: true,
        });
        throw new Error("interrupted dispatch");
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "select * from pgboss.job where name='chat.reply' and data->>'commentId'=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    await dispatchWebhook(id, () =>
      queue
        .enqueueChatReply({
          pr: event.pr,
          commentId: id,
          body: "test",
          requireFinding: true,
        })
        .then(() => {}),
    );
    await dispatchWebhook(id, () => {
      throw new Error("must not dispatch twice");
    });
    expect(
      (
        await pool.query(
          "select * from pgboss.job where name='chat.reply' and data->>'commentId'=$1",
          [id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("does not count queued work and preserves a recovered run's reservation", async () => {
    const id = await pr();
    await pool.query("insert into review_runs(pr_id) values($1),($1)", [id]);
    const run = (await insert(id)).rows[0];
    await pool.query("update review_runs set status='queued' where id=$1", [
      run.id,
    ]);
    await pool.query("update review_runs set status='running' where id=$1", [
      run.id,
    ]);
    expect(
      (
        await pool.query(
          "select quota_reserved_at from review_runs where id=$1",
          [run.id],
        )
      ).rows[0].quota_reserved_at,
    ).toEqual(run.quota_reserved_at);
    await expect(insert(id)).rejects.toThrow("monthly_quota_exceeded");
  });
  it("rolls back an uncommitted reservation and frees the slot", async () => {
    const id = await pr(),
      client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "insert into review_runs(pr_id,status,quota_limit) values($1,'running',1)",
        [id],
      );
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect((await insert(id)).rowCount).toBe(1);
  });
  it("refunds a known zero-cost failure but retains an ambiguous delivery reservation", async () => {
    const id = await pr(),
      first = (await insert(id)).rows[0];
    await pool.query("update review_runs set status='failed' where id=$1", [
      first.id,
    ]);
    const second = (await insert(id)).rows[0];
    await pool.query(
      "update review_runs set status='failed',delivery_started_at=now() where id=$1",
      [second.id],
    );
    await expect(insert(id)).rejects.toThrow("monthly_quota_exceeded");
  });
  it("commits webhook deduplication and enqueue together", async () => {
    const { acceptWebhook } = await import("../queue/webhookInbox.js");
    const id = randomUUID();
    const send = vi
      .spyOn(boss, "send")
      .mockRejectedValueOnce(new Error("injected queue failure"));
    await expect(acceptWebhook("github", id, event)).rejects.toThrow();
    send.mockRestore();
    expect(
      (
        await pool.query(
          "select * from webhook_deliveries where delivery_id=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    expect(await acceptWebhook("github", id, event)).toBe(true);
    expect(await acceptWebhook("github", id, event)).toBe(false);
    expect(
      (await pool.query("select * from pgboss.job where name='webhook.event'"))
        .rowCount,
    ).toBe(1);
  });
  it("loses neither a marker nor a job on database-session death before commit", async () => {
    const client = new pg.Client({connectionString:testUrl}),
      id = randomUUID();
    client.on("error", () => {});
    await client.connect();
    try {
      const pid = (await client.query("select pg_backend_pid() as pid")).rows[0]
        .pid;
      await client.query("begin");
      await client.query(
        "insert into webhook_deliveries(platform,delivery_id) values('github',$1)",
        [id],
      );
      await boss.send(queue.JOBS.webhookEvent, event, {
        db: { executeSql: (sql, values) => client.query(sql, values) },
      });
      await pool.query("select pg_terminate_backend($1)", [pid]);
    } finally {
      await client.end().catch(() => undefined);
    }
    expect(
      (
        await pool.query(
          "select * from webhook_deliveries where delivery_id=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    // Only the previous test's committed event remains.
    expect(
      (await pool.query("select * from pgboss.job where name='webhook.event'"))
        .rowCount,
    ).toBe(1);
  });
  it("rolls back manual run creation when enqueue fails", async () => {
    const id = await pr();
    const send = vi
      .spyOn(boss, "send")
      .mockRejectedValueOnce(new Error("injected queue failure"));
    await expect(
      queue.createQueuedReview(id, {
        pr: event.pr,
        headSha: "sha",
        reason: "manual",
      }),
    ).rejects.toThrow();
    send.mockRestore();
    expect(
      (await pool.query("select * from review_runs where pr_id=$1", [id]))
        .rowCount,
    ).toBe(0);
    const runId = await queue.createQueuedReview(id, {
      pr: event.pr,
      headSha: "sha",
      reason: "manual",
    });
    expect(
      (
        await pool.query("select * from pgboss.job where data->>'runId'=$1", [
          runId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("permits one recovery owner and releases ownership when its session ends", async () => {
    const first = await pool.connect(),
      second = await pool.connect(),
      key = randomUUID();
    try {
      expect(
        (
          await first.query(
            "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
            [key],
          )
        ).rows[0].locked,
      ).toBe(true);
      expect(
        (
          await second.query(
            "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
            [key],
          )
        ).rows[0].locked,
      ).toBe(false);
      await first.query("select pg_advisory_unlock(hashtextextended($1,0))", [
        key,
      ]);
      expect(
        (
          await second.query(
            "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
            [key],
          )
        ).rows[0].locked,
      ).toBe(true);
      await second.query("select pg_advisory_unlock(hashtextextended($1,0))", [
        key,
      ]);
    } finally {
      first.release();
      second.release();
    }
  });
  it("recovers interrupted analysis and finalizes uncertain delivery without replaying it", async () => {
    const { recoverRun } = await import("../jobs/reviewRecovery.js");
    const id = await pr(),
      run = (await insert(id)).rows[0],
      client = await pool.connect();
    try {
      expect(await recoverRun(client, run.id)).toBe("run");
      await client.query(
        "update review_runs set status='running',delivery_started_at=now() where id=$1",
        [run.id],
      );
      expect(await recoverRun(client, run.id)).toBe("uncertain");
      expect(await recoverRun(client, run.id)).toBe("terminal");
    } finally {
      client.release();
    }
  });
  it("requires a current worker heartbeat for readiness", async () => {
    const { checkReadiness, maintainOperations } =
      await import("../jobs/operations.js");
    expect(await checkReadiness()).toBe(false);
    await maintainOperations();
    expect(await checkReadiness()).toBe(true);
    await pool.query(
      "update worker_heartbeats set updated_at=now()-interval '5 minutes'",
    );
    expect(await checkReadiness()).toBe(false);
  });
  it("denies customer access to worker metadata", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role authenticated");
      await expect(
        client.query("select * from worker_heartbeats"),
      ).rejects.toThrow("permission denied");
    } finally {
      await client.query("reset role");
      client.release();
    }
  });
});
