/**
 * A deterministic in-memory fake of the small slice of the Supabase / PostgREST
 * query builder that `SupabaseCanonicalStore` uses. Backed by plain arrays.
 *
 * This lets the persistence layer's SQL-shaping, idempotency, "never null a
 * value", and error-handling logic be unit-tested with ZERO network and ZERO
 * risk to any real database. A separate opt-in harness
 * (`integration/supabase-store.integration.test.ts`) exercises the same store
 * against a real Supabase project.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface FakeError {
  message: string;
  code?: string;
}

type Row = Record<string, unknown>;
type Op = "select" | "insert" | "update";

let seq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export class FakeSupabase {
  tables: Record<string, Row[]> = {
    countries: [],
    cities: [],
    data_sources: [],
    venues: [],
    events: [],
  };
  /** call log, for assertions ("no unnecessary update") */
  readonly writes: { table: string; op: Op; values: Row; filters: [string, unknown][] }[] = [];
  private failures: { table: string; op: Op; error: FakeError }[] = [];

  seed(table: string, rows: Row[]): void {
    this.tables[table] = rows.map((r) => ({ ...r }));
  }

  failNext(table: string, op: Op, error: FakeError): void {
    this.failures.push({ table, op, error });
  }

  private takeFailure(table: string, op: Op): FakeError | null {
    const i = this.failures.findIndex((f) => f.table === table && f.op === op);
    if (i < 0) return null;
    return this.failures.splice(i, 1)[0].error;
  }

  from(table: string): FakeBuilder {
    return new FakeBuilder(this, table);
  }

  /** cast helper for the store constructor */
  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }

  // ── internal query execution ──────────────────────────────────────
  _run(b: FakeBuilder): { data: unknown; error: FakeError | null } {
    const rows = this.tables[b._table] ?? (this.tables[b._table] = []);
    const failure = this.takeFailure(b._table, b._op);
    if (failure) return { data: null, error: failure };

    if (b._op === "insert") {
      const row: Row = { id: uuid(), created_at: FIXED_NOW, updated_at: FIXED_NOW, ...b._values };
      rows.push(row);
      this.writes.push({ table: b._table, op: "insert", values: { ...b._values }, filters: [] });
      return this.project(b, [row]);
    }

    let matched = rows.filter((r) => b._filters.every(([c, v]) => eqish(r[c], v)));
    for (const [col, v] of b._gte) matched = matched.filter((r) => String(r[col]) >= String(v));
    for (const [col, v] of b._lt) matched = matched.filter((r) => String(r[col]) < String(v));

    if (b._op === "update") {
      for (const r of matched) Object.assign(r, b._values);
      this.writes.push({
        table: b._table,
        op: "update",
        values: { ...b._values },
        filters: [...b._filters],
      });
      return this.project(b, matched);
    }

    return this.project(b, matched);
  }

  private project(
    b: FakeBuilder,
    rows: Row[],
  ): { data: unknown; error: FakeError | null } {
    const enriched = rows.map((r) => {
      if (b._select.includes("cities(") && r.city_id != null) {
        const city = (this.tables.cities ?? []).find((c) => c.id === r.city_id);
        return { ...r, cities: city ? { name: city.name, country_id: city.country_id } : null };
      }
      return r;
    });
    if (b._mode === "single") {
      if (enriched.length !== 1) {
        return {
          data: null,
          error: { message: `expected exactly 1 row, got ${enriched.length}`, code: "PGRST116" },
        };
      }
      return { data: enriched[0], error: null };
    }
    if (b._mode === "maybeSingle") {
      if (enriched.length > 1) {
        return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
      }
      return { data: enriched[0] ?? null, error: null };
    }
    return { data: enriched, error: null };
  }
}

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function eqish(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}

class FakeBuilder implements PromiseLike<{ data: unknown; error: FakeError | null }> {
  _op: Op = "select";
  _select = "*";
  _values: Row = {};
  _filters: [string, unknown][] = [];
  _gte: [string, unknown][] = [];
  _lt: [string, unknown][] = [];
  _mode: "list" | "single" | "maybeSingle" = "list";

  constructor(
    private readonly db: FakeSupabase,
    readonly _table: string,
  ) {}

  select(cols = "*"): this {
    this._select = cols;
    return this;
  }
  insert(values: Row): this {
    this._op = "insert";
    this._values = values;
    return this;
  }
  update(values: Row): this {
    this._op = "update";
    this._values = values;
    return this;
  }
  eq(col: string, val: unknown): this {
    this._filters.push([col, val]);
    return this;
  }
  gte(col: string, val: unknown): this {
    this._gte.push([col, val]);
    return this;
  }
  lt(col: string, val: unknown): this {
    this._lt.push([col, val]);
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  maybeSingle(): Promise<{ data: unknown; error: FakeError | null }> {
    this._mode = "maybeSingle";
    return Promise.resolve(this.db._run(this));
  }
  single(): Promise<{ data: unknown; error: FakeError | null }> {
    this._mode = "single";
    return Promise.resolve(this.db._run(this));
  }
  then<R1, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: FakeError | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve(this.db._run(this)).then(onfulfilled, onrejected);
  }
}
