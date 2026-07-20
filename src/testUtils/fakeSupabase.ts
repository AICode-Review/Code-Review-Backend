import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A minimal in-memory stand-in for the Supabase JS client, for orchestrator-level tests
 * that exercise real db/repositories.ts functions across several tables without a live
 * Postgres connection. Seeded per-table; supports the specific chain shapes this codebase's
 * query builders actually use (select/eq/in/order/limit/single/maybeSingle, insert/update/
 * upsert with a `.select().single()` tail). Not a general Supabase-JS reimplementation —
 * extend it if a new chain shape shows up in a future test rather than trying to make it
 * fully generic upfront.
 */
export type FakeTables = Record<string, Record<string, unknown>[]>;

interface PendingOp {
  table: string;
  op: "select" | "insert" | "update" | "upsert";
  filters: { col: string; val: unknown; kind: "eq" | "neq" | "in" | "not_null" | "is_null" | "gte" | "lt" }[];
  payload?: Record<string, unknown> | Record<string, unknown>[];
  onConflict?: string;
  order?: { col: string; ascending: boolean };
  limit?: number;
  count?: "exact";
  embedAs?: string;
}

/**
 * Known foreign-key relations for the `.select("relationName(col1, col2)")` embed shape —
 * add an entry here (not a generic column-string parser) the next time a test needs a new
 * one; keeps this fake honest about only supporting exactly the joins this codebase issues.
 */
const EMBED_RELATIONS: Record<string, { table: string; localKey: string; foreignKey: string }> = {
  "org_members.users": { table: "users", localKey: "user_id", foreignKey: "id" },
};

function matchesFilters(row: Record<string, unknown>, filters: PendingOp["filters"]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return row[f.col] === f.val;
    if (f.kind === "neq") return row[f.col] !== f.val;
    if (f.kind === "not_null") return row[f.col] !== null && row[f.col] !== undefined;
    if (f.kind === "is_null") return row[f.col] === null || row[f.col] === undefined;
    if (f.kind === "gte") return (row[f.col] as string | number) >= (f.val as string | number);
    if (f.kind === "lt") return (row[f.col] as string | number) < (f.val as string | number);
    return Array.isArray(f.val) && f.val.includes(row[f.col]);
  });
}

