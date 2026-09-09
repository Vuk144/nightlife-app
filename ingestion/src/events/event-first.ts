/**
 * Run-level aggregation of event-first venue candidates.
 *
 * Many events in one run point at the same new venue; this collapses them into
 * one candidate per deterministic identity (source venue id → name+city →
 * name+city+address — never coordinates alone), merges their signals
 * conservatively, and applies the per-run safety cap.
 *
 * Pure and DETERMINISTIC: the output is a function of the SET of resolutions,
 * not their order. Contributions are aggregated in a fixed (url, title) order,
 * every field that picks "one of the contributing values" picks the same one
 * regardless of arrival order, `reasonCodes` is a canonically-sorted union, and
 * a substantive name/city disagreement between contributions that share one
 * candidateKey forces `needs_review` rather than silently choosing a value.
 */

import type { EventVenueResolution } from "./venue-resolve.ts";

export interface EventFirstCandidate {
  candidateKey: string;
  /** `safe_new_venue` only when every contributing event agreed and the cap allows. */
  status: "safe_new_venue" | "needs_review";
  proposedName: string;
  normalizedName: string;
  city: string | null;
  cityEnabled: boolean;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatesSource: "source" | null;
  sourceVenueId: string | null;
  venuePageUrl: string | null;
  locationConfidence: EventVenueResolution["locationConfidence"];
  /** Union of every contributing event's reason codes. */
  reasonCodes: string[];
  /** Number of events in this run that reference this venue. */
  eventCount: number;
  exampleEvents: { title: string; url: string }[];
  provenance: EventVenueResolution["provenance"];
}

export interface EventFirstAggregate {
  candidates: EventFirstCandidate[];
  safeCount: number;
  needsReviewCount: number;
  capLimit: number;
  capExceeded: boolean;
  demotedByCap: number;
}

function mergeCoords(
  a: EventFirstCandidate,
  r: EventVenueResolution,
): void {
  // First non-null wins — and because `relevant` is aggregated in a fixed
  // (url, title) order, "first" is deterministic, not arrival-dependent. Never
  // overwrite a good value with a null, and never adopt a half-pair (one of
  // lat/lon null) — that would be an unusable coordinate. Differing non-null
  // addresses / coordinates for one candidateKey are formatting or GPS-precision
  // noise (the resolver caches enrichment per source venue id), so a stable
  // pick is the conservative result; a differing NAME or CITY is escalated to
  // needs_review by the caller loop instead.
  if (a.latitude == null && r.latitude != null && r.longitude != null) {
    a.latitude = r.latitude;
    a.longitude = r.longitude;
    a.coordinatesSource = r.coordinatesSource;
  }
  if (!a.address && r.address) a.address = r.address;
  if (!a.venuePageUrl && r.provenance.venuePageUrl) {
    a.venuePageUrl = r.provenance.venuePageUrl;
    // keep the (copied) provenance in step with the merged top-level field
    a.provenance.venuePageUrl = r.provenance.venuePageUrl;
  }
  if (!a.provenance.externalVenueId && r.provenance.externalVenueId) {
    a.provenance.externalVenueId = r.provenance.externalVenueId;
  }
  if (!a.sourceVenueId && r.sourceVenueId) a.sourceVenueId = r.sourceVenueId;
}

const CONFIDENCE_RANK: Record<EventVenueResolution["locationConfidence"], number> =
  { coordinates: 3, address: 2, "city-only": 1, none: 0 };

/**
 * Total-order code-unit (UTF-16) string compare -> -1 | 0 | 1. Deliberately NOT
 * `localeCompare`, which can rank two distinct strings equal and would make the
 * sort — and therefore the per-run cap's safe/demoted selection — depend on
 * input order.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic order in which contributions are folded into a candidate: by
 * event URL, then event title. Every "first wins" / "first non-null wins" merge
 * (proposedName, city, address, coordinates, provenance, the first five
 * exampleEvents) is anchored to this order, never to arrival order.
 */
function compareContributionOrder(
  a: EventVenueResolution,
  b: EventVenueResolution,
): number {
  return (
    byCodeUnit(a.event.url, b.event.url) || byCodeUnit(a.event.title, b.event.title)
  );
}

/**
 * Final candidate ordering: most events first, then city, then normalized name,
 * then the unique `candidateKey` as a guaranteed total-order tiebreak so the
 * cap keeps the same candidates safe regardless of input order.
 */
function compareCandidates(a: EventFirstCandidate, b: EventFirstCandidate): number {
  return (
    b.eventCount - a.eventCount ||
    (a.city ?? "").localeCompare(b.city ?? "") ||
    a.normalizedName.localeCompare(b.normalizedName) ||
    byCodeUnit(a.candidateKey, b.candidateKey)
  );
}

/**
 * @param resolutions   every per-event resolution from the run
 * @param options.maxNewVenues  per-run cap on `safe_new_venue` candidates
 */
