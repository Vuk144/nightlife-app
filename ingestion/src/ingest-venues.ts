import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.ts";
import type { IngestionTarget } from "./targets.ts";
import type {
  ExistingVenue,
  IngestResult,
  IngestSummary,
  NormalizedVenue,
  VenueAction,
  VenueCategory,
} from "./types.ts";
import { computeNameNormalized } from "./normalize.ts";
import { collectVenuesForTarget } from "./sources/osm-overpass.ts";
import {
  reviewNotesForNewVenues,
  resolveMatch,
  type MatchContext,
  type MatchOutcome,
} from "./matching.ts";

const OSM_SOURCE_NAME = "OpenStreetMap";
const OSM_BASE_URL = "https://overpass-api.de/api/interpreter";

export type { ExistingVenue };

/**
 * EVENT-FIRST COMPATIBILITY (design note — not implemented here).
 *
 * A future event source can discover a venue that the OSM classifier would not
 * accept. That path reuses this module's pieces without any schema change:
 *
 *   1. build a `NormalizedVenue`-shaped object from the event's location
 *      (name required; coordinates when the source has them; `category` may be
 *       omitted — it is now optional);
 *   2. `resolveMatch(incoming, ctx)` — the SAME Tier 0-4 identity matcher,
 *      with `ctx.osmSourceId` swapped for the event source's data_sources id
 *      and `ctx.target` = { countryId, cityName, osmRelationId: 0 };
 *   3. on `{ kind: "new" }`, insert a venue with the exact column set below
 *      (`coordinates_source: "source"`, `source_id` = the event source);
 *   4. insert the event with `venue_id` = the resolved/created venue.
 *
 * The venue then lives independently of events: `ingestVenuesForTarget` never
 * reads `events`, event frequency, or event start time, and `events.start_at`
 * has no hour-of-day constraint. A venue with zero events, one event a month,
 * a seasonal schedule, or an unavailable event source stays valid.
 *
 * `classifyOsmElement` is NOT on the event-first path — an event-discovered
 * venue does not need to pass the nightlife classifier.
 */

function emptySummary(): IngestSummary {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    invalid: 0,
    excluded: 0,
  };
}

/** Find the OpenStreetMap row in `data_sources`, creating it if absent. */
async function resolveOsmSourceId(supabase: SupabaseClient): Promise<string> {
  const found = await supabase
    .from("data_sources")
    .select("id")
    .eq("name", OSM_SOURCE_NAME)
    .maybeSingle();
  if (found.error) {
    throw new Error(`Could not read data_sources: ${found.error.message}`);
  }
  if (found.data?.id) return found.data.id as string;

  const created = await supabase
    .from("data_sources")
    .insert({
      name: OSM_SOURCE_NAME,
      type: "api",
      base_url: OSM_BASE_URL,
      attribution: "© OpenStreetMap contributors",
      license: "ODbL",
    })
    .select("id")
    .single();
  if (created.error) {
    throw new Error(
      `Could not create the OpenStreetMap data source: ${created.error.message}`,
    );
  }
  return created.data.id as string;
}

/** Resolve the city row for a target. This milestone never creates cities. */
async function resolveCityId(
  supabase: SupabaseClient,
  target: IngestionTarget,
): Promise<string> {
  const { data, error } = await supabase
    .from("cities")
    .select("id")
    .eq("country_id", target.countryId)
    .eq("name", target.cityName)
    .maybeSingle();
  if (error) throw new Error(`Could not read cities: ${error.message}`);
  if (!data?.id) {
    throw new Error(
      `No cities row for "${target.cityName}" (${target.countryId}). ` +
        `This milestone does not create cities — seed it first.`,
    );
  }
  return data.id as string;
}

/**
 * Backfill `name_normalized` for city venues that lack it (e.g. the manually
 * seeded ones), so deterministic matching can find them. Mutates `existing`
 * in place so a dry run still matches accurately.
 */