class FakeBuilder implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private state: PendingOp;

  constructor(
    private readonly tables: FakeTables,
    table: string,
    op: PendingOp["op"],
    payload?: PendingOp["payload"],
    onConflict?: string,
  ) {
    this.state = { table, op, filters: [], payload, onConflict };
  }

  select(cols?: string, opts?: { count?: "exact"; head?: boolean }): this {
    if (opts?.count) this.state.count = opts.count;
    const embedMatch = cols ? /^(\w+)\(/.exec(cols.trim()) : null;
    if (embedMatch?.[1] && `${this.state.table}.${embedMatch[1]}` in EMBED_RELATIONS) {
      this.state.embedAs = embedMatch[1];
    }
    return this;
  }
  eq(col: string, val: unknown): this {
    this.state.filters.push({ col, val, kind: "eq" });
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.state.filters.push({ col, val: vals, kind: "in" });
    return this;
  }
  neq(col: string, val: unknown): this {
    this.state.filters.push({ col, val, kind: "neq" });
    return this;
  }
  gte(col: string, val: unknown): this {
    this.state.filters.push({ col, val, kind: "gte" });
    return this;
  }
  lt(col: string, val: unknown): this {
    this.state.filters.push({ col, val, kind: "lt" });
    return this;
  }
  /** `.is(col, null)` — the other "is null" shape used by this codebase, alongside `.not(col, "is", null)`. */
  is(col: string, val: null): this {
    if (val === null) this.state.filters.push({ col, val: null, kind: "is_null" });
    return this;
  }
  /** Only the "is not null" shape used by this codebase — `.not(col, "is", null)`. */
  not(col: string, _op: "is", val: null): this {
    if (val === null) this.state.filters.push({ col, val: null, kind: "not_null" });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.state.order = { col, ascending: opts?.ascending ?? true };
    return this;
  }
  limit(n: number): this {
    this.state.limit = n;
    return this;
  }

  private execute(): { data: unknown; error: null; count?: number } {
    const { table, op, filters, payload, onConflict, order, limit, count, embedAs } = this.state;
    this.tables[table] ??= [];
    const rows = this.tables[table];

    if (op === "select") {
      let result = rows.filter((r) => matchesFilters(r, filters));
      const exactCount = count === "exact" ? result.length : undefined;
      if (embedAs) {
        const relation = EMBED_RELATIONS[`${table}.${embedAs}`]!;
        const related = this.tables[relation.table] ?? [];
        result = result.map((r) => ({
          ...r,
          [embedAs]: related.find((rel) => rel[relation.foreignKey] === r[relation.localKey]) ?? null,
        }));
      }
      if (order) {
        result = [...result].sort((a, b) => {
          const av = a[order.col] as string | number;
          const bv = b[order.col] as string | number;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return order.ascending ? cmp : -cmp;
        });
      }
      if (limit !== undefined) result = result.slice(0, limit);
      return { data: result, error: null, count: exactCount };
    }

    if (op === "insert") {
      const items = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
      // review_runs.started_at is `not null default now()` in the real schema — callers
      // (e.g. reviewRun.ts) rely on that default and never set it explicitly, so mirror it
      // here rather than leaving the column undefined and silently failing date-range filters.
      const inserted = items.map((item) => ({
        id: randomUUID(),
        ...(table === "review_runs" ? { started_at: new Date().toISOString() } : {}),
        ...item,
      }));
      rows.push(...inserted);
      return { data: inserted, error: null };
    }

    if (op === "update") {
      const targets = rows.filter((r) => matchesFilters(r, filters));
      for (const t of targets) Object.assign(t, payload);
      return { data: targets, error: null };
    }

    // upsert: match on onConflict columns (comma-separated), else insert
    const conflictCols = (onConflict ?? "id").split(",");
    const item = payload as Record<string, unknown>;
    const existing = rows.find((r) => conflictCols.every((c) => r[c] === item[c]));
    if (existing) {
      Object.assign(existing, item);
      return { data: [existing], error: null };
    }
    const inserted = { id: randomUUID(), ...item };
    rows.push(inserted);
    return { data: [inserted], error: null };
  }

  single(): Promise<{ data: unknown; error: Error | null }> {
    const { data } = this.execute();
    const arr = data as unknown[];
    if (arr.length === 0) return Promise.resolve({ data: null, error: new Error("no rows") });
    return Promise.resolve({ data: arr[0], error: null });
  }

  maybeSingle(): Promise<{ data: unknown; error: null }> {
    const { data } = this.execute();
    const arr = data as unknown[];
    return Promise.resolve({ data: arr[0] ?? null, error: null });
  }

  then<TResult1 = { data: unknown; error: null; count?: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

export function createFakeSupabase(seed: FakeTables = {}): { client: SupabaseClient; tables: FakeTables } {
  const tables: FakeTables = seed;
  const client = {
    from(table: string) {
      return {
        select: (cols?: string, opts?: { count?: "exact"; head?: boolean }) => new FakeBuilder(tables, table, "select").select(cols, opts),
        insert: (payload: PendingOp["payload"]) => new FakeBuilder(tables, table, "insert", payload),
        update: (payload: PendingOp["payload"]) => new FakeBuilder(tables, table, "update", payload),
        upsert: (payload: PendingOp["payload"], opts?: { onConflict?: string }) =>
          new FakeBuilder(tables, table, "upsert", payload, opts?.onConflict),
      };
    },
    // No fake repo indexer data by default — always resolves empty, matching a
    // never-indexed repo (the real getContext() call short-circuits safely on this).
    rpc: async () => ({ data: [], error: null }),
  } as unknown as SupabaseClient;
  return { client, tables };
}