export function aggregateEventFirstCandidates(
  resolutions: EventVenueResolution[],
  options: { maxNewVenues: number },
): EventFirstAggregate {
  // Fold contributions in `compareContributionOrder` (URL, then title) — never
  // arrival order — so every "first wins" merge below is deterministic. `.filter`
  // returns a fresh array, so `.sort` never touches the caller's `resolutions`.
  const relevant = resolutions
    .filter((r) => r.status === "safe_new_venue" || r.status === "needs_review")
    .sort(compareContributionOrder);

  const byKey = new Map<string, EventFirstCandidate>();
  for (const r of relevant) {
    const existing = byKey.get(r.candidateKey);
    if (!existing) {
      // Only adopt coordinates as a complete pair — a lone lat or lon is unusable.
      const hasCoords = r.latitude != null && r.longitude != null;
      byKey.set(r.candidateKey, {
        candidateKey: r.candidateKey,
        // conservative: a candidate is safe only if ALL its events are safe
        status: r.status === "safe_new_venue" ? "safe_new_venue" : "needs_review",
        proposedName: r.proposedName,
        normalizedName: r.normalizedName,
        city: r.city,
        cityEnabled: r.cityEnabled,
        address: r.address,
        latitude: hasCoords ? r.latitude : null,
        longitude: hasCoords ? r.longitude : null,
        coordinatesSource: hasCoords ? r.coordinatesSource : null,
        sourceVenueId: r.sourceVenueId,
        venuePageUrl: r.provenance.venuePageUrl,
        locationConfidence: r.locationConfidence,
        reasonCodes: [...new Set(r.reasonCodes)],
        eventCount: 1,
        // copy caller-owned nested objects — the aggregate must never hand back
        // (or later mutate) a reference into the caller's resolutions
        exampleEvents: [{ title: r.event.title, url: r.event.url }],
        provenance: { ...r.provenance },
      });
      continue;
    }
    existing.eventCount++;
    // `relevant` is pre-sorted by (url, title), so keeping the first five
    // encountered = the five globally-smallest by that key — a deterministic
    // selection, chosen BEFORE truncation, not a sort applied after it.
    if (existing.exampleEvents.length < 5) {
      existing.exampleEvents.push({ title: r.event.title, url: r.event.url });
    }
    for (const code of r.reasonCodes) {
      if (!existing.reasonCodes.includes(code)) existing.reasonCodes.push(code);
    }
    if (r.status === "needs_review") existing.status = "needs_review";

    // Genuine conflicts across contributions that share ONE candidateKey. The
    // resolver does NOT guarantee these are equivalent (a `svid:` key groups by
    // the source's venue id, but each event supplies its own name / city). A
    // substantive disagreement is a real data-quality signal — never auto-safe.
    if (r.normalizedName !== existing.normalizedName) {
      existing.status = "needs_review";
      if (!existing.reasonCodes.includes("conflicting-venue-name-across-events")) {
        existing.reasonCodes.push("conflicting-venue-name-across-events");
      }
    }
    if (existing.city == null && r.city != null) {
      // never keep a null city when a later contribution actually has one
      existing.city = r.city;
      existing.cityEnabled = r.cityEnabled;
    } else if (r.city != null && existing.city != null && r.city !== existing.city) {
      existing.status = "needs_review";
      if (!existing.reasonCodes.includes("conflicting-city-across-events")) {
        existing.reasonCodes.push("conflicting-city-across-events");
      }
    }

    if (CONFIDENCE_RANK[r.locationConfidence] > CONFIDENCE_RANK[existing.locationConfidence]) {
      existing.locationConfidence = r.locationConfidence;
    }
    mergeCoords(existing, r);
  }

  const candidates = [...byKey.values()].sort(compareCandidates);

  // Per-run cap: the first N safe candidates (most events first) stay safe;
  // the rest are demoted to needs_review — never silently dropped.
  const cap = options.maxNewVenues;
  let safeSeen = 0;
  let demotedByCap = 0;
  for (const c of candidates) {
    if (c.status !== "safe_new_venue") continue;
    safeSeen++;
    if (safeSeen > cap) {
      c.status = "needs_review";
      if (!c.reasonCodes.includes("over-per-run-cap")) {
        c.reasonCodes.push("over-per-run-cap");
      }
      demotedByCap++;
    }
  }

  // `reasonCodes` is a logical union (a set) — give every candidate's array a
  // canonical order so the serialized output never leaks contribution order.
  for (const c of candidates) c.reasonCodes.sort();

  const safeCount = candidates.filter((c) => c.status === "safe_new_venue").length;
  return {
    candidates,
    safeCount,
    needsReviewCount: candidates.length - safeCount,
    capLimit: cap,
    capExceeded: demotedByCap > 0,
    demotedByCap,
  };
}