async function backfillNameNormalized(
  supabase: SupabaseClient,
  existing: ExistingVenue[],
  dryRun: boolean,
): Promise<number> {
  let count = 0;
  for (const venue of existing) {
    if (venue.name_normalized && venue.name_normalized.length > 0) continue;
    const normalized = computeNameNormalized(venue.name);
    venue.name_normalized = normalized;
    count++;
    if (dryRun) continue;
    const { error } = await supabase
      .from("venues")
      .update({ name_normalized: normalized })
      .eq("id", venue.id);
    if (error) {
      throw new Error(
        `Could not backfill name_normalized for venue ${venue.id}: ${error.message}`,
      );
    }
  }
  return count;
}

/**
 * Field changes to apply to an already-matched existing venue, or null when
 * nothing changed.
 *
 *  - Only *fills* empty optional fields — never clobbers curated data.
 *  - NEVER touches `latitude`/`longitude` when `coordinates_source = 'manual'`.
 *  - NEVER changes `name` or `name_normalized`: an existing venue keeps its own
 *    name, so its normalized form stays derived from that name.
 */
export function planUpdate(
  existing: ExistingVenue,
  incoming: NormalizedVenue,
  osmSourceId: string,
): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};

  if (existing.source_id !== osmSourceId) fields.source_id = osmSourceId;
  if (existing.external_id !== incoming.externalId) {
    fields.external_id = incoming.externalId;
  }
  if (!existing.source_url && incoming.sourceUrl) {
    fields.source_url = incoming.sourceUrl;
  }
  if (!existing.address && incoming.address) fields.address = incoming.address;
  if (!existing.website && incoming.website) fields.website = incoming.website;
  if (!existing.opening_hours && incoming.openingHours) {
    fields.opening_hours = incoming.openingHours;
  }
  if (!existing.wikidata && incoming.wikidata) {
    fields.wikidata = incoming.wikidata;
  }

  if (existing.coordinates_source !== "manual") {
    const coordsDiffer =
      existing.latitude !== incoming.latitude ||
      existing.longitude !== incoming.longitude ||
      existing.coordinates_source !== "source";
    if (coordsDiffer) {
      fields.latitude = incoming.latitude;
      fields.longitude = incoming.longitude;
      fields.coordinates_source = "source";
    }
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

function venueAction(
  kind: VenueAction["kind"],
  incoming: NormalizedVenue,
  opts: { note?: string; review?: boolean; category?: VenueCategory } = {},
): VenueAction {
  return {
    kind,
    name: incoming.name,
    externalId: incoming.externalId,
    latitude: incoming.latitude,
    longitude: incoming.longitude,
    address: incoming.address,
    note: opts.note,
    review: opts.review,
    category: opts.category,
  };
}

function joinNotes(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p && p.length > 0));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/** The classifier's acceptance note (e.g. "Layer C rescue: Kolarac"). */
function viaNote(incoming: NormalizedVenue): string | undefined {
  if (incoming.rescued) return `RESCUED — ${incoming.acceptedVia ?? "Layer C"}`;
  return incoming.acceptedVia;
}
function classifierReview(incoming: NormalizedVenue): boolean {
  return incoming.review === true || incoming.rescued === true;
}

