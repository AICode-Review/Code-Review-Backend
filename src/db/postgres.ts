import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { env } from "../config.js";

let pool: pg.Pool | undefined;
const transaction = new AsyncLocalStorage<pg.PoolClient>();
export function getPool(): pg.Pool {
  const url = new URL(env().DATABASE_URL);
  if (url.hostname.endsWith("pooler.supabase.com") && url.port === "6543")
    throw new Error(
      "DATABASE_URL must use a direct or session-mode PostgreSQL connection for worker locks",
    );
  pool ??= new pg.Pool({
    connectionString: env().DATABASE_URL,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  return pool;
}
export async function stopPool(): Promise<void> {
  const active = pool;
  pool = undefined;
  await active?.end();
}
export function transactionDb() {
  const client = transaction.getStore();
  return client
    ? {
        executeSql: (text: string, values: unknown[]) =>
          client.query(text, values),
      }
    : undefined;
}
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const existing = transaction.getStore();
  if (existing) return fn(existing);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await transaction.run(client, () => fn(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
