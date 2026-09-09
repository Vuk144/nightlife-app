/**
 * Human-readable formatting of a `DryRunReport`. Pure string building — no I/O.
 */

import type { DryRunItem, DryRunReport } from "./engine.ts";
import type { EventFirstCandidate } from "./event-first.ts";

function pad(value: number, width = 6): string {
  return String(value).padStart(width);
}

function sortedCounts(counter: Record<string, number>): [string, number][] {
  return Object.entries(counter).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function coordsText(c: {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}): string {
  if (c.latitude != null && c.longitude != null) {
    return `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;
  }
  if (c.address) return `addr: ${c.address}`;
  return "no coords / no address";
}

function venueLine(item: DryRunItem): string {
  const v = item.venue;
  if (!v) {
    return item.event && !item.event.venue.name
      ? `venue: none named in source (city: ${item.event.venue.city ?? "?"})`
      : "venue resolution: skipped";
  }
  switch (v.status) {
    case "matched_existing":
      return `venue "${v.proposedName}" → MATCHED tier ${v.matchTier} → venue ${v.matchedVenueId} (${v.city})`;
    case "safe_new_venue":
      return `venue "${v.proposedName}" (${v.city}) → SAFE NEW VENUE [${v.locationConfidence}] ${coordsText(v)}`;
    case "needs_review":
      return `venue "${v.proposedName}" (${v.city ?? "?"}) → NEEDS REVIEW (${v.reasonCode})`;
    case "rejected":
      return `venue "${v.proposedName}" → REJECTED (${v.reasonCode})`;
  }
}

function exampleBlock(item: DryRunItem, index: number): string {
  const e = item.event;
  if (!e) return "";
  const lines: string[] = [];
  lines.push(`  [${index}] ${e.title}`);
  lines.push(
    `      ${e.startLocal} ${e.timeZone ?? "(no zone)"}  (${e.startPrecision})` +
      (e.endLocal ? `  → ${e.endLocal}` : "") +
      (e.status && e.status !== "scheduled" ? `  [${e.status.toUpperCase()}]` : ""),
  );
  lines.push(
    `      relevance: ${item.relevance && item.relevance.accepted ? item.relevance.tier : "?"} — ${
      item.relevance && item.relevance.accepted ? item.relevance.reason : ""
    }`,
  );
  lines.push(`      ${venueLine(item)}`);
  if (e.promoter) lines.push(`      promoter: ${e.promoter}`);
  if (e.ticketUrl) lines.push(`      tickets: ${e.ticketUrl}`);
  lines.push(
    `      externalId: ${e.externalId}   identityKey: ${
      item.identity?.identityKey.slice(0, 12) ?? "-"
    }`,
  );
  return lines.join("\n");
}

function candidateBlock(c: EventFirstCandidate): string {
  const lines: string[] = [];
  const flag = c.status === "safe_new_venue" ? "SAFE " : "REVIEW";
  lines.push(
    `  [${flag}] ${c.proposedName}  (${c.city ?? "?"})   ×${c.eventCount} event(s)`,
  );
  lines.push(
    `           normalized: "${c.normalizedName}"   sourceVenueId: ${c.sourceVenueId ?? "-"}`,
  );
  lines.push(
    `           location: ${c.locationConfidence}  |  ${coordsText(c)}${
      c.venuePageUrl ? `  |  ${c.venuePageUrl}` : ""
    }`,
  );
  if (c.reasonCodes.length > 0) {
    lines.push(`           reasons: ${c.reasonCodes.join(", ")}`);
  }
  lines.push(`           e.g. "${truncate(c.exampleEvents[0]?.title ?? "", 60)}"`);
  return lines.join("\n");
}

export function formatReport(
  report: DryRunReport,
  opts: { verbose: boolean },
): string {
  const { stats, items, eventFirst } = report;
  const out: string[] = [];
  const accepted = items.filter((i) => i.stage === "accepted");
  const rejected = items.filter((i) => i.stage === "rejected");
  const parseFailed = items.filter((i) => i.stage === "parse-failed");
  const fetchFailed = items.filter((i) => i.stage === "fetch-failed");
  const errored = items.filter((i) => i.stage === "error");

  out.push("");
  out.push(`GIGS TIX — event ingestion dry run  (READ-ONLY, no database writes)`);
  out.push(`  source:  ${stats.source}`);
  out.push(
    `  scope:   countries=${stats.scope.countries.join(",") || "(default)"}  ` +
      `cities=${stats.scope.cities.join(",") || "(all)"}`,
  );
  out.push(`  status:  ${stats.status.toUpperCase()}   (${(stats.durationMs / 1000).toFixed(1)}s)`);

  out.push("");
  out.push("Discovery / fetch / parse");
  out.push(`  Discovered:   ${pad(stats.discovered)}`);
  out.push(`  Fetched:      ${pad(stats.fetched)}`);
  out.push(`  Fetch failed: ${pad(stats.fetchFailed)}`);
  for (const [reason, n] of sortedCounts(stats.fetchFailureReasons)) {
    out.push(`      ${pad(n, 4)}  ${reason}`);
  }
  out.push(`  Parsed:       ${pad(stats.parsed)}`);
  out.push(`  Parse failed: ${pad(stats.parseFailed)}`);
  for (const [reason, n] of sortedCounts(stats.parseFailureReasons)) {
    out.push(`      ${pad(n, 4)}  ${reason}`);
  }
  if (stats.processFailed > 0) {
    out.push(`  Errors:       ${pad(stats.processFailed)}   (unexpected — post-parse processing)`);
    for (const [reason, n] of sortedCounts(stats.processFailureReasons)) {
      out.push(`      ${pad(n, 4)}  ${reason}`);
    }
  }

  out.push("");
  out.push("Relevance (music / nightlife filter)");
  out.push(
    `  Accepted:     ${pad(stats.accepted)}   (primary ${stats.acceptedPrimary}, secondary ${stats.acceptedSecondary})`,
  );
  out.push(`  Rejected:     ${pad(stats.rejected)}`);
  for (const [reason, n] of sortedCounts(stats.rejectionReasons)) {
    out.push(`      ${pad(n, 4)}  ${reason}`);
  }

  // ---- event-first venue resolution -------------------------------
  out.push("");
  if (stats.venueResolutionSkipped) {
    out.push("Event-first venue resolution: SKIPPED (no Supabase credentials)");
  } else {
    const vr = stats.venueResolution;
    out.push("Event-first venue resolution (per accepted event that names a venue)");
    out.push(`  Events naming a venue:  ${pad(stats.venuesNamed)}`);
    out.push(`  City-only (no venue):   ${pad(stats.noVenueInSource)}`);
    out.push("");
    out.push(`  matched_existing:      ${pad(vr.matchedExisting)}`);
    for (const [tier, n] of sortedCounts(vr.byTier)) {
      out.push(`      ${pad(n, 4)}  ${tier}`);
    }
    out.push(`  safe_new_venue:        ${pad(vr.safeNewVenue)}`);
    out.push(`  needs_review:          ${pad(vr.needsReview)}`);
    out.push(`  rejected:              ${pad(vr.rejected)}`);
    out.push("");
    out.push("  reason codes (all resolutions):");
    for (const [code, n] of sortedCounts(vr.reasonCodes)) {
      out.push(`      ${pad(n, 4)}  ${code}`);
    }

    // ---- aggregated event-first candidates (deduped + capped) -----
    out.push("");
    out.push(
      `Event-first venue candidates (deduped): ${eventFirst.candidates.length}  ` +
        `— safe ${eventFirst.safeCount}, needs_review ${eventFirst.needsReviewCount}  ` +
        `(per-run cap ${eventFirst.capLimit}${eventFirst.capExceeded ? `, ${eventFirst.demotedByCap} demoted` : ""})`,
    );
    out.push("  NOTHING is created in this dry run — this is the plan for a later write phase.");

    const safe = eventFirst.candidates.filter((c) => c.status === "safe_new_venue");
    const review = eventFirst.candidates.filter((c) => c.status === "needs_review");

    if (safe.length > 0) {
      out.push("");
      out.push(`  ── SAFE to create later (${safe.length}) ──`);
      for (const c of safe.slice(0, opts.verbose ? safe.length : 40)) {
        out.push(candidateBlock(c));
      }
      if (!opts.verbose && safe.length > 40) {
        out.push(`  … ${safe.length - 40} more (pass --verbose)`);
      }
    }
    if (review.length > 0) {
      out.push("");
      out.push(`  ── NEEDS REVIEW (${review.length}) ──`);
      for (const c of review.slice(0, opts.verbose ? review.length : 40)) {
        out.push(candidateBlock(c));
      }
      if (!opts.verbose && review.length > 40) {
        out.push(`  … ${review.length - 40} more (pass --verbose)`);
      }
    }
  }

  // ---- identity --------------------------------------------------
  out.push("");
  out.push("Identity");
  out.push(`  Planned canonical inserts: ${stats.plannedCanonicalInserts}`);
  out.push(
    "  (single source — GIGS TIX externalId is the identity; no cross-source merge)",
  );

  const buckets = new Map<string, DryRunItem[]>();
  for (const item of accepted) {
    if (!item.identity) continue;
    const list = buckets.get(item.identity.identityKey) ?? [];
    list.push(item);
    buckets.set(item.identity.identityKey, list);
  }
  const collisions = [...buckets.values()].filter((list) => list.length > 1);
  if (collisions.length > 0) {
    out.push("");
    // The bucket key is `identity.venueKey` (`venue:<id>` / `name:<norm>` /
    // `city:<norm>`) + `localDate` — for a city-only event that is a shared
    // CITY, not a shared venue, so the header names the key, which each group
    // line prints verbatim below.
    out.push(
      `Same venue key + same date (${collisions.length} group(s)) — kept SEPARATE, flagged for future cross-source review:`,
    );
    for (const list of collisions.slice(0, opts.verbose ? collisions.length : 8)) {
      out.push(`  ${list[0].identity!.venueKey} @ ${list[0].identity!.localDate}`);
      for (const item of list) out.push(`      - ${item.event?.title}`);
    }
  }

  // ---- examples -------------------------------------------------
  out.push("");
  out.push("Example normalized events (accepted):");
  for (const [idx, item] of accepted.slice(0, 8).entries()) {
    out.push(exampleBlock(item, idx + 1));
  }

  // ---- city-only (no venue) events ----------------------------
  const noVenue = accepted.filter((i) => i.event && !i.event.venue.name);
  if (noVenue.length > 0) {
    out.push("");
    out.push(
      `Accepted events with NO venue named in the source (${noVenue.length}) — city-only listings:`,
    );
    for (const item of noVenue.slice(0, opts.verbose ? noVenue.length : 15)) {
      out.push(
        `  - ${truncate(item.event?.title ?? "", 55)}  (${item.event?.venue.city ?? "?"})`,
      );
    }
  }

  // ---- verbose detail ---------------------------------------
  if (opts.verbose) {
    if (rejected.length > 0) {
      out.push("");
      out.push(`Rejected events (${rejected.length}):`);
      for (const item of rejected) {
        out.push(`  - ${truncate(item.event?.title ?? item.url, 60)}  — ${item.reason}`);
      }
    }
    if (parseFailed.length > 0) {
      out.push("");
      out.push(`Parse failures (${parseFailed.length}):`);
      for (const item of parseFailed) out.push(`  - ${item.url}  — ${item.reason}`);
    }
    if (fetchFailed.length > 0) {
      out.push("");
      out.push(`Fetch failures (${fetchFailed.length}):`);
      for (const item of fetchFailed) out.push(`  - ${item.url}  — ${item.reason}`);
    }
    if (errored.length > 0) {
      out.push("");
      out.push(`Processing errors (${errored.length}):`);
      for (const item of errored) {
        out.push(`  - ${truncate(item.event?.title ?? item.url, 60)}  — ${item.reason}`);
      }
    }
  }

  if (stats.notes.length > 0) {
    out.push("");
    out.push("Notes:");
    for (const note of stats.notes) out.push(`  - ${note}`);
  }

  out.push("");
  return out.join("\n");
}
