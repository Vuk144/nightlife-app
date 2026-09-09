/**
 * Generic nightlife data synchronization engine — public surface.
 *
 * Implemented and tested:
 *
 *   - the generic pipeline as `planSync` (reads only, produces a `SyncPlan`)
 *   - identity resolution (venue + event), reusing the existing matchers
 *   - change detection, reconciliation, validation — pure and deterministic
 *   - `ConfigProvider` (data-driven geography / sources / aliases / thresholds)
 *   - `CanonicalStore` port + `InMemoryCanonicalStore`
 *   - `SupabaseCanonicalStore` — persists a `SyncPlan` to the CURRENT Supabase
 *     schema (idempotent, explicit per-operation, error-halting, never deletes).
 *     Anything the current schema cannot represent is recorded in
 *     `SyncApplyResult.deferred`.
 *
 * DEFERRED to later steps:
 *
 *   - a `sync_apply_plan` transactional RPC (only needed once multi-table
 *     per-record writes — e.g. `event_sources` — land)
 *   - the production `ConfigProvider` that reads `data_sources` + a config file
 *   - rewiring the GIGS TIX / OSM adapters onto `SourceAdapter`
 *   - the scheduler
 *
 * Existing functionality (`../events/*`, `../ingest-venues.ts`, `../matching.ts`)
 * is untouched. The engine never imports Supabase.
 */

export * from "./types.ts";
export * from "./config.ts";
export * from "./normalization.ts";
export * from "./validation.ts";
export * from "./venue-identity.ts";
export * from "./event-identity.ts";
export * from "./change-detection.ts";
export * from "./canonical-hash.ts";
export * from "./time-zone.ts";
export * from "./reconcile.ts";
export * from "./store.ts";
export * from "./supabase-store.ts";
export * from "./engine.ts";
export * from "./report.ts";
