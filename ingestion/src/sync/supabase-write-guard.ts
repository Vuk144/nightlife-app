/**
 * Hard write boundary for a controlled bulk event write against Supabase.
 *
 * Wraps a service-role client so that the ONLY write that can reach the
 * database is a single-row `events.insert` whose `external_id` is in the
 * prepared set, with its expected `venue_id`, at most once per external id.
 * Every other write — any insert elsewhere (venues, data_sources, cities, …),
 * any update / delete / upsert on any table, any RPC — throws synchronously,
 * before a request is built. Reads pass through unchanged.
 *
 * Use it with `./bulk-event-write.ts`:
 *
 *   const guard = guardClientForEventInserts(client, preparedInsertAllowances(prepared));
 *   await commitBulkEventWrite(prepared, new SupabaseCanonicalStore(guard.client));
 *
 * Preflight should use a store over `guardClientReadOnly(client)`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface EventInsertAllowance {
  externalId: string;
  venueId: string;
}

export interface GuardedClient {
  client: SupabaseClient;
  /** Every write the guard let through, in order: `events.insert <external_id>`. */
  readonly writes: string[];
}

export class ForbiddenWriteError extends Error {
  constructor(message: string) {
    super(`WRITE BLOCKED: ${message}`);
    this.name = "ForbiddenWriteError";
  }
}

const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);

function wrap(
  client: SupabaseClient,
  onInsert: (table: string, values: unknown) => void,
): SupabaseClient {
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key === "rpc") {
        return () => {
          throw new ForbiddenWriteError("rpc");
        };
      }
      const value = Reflect.get(target, key, receiver);
      if (key !== "from" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (table: string) => {
        const builder = (value as (t: string) => object).call(target, table);
        return new Proxy(builder, {
          get(b, k, r) {
            const v = Reflect.get(b, k, r);
            if (typeof k === "string" && WRITE_METHODS.has(k)) {
              return (...args: unknown[]) => {
                if (k !== "insert") throw new ForbiddenWriteError(`${table}.${k}`);
                onInsert(table, args[0]);
                return (v as (...a: unknown[]) => unknown).apply(b, args);
              };
            }
            return typeof v === "function" ? v.bind(b) : v;
          },
        });
      };
    },
  });
}

/** Reads only: every write throws. */
export function guardClientReadOnly(client: SupabaseClient): SupabaseClient {
  return wrap(client, (table) => {
    throw new ForbiddenWriteError(`${table}.insert (read-only client)`);
  });
}

/** Only the prepared `events.insert` rows, each at most once. */
export function guardClientForEventInserts(
  client: SupabaseClient,
  allowances: EventInsertAllowance[],
): GuardedClient {
  const expected = new Map(allowances.map((a) => [a.externalId, a.venueId]));
  if (expected.size !== allowances.length) throw new Error("guardClientForEventInserts: duplicate external ids");
  const done = new Set<string>();
  const writes: string[] = [];
  const guarded = wrap(client, (table, values) => {
    if (table !== "events") throw new ForbiddenWriteError(`${table}.insert`);
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new ForbiddenWriteError("events.insert must be a single row");
    }
    const row = values as Record<string, unknown>;
    const id = String(row.external_id ?? "");
    const venue = expected.get(id);
    if (venue === undefined) throw new ForbiddenWriteError(`events.insert of ${id || "(no external_id)"} is not in the prepared set`);
    if (row.venue_id !== venue) throw new ForbiddenWriteError(`events.insert ${id}: venue_id ${String(row.venue_id)} != ${venue}`);
    if (done.has(id)) throw new ForbiddenWriteError(`second events.insert for ${id}`);
    done.add(id);
    writes.push(`events.insert ${id}`);
  });
  return { client: guarded, writes };
}
