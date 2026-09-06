/**
 * Minimal migration runner: applies src/db/migrations/*.sql in filename order,
 * tracking applied files in schema_migrations. Usage: npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { env } from "../config.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Same guard pattern as worker.ts — importing this module (e.g. a test exercising
 * isLocalDatabaseUrl) must be inert, never opening a real database connection. */
export const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href;

/**
 * Whether `connectionString` points at a database that doesn't need/support SSL — plain
 * localhost, or "postgres", docker-compose.selfhosted.yml's bundled Postgres service
 * hostname. That container has no SSL enabled, so requesting it anyway (the `ssl: {...}`
 * branch below) made a fresh self-hosted install's very first `npm run db:migrate` fail to
 * connect at all — a real bug, not just a theoretical one.
 */
export function isLocalDatabaseUrl(connectionString: string): boolean {
  return /localhost|127\.0\.0\.1|(?:^|@)postgres(?::|\/)/.test(connectionString);
}

async function main() {
  const connectionString = env().DATABASE_URL;
  const client = new pg.Client({
    connectionString,
    ssl: isLocalDatabaseUrl(connectionString) ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await client.query("select name from schema_migrations")).rows.map((r) => r.name as string),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), "utf8");
      console.log(`Applying ${file}...`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    }
    console.log("Migrations up to date.");
  } finally {
    await client.end();
  }
}

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
