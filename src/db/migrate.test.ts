import { describe, expect, it } from "vitest";
import { isLocalDatabaseUrl } from "./migrate.js";

describe("isLocalDatabaseUrl", () => {
  it("treats plain localhost/127.0.0.1 URLs as local (no SSL)", () => {
    expect(isLocalDatabaseUrl("postgresql://user:pass@localhost:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgresql://user:pass@127.0.0.1:5432/db")).toBe(true);
  });

  it("treats docker-compose.selfhosted.yml's bundled Postgres hostname as local (no SSL)", () => {
    expect(isLocalDatabaseUrl("postgresql://codeferret:change-me@postgres:5432/codeferret")).toBe(true);
  });

  it("requires SSL for a real remote host, including one that merely starts with 'postgres'", () => {
    expect(isLocalDatabaseUrl("postgresql://user:pass@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres")).toBe(false);
    expect(isLocalDatabaseUrl("postgresql://user:pass@postgres-primary.internal:5432/db")).toBe(false);
  });

  it("does not false-positive on the 'postgres' username or 'postgresql' scheme", () => {
    expect(isLocalDatabaseUrl("postgresql://postgres:pass@db.example.com:5432/mydb")).toBe(false);
  });
});