/** Run the OSM venue ingestion for one target city. */
export async function ingestVenuesForTarget(
  supabase: SupabaseClient,
  config: Config,
  target: IngestionTarget,
  options: { dryRun: boolean },
): Promise<IngestResult> {
  const summary = emptySummary();
  const actions: VenueAction[] = [];
  const { dryRun } = options;

  const osmSourceId = await resolveOsmSourceId(supabase);
  const cityId = await resolveCityId(supabase, target);

  const { venues, invalid, excluded, fetched } = await collectVenuesForTarget(
    target,
    config,
  );
  summary.fetched = fetched;
  summary.invalid = invalid.length;
  summary.excluded = excluded.length;
  for (const item of invalid) {
    actions.push({
      kind: "invalid",
      name: "—",
      externalId: item.ref,
      latitude: null,
      longitude: null,
      address: null,
      note: item.reason,
    });
  }
  for (const item of excluded) {
    actions.push({
      kind: "excluded",
      name: item.name,
      externalId: item.ref,
      latitude: null,
      longitude: null,
      address: null,
      note: item.reason,
    });
  }

  const existingResult = await supabase
    .from("venues")
    .select(
      "id, name, name_normalized, source_id, external_id, source_url, latitude, longitude, coordinates_source, address, website, opening_hours, wikidata",
    )
    .eq("city_id", cityId);
  if (existingResult.error) {
    throw new Error(`Could not load existing venues: ${existingResult.error.message}`);
  }
  const existing = (existingResult.data ?? []) as ExistingVenue[];

  const backfilled = await backfillNameNormalized(supabase, existing, dryRun);
  if (backfilled > 0) {
    console.log(`  backfilled name_normalized on ${backfilled} existing venue(s)`);
  }

  // Pass 1 — decide every element (deterministic tiers), consuming existing
  // venues as they are linked so a later element cannot re-link the same row.
  const ctx: MatchContext = {
    target,
    osmSourceId,
    existing,
    consumed: new Set<string>(),
  };
  const decisions: { incoming: NormalizedVenue; outcome: MatchOutcome }[] = [];
  for (const incoming of venues) {
    const outcome = resolveMatch(incoming, ctx);
    if (outcome.kind === "match") ctx.consumed.add(outcome.venue.id);
    decisions.push({ incoming, outcome });
  }

  // Advisory review notes for everything that will be inserted.
  const newVenues = decisions
    .filter((d) => d.outcome.kind === "new")
    .map((d) => d.incoming);
  const reviewNotes = reviewNotesForNewVenues(newVenues, existing);

  // Pass 2 — execute (writes are skipped entirely on a dry run).
  for (const { incoming, outcome } of decisions) {
    if (outcome.kind === "skip") {
      summary.skipped++;
      actions.push(venueAction("skip", incoming, { note: outcome.note, review: true }));
      continue;
    }

    if (outcome.kind === "new") {
      if (!dryRun) {
        const { error } = await supabase.from("venues").insert({
          city_id: cityId,
          name: incoming.name,
          name_normalized: incoming.nameNormalized,
          address: incoming.address,
          latitude: incoming.latitude,
          longitude: incoming.longitude,
          coordinates_source: "source",
          website: incoming.website,
          opening_hours: incoming.openingHours,
          wikidata: incoming.wikidata,
          source_id: osmSourceId,
          external_id: incoming.externalId,
          source_url: incoming.sourceUrl,
          last_synced_at: new Date().toISOString(),
          is_active: true,
        });
        if (error) {
          throw new Error(`Insert failed for ${incoming.externalId}: ${error.message}`);
        }
      }
      summary.inserted++;
      const advisory = reviewNotes.get(incoming.externalId);
      actions.push(
        venueAction("insert", incoming, {
          note: joinNotes(viaNote(incoming), outcome.note, advisory),
          review:
            Boolean(outcome.review) || advisory != null || classifierReview(incoming),
          category: incoming.category,
        }),
      );
      continue;
    }

    // outcome.kind === "match"
    const fields = planUpdate(outcome.venue, incoming, osmSourceId);
    const tierNote = `tier ${outcome.tier} -> "${outcome.venue.name}"`;
    if (!fields) {
      summary.unchanged++;
      actions.push(
        venueAction("unchanged", incoming, {
          note: joinNotes(tierNote, viaNote(incoming), outcome.note),
          review: outcome.review || classifierReview(incoming),
          category: incoming.category,
        }),
      );
      continue;
    }
    if (!dryRun) {
      const { error } = await supabase
        .from("venues")
        .update({ ...fields, last_synced_at: new Date().toISOString() })
        .eq("id", outcome.venue.id);
      if (error) {
        throw new Error(`Update failed for venue ${outcome.venue.id}: ${error.message}`);
      }
    }
    summary.updated++;
    actions.push(
      venueAction("update", incoming, {
        note: joinNotes(
          tierNote,
          viaNote(incoming),
          outcome.note,
          `fields: ${Object.keys(fields).sort().join(", ")}`,
        ),
        review: outcome.review || classifierReview(incoming),
        category: incoming.category,
      }),
    );
  }

  return { summary, actions };
}
