/**
 * Direct tests for the DRY-RUN ORCHESTRATOR — `../../src/events/engine.ts#runEventDryRun`.
 *
 * The collaborators (relevance, identity, event-first, venue-resolve, sitemap,
 * time, text) have their own unit tests. These exercise the ENGINE: discovery
 * handling, per-event error isolation (fetch / parse / relevance / venue
 * resolution / identity), the final aggregation call, run-health semantics,
 * counter invariants, side-effect discipline and determinism.
 *
 * No network, no Supabase — the adapter and the venue resolver are scripted
 * doubles.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runEventDryRun } from "../../src/events/engine.ts";
import type {
  EventRef,
  EventSourceAdapter,
  NormalizedEvent,
  ParseResult,
  RawEvent,
  SourceContext,
} from "../../src/events/types.ts";
import type { EventVenueResolution, VenueResolver } from "../../src/events/venue-resolve.ts";

// ── fixtures ─────────────────────────────────────────────────────────
function ctx(over: Partial<SourceContext> = {}): SourceContext {
  return {
    countries: ["RS"],
    cities: [],
    defaultTimeZone: "Europe/Belgrade",
    userAgent: "engine-test",
    baseUrl: "https://src.test",
    limit: 0,
    verbose: false,
    ...over,
  };
}

function ev(over: Partial<NormalizedEvent> & { categories?: string[] } = {}): NormalizedEvent {
  const { categories, ...rest } = over;
  return {
    externalId: "E1",
    sourceUrl: "https://src.test/event/e1/",
    title: "Techno Night",
    description: undefined,
    startLocal: "2026-07-01T22:00",
    startPrecision: "datetime",
    venue: { name: "Depo", city: "Beograd", sourceVenueId: "depo" },
    reported: { categories: categories ?? ["koncert"], eventTypeText: null },
    ...rest,
  };
}

function resolution(over: Partial<EventVenueResolution> = {}): EventVenueResolution {
  return {
    status: "safe_new_venue",
    reasonCode: "safe-new-venue",
    reason: "ok",
    reasonCodes: ["safe-new-venue"],
    proposedName: "Depo",
    normalizedName: "depo",
    city: "Belgrade",
    cityKnown: true,
    cityEnabled: true,
    address: null,
    latitude: null,
    longitude: null,
    coordinatesSource: null,
    sourceVenueId: "depo",
    locationConfidence: "city-only",
    matchedVenueId: null,
    matchTier: null,
    matchNote: null,
    eventRelevanceTier: "primary",
    provenance: {
      dataSource: "test-src",
      externalVenueId: "depo",
      sourceUrl: "https://src.test/event/e1/",
      venuePageUrl: null,
    },
    candidateKey: "nc:Belgrade:depo",
    event: { title: "Depo", url: "https://src.test/event/e1/" },
    ...over,
  };
}

type Outcome =
  | { fetchThrows: string }
  | { http: number }
  | { parseThrows: string }
  | { parseFail: { reason: string; detail?: string } }
  | { event: NormalizedEvent };

interface ScriptEntry {
  url: string;
  lastmod?: string;
  outcome: Outcome;
}

interface ScriptedAdapter extends EventSourceAdapter {
  discoverCount: number;
  fetchCalls: string[];
  parseCalls: string[];
}

function scriptedAdapter(cfg: {
  key?: string;
  script: ScriptEntry[];
  discover?: "throw" | "empty" | { yieldThenThrow: number };
  discoverMessage?: string;
}): ScriptedAdapter {
  const byUrl = new Map(cfg.script.map((s) => [s.url, s.outcome]));
  const self: ScriptedAdapter = {
    key: cfg.key ?? "test-src",
    capabilities: {
      discovery: "sitemap",
      givesVenueId: true,
      givesLineup: false,
      givesPromoter: true,
      givesVenuePages: true,
    },
    discoverCount: 0,
    fetchCalls: [],
    parseCalls: [],
    async *discover(): AsyncIterable<EventRef> {
      if (cfg.discover === "throw") throw new Error(cfg.discoverMessage ?? "discover boom");
      if (cfg.discover === "empty") return;
      const cap =
        cfg.discover && typeof cfg.discover === "object" ? cfg.discover.yieldThenThrow : Infinity;
      for (const s of cfg.script) {
        if (self.discoverCount >= cap) {
          throw new Error(cfg.discoverMessage ?? "discover boom mid-stream");
        }
        self.discoverCount++;
        yield { url: s.url, lastmod: s.lastmod };
      }
    },
    async fetch(ref: EventRef): Promise<RawEvent> {
      self.fetchCalls.push(ref.url);
      const o = byUrl.get(ref.url);
      if (!o) throw new Error(`no script entry for ${ref.url}`);
      if ("fetchThrows" in o) throw new Error(o.fetchThrows);
      const status = "http" in o ? o.http : 200;
      return { ref, url: ref.url, status, body: `body:${ref.url}`, fetchedAt: "2026-06-01T00:00:00.000Z" };
    },
    parse(raw: RawEvent): ParseResult {
      self.parseCalls.push(raw.ref.url);
      const o = byUrl.get(raw.ref.url);
      if (!o) return { ok: false, reason: "no-script" };
      if ("parseThrows" in o) throw new Error(o.parseThrows);
      if ("parseFail" in o) return { ok: false, reason: o.parseFail.reason, detail: o.parseFail.detail };
      if ("event" in o) return { ok: true, event: o.event };
      return { ok: false, reason: "unexpected-outcome" };
    },
  };
  return self;
}

interface ScriptedResolver extends VenueResolver {
  resolveCalls: NormalizedEvent[];
}

function scriptedResolver(
  resolve: (
    event: NormalizedEvent,
    tier: "primary" | "secondary",
  ) => EventVenueResolution | Promise<EventVenueResolution>,
  cities: string[] = ["Belgrade"],
): ScriptedResolver {
  const self: ScriptedResolver = {
    knownCities: [...cities],
    enabledCities: [...cities],
    resolveCalls: [],
    async resolve(event, tier) {
      self.resolveCalls.push(event);
      return resolve(event, tier);
    },
  };
  return self;
}

function run(opts: {
  adapter: EventSourceAdapter;
  resolver?: VenueResolver | null;
  ctx?: SourceContext;
  cap?: number;
}) {
  return runEventDryRun({
    adapter: opts.adapter,
    ctx: opts.ctx ?? ctx(),
    resolver: opts.resolver ?? null,
    eventFirstMaxNewVenues: opts.cap ?? 10,
  });
}

const acceptedEvent = (url: string, id: string) => ({
  url,
  outcome: { event: ev({ externalId: id, sourceUrl: url }) } as Outcome,
});

// ════════════════════════════════════════════════════════════════════
//  DISCOVERY
// ════════════════════════════════════════════════════════════════════

test("[discovery] discovery throws → failed, no items, valid empty aggregate", async () => {
  const r = await run({
    adapter: scriptedAdapter({ script: [], discover: "throw", discoverMessage: "sitemap 503" }),
  });
  assert.equal(r.stats.status, "failed");
  assert.match(r.stats.notes.join(" "), /discovery failed: sitemap 503/);
  assert.equal(r.items.length, 0);
  assert.equal(r.stats.discovered, 0);
  assert.deepEqual(r.eventFirst.candidates, []);
});

test("[discovery] zero discovered → failed", async () => {
  const r = await run({ adapter: scriptedAdapter({ script: [], discover: "empty" }) });
  assert.equal(r.stats.status, "failed");
  assert.match(r.stats.notes.join(" "), /discovery returned no events/);
  assert.equal(r.stats.discovered, 0);
});

test("[discovery] ctx.limit stops discovery at exactly N references", async () => {
  const script = Array.from({ length: 10 }, (_, i) => acceptedEvent(`https://src.test/event/e${i}/`, `E${i}`));
  const adapter = scriptedAdapter({ script });
  const r = await run({ adapter, ctx: ctx({ limit: 3 }) });
  assert.equal(adapter.discoverCount, 3, "the generator was suspended after yielding exactly 3");
  assert.equal(r.stats.discovered, 3);
  assert.equal(adapter.fetchCalls.length, 3);
  assert.equal(r.items.length, 3);
});

test("[discovery] an exception AFTER partial discovery is still `failed`, partial refs discarded", async () => {
  const script = Array.from({ length: 5 }, (_, i) => acceptedEvent(`https://src.test/event/e${i}/`, `E${i}`));
  const adapter = scriptedAdapter({ script, discover: { yieldThenThrow: 2 }, discoverMessage: "mid" });
  const r = await run({ adapter });
  assert.equal(r.stats.status, "failed");
  assert.equal(r.stats.discovered, 0);
  assert.equal(r.items.length, 0);
  assert.equal(adapter.fetchCalls.length, 0, "nothing is fetched after a discovery failure");
});

// ════════════════════════════════════════════════════════════════════
//  FETCH  (per-event isolation)
// ════════════════════════════════════════════════════════════════════

test("[fetch] one fetch throws → one fetch-failed item, remaining events still processed", async () => {
  const adapter = scriptedAdapter({
    script: [
      acceptedEvent("https://src.test/event/e1/", "E1"),
      { url: "https://src.test/event/e2/", outcome: { fetchThrows: "ECONNRESET" } },
      acceptedEvent("https://src.test/event/e3/", "E3"),
    ],
  });
  const r = await run({ adapter });
  assert.equal(r.stats.fetchFailed, 1);
  assert.equal(r.stats.fetched, 2);
  assert.equal(r.stats.accepted, 2);
  assert.equal(r.items.length, 3);
  const failed = r.items.find((i) => i.stage === "fetch-failed")!;
  assert.equal(failed.url, "https://src.test/event/e2/");
  assert.equal(failed.reason, "ECONNRESET");
  assert.equal(r.stats.fetchFailureReasons["network/timeout"], 1);
});

test("[fetch] HTTP 500 → fetch-failed item, remaining events still processed", async () => {
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e1/", outcome: { http: 500 } },
      acceptedEvent("https://src.test/event/e2/", "E2"),
    ],
  });
  const r = await run({ adapter });
  assert.equal(r.stats.fetchFailed, 1);
  assert.equal(r.stats.fetched, 1);
  assert.equal(r.stats.accepted, 1);
  assert.equal(r.items.find((i) => i.stage === "fetch-failed")!.reason, "HTTP 500");
  assert.equal(r.stats.fetchFailureReasons["HTTP 500"], 1);
});

// ════════════════════════════════════════════════════════════════════
//  PARSE  (per-event isolation)
// ════════════════════════════════════════════════════════════════════

test("[parse] parser throws → one parse-failed item, remaining events still processed", async () => {
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e1/", outcome: { parseThrows: "Cannot read x of undefined" } },
      acceptedEvent("https://src.test/event/e2/", "E2"),
    ],
  });
  const r = await run({ adapter });
  assert.equal(r.stats.fetched, 2, "both fetched OK");
  assert.equal(r.stats.parsed, 1);
  assert.equal(r.stats.parseFailed, 1);
  assert.equal(r.stats.accepted, 1);
  const pf = r.items.find((i) => i.stage === "parse-failed")!;
  assert.match(pf.reason!, /exception: Cannot read x of undefined/);
  assert.equal(r.stats.parseFailureReasons["exception"], 1);
});

test("[parse] parser returns {ok:false} → parse-failed with reason(+detail), remaining continue", async () => {
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e1/", outcome: { parseFail: { reason: "unparseable-date", detail: "petak" } } },
      acceptedEvent("https://src.test/event/e2/", "E2"),
    ],
  });
  const r = await run({ adapter });
  assert.equal(r.stats.parsed, 1);
  assert.equal(r.stats.parseFailed, 1);
  assert.equal(r.stats.parseFailureReasons["unparseable-date"], 1);
  assert.equal(r.items.find((i) => i.stage === "parse-failed")!.reason, "unparseable-date (petak)");
  assert.equal(r.stats.accepted, 1);
});

// ════════════════════════════════════════════════════════════════════
//  RELEVANCE
// ════════════════════════════════════════════════════════════════════

test("[relevance] a rejected event never reaches venue resolution or identity", async () => {
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e1/", outcome: { event: ev({ externalId: "E1", title: "Business Meeting", categories: [] }) } },
    ],
  });
  const resolver = scriptedResolver(() => {
    throw new Error("resolver must NOT be called for a rejected event");
  });
  const r = await run({ adapter, resolver });
  assert.equal(resolver.resolveCalls.length, 0);
  assert.equal(r.stats.rejected, 1);
  assert.equal(r.stats.accepted, 0);
  const item = r.items[0];
  assert.equal(item.stage, "rejected");
  assert.equal(item.identity, undefined);
  assert.equal(item.venue, undefined);
  assert.ok(item.relevance && !item.relevance.accepted);
  assert.equal(r.stats.venuesNamed, 0);
});

test("[relevance] an exception in the relevance stage is isolated as a stage:'error' item", async () => {
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e1/", outcome: { event: ev({ externalId: "E1", reported: null as unknown as Record<string, unknown> }) } },
      acceptedEvent("https://src.test/event/e2/", "E2"),
    ],
  });
  const r = await run({ adapter });
  assert.equal(r.stats.processFailed, 1);
  assert.equal(r.stats.accepted, 1);
  assert.equal(r.stats.rejected, 0);
  const err = r.items.find((i) => i.stage === "error")!;
  assert.equal(err.url, "https://src.test/event/e1/");
  assert.match(err.reason!, /unexpected error:/);
  assert.equal(r.stats.processFailureReasons["exception"], 1);
});

// ════════════════════════════════════════════════════════════════════
//  VENUE RESOLUTION
// ════════════════════════════════════════════════════════════════════

test("[venue] matched_existing → resolvedVenueId flows into identity.venueKey", async () => {
  const adapter = scriptedAdapter({ script: [acceptedEvent("https://src.test/event/e1/", "E1")] });
  const resolver = scriptedResolver(() =>
    resolution({ status: "matched_existing", matchedVenueId: "v-77", matchTier: 2, reasonCodes: ["matched-tier-2"] }),
  );
  const r = await run({ adapter, resolver });
  const item = r.items[0];
  assert.equal(item.venue!.status, "matched_existing");
  assert.equal(item.venue!.matchedVenueId, "v-77");
  assert.equal(item.identity!.venueKey, "venue:v-77");
  assert.equal(r.stats.venueResolution.matchedExisting, 1);
  assert.equal(r.stats.venueResolution.byTier["tier 2"], 1);
});

test("[venue] safe_new_venue / needs_review / rejected never produce a resolved venue id", async () => {
  for (const status of ["safe_new_venue", "needs_review", "rejected"] as const) {
    const adapter = scriptedAdapter({ script: [acceptedEvent("https://src.test/event/e1/", "E1")] });
    const resolver = scriptedResolver(() => resolution({ status, matchedVenueId: null }));
    const r = await run({ adapter, resolver });
    const item = r.items[0];
    assert.equal(item.venue!.status, status);
    assert.match(item.identity!.venueKey, /^name:/, `${status}: identity must be name-based`);
    assert.ok(!item.identity!.venueKey.startsWith("venue:"), `${status}: never venue:<id>`);
  }
});

test("[venue] a resolver exception is isolated to that event; the rest continue", async () => {
  const adapter = scriptedAdapter({
    script: [
      acceptedEvent("https://src.test/event/e1/", "E1"),
      acceptedEvent("https://src.test/event/e2/", "E2"),
      acceptedEvent("https://src.test/event/e3/", "E3"),
    ],
  });
  const resolver = scriptedResolver((event) => {
    if (event.externalId === "E2") throw new Error("resolveMatch blew up");
    return resolution();
  });
  const r = await run({ adapter, resolver });

  assert.equal(r.stats.processFailed, 1);
  assert.equal(r.stats.accepted, 2, "E2 is NOT counted as accepted — commit is atomic");
  assert.equal(r.stats.venuesNamed, 2, "E2's venuesNamed is NOT half-incremented");
  assert.equal(r.stats.venueResolution.safeNewVenue, 2);
  assert.equal(r.stats.status, "degraded");
  assert.equal(r.items.length, 3);
  const err = r.items.find((i) => i.stage === "error")!;
  assert.equal(err.url, "https://src.test/event/e2/");
  assert.match(err.reason!, /resolveMatch blew up/);
  // invariant still holds with the process failure accounted for
  assert.equal(r.stats.accepted + r.stats.rejected + r.stats.processFailed, r.stats.parsed);
});

test("[venue] no resolver → resolution skipped, venuesNamed still counted, name-based identity", async () => {
  const adapter = scriptedAdapter({ script: [acceptedEvent("https://src.test/event/e1/", "E1")] });
  const r = await run({ adapter, resolver: null });
  assert.equal(r.stats.venueResolutionSkipped, true);
  assert.equal(r.stats.venuesNamed, 1);
  assert.equal(r.items[0].venue, undefined);
  assert.match(r.items[0].identity!.venueKey, /^name:/);
});

// ════════════════════════════════════════════════════════════════════
//  IDENTITY
// ════════════════════════════════════════════════════════════════════

test("[identity] an accepted event gets an identity with the right source key", async () => {
  const adapter = scriptedAdapter({ key: "gigs", script: [acceptedEvent("https://src.test/event/e1/", "EXT-9")] });
  const r = await run({ adapter, resolver: scriptedResolver(() => resolution()) });
  assert.equal(r.items[0].identity!.sourceKey, "gigs:EXT-9");
  assert.equal(r.items[0].identity!.localDate, "2026-07-01");
});

test("[identity] an exception in computeIdentity is isolated; the venue is NOT fed to aggregation", async () => {
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e1/", outcome: { event: ev({ externalId: "E1", startLocal: null as unknown as string }) } },
      acceptedEvent("https://src.test/event/e2/", "E2"),
    ],
  });
  const resolver = scriptedResolver((event) =>
    resolution({ candidateKey: event.externalId === "E1" ? "c-e1-broken" : "c-e2-ok" }),
  );
  const r = await run({ adapter, resolver });

  assert.equal(r.stats.processFailed, 1);
  assert.equal(r.stats.accepted, 1, "the identity-failing event is not counted as accepted");
  assert.equal(r.items.find((i) => i.stage === "error")!.url, "https://src.test/event/e1/");
  assert.equal(resolver.resolveCalls.length, 2, "the resolver still runs for the identity-failing event");
  const keys = r.eventFirst.candidates.map((c) => c.candidateKey);
  assert.ok(!keys.includes("c-e1-broken"), "the fully-failed event contributes nothing downstream");
  assert.ok(keys.includes("c-e2-ok"), "the healthy event still contributes");
});

// ════════════════════════════════════════════════════════════════════
//  AGGREGATION
// ════════════════════════════════════════════════════════════════════

test("[aggregation] only safe_new_venue / needs_review resolutions reach the candidate list", async () => {
  const statuses: EventVenueResolution["status"][] = [
    "matched_existing",
    "safe_new_venue",
    "needs_review",
    "rejected",
  ];
  const adapter = scriptedAdapter({
    script: statuses.map((_, i) => acceptedEvent(`https://src.test/event/e${i}/`, `E${i}`)),
  });
  let i = 0;
  const resolver = scriptedResolver(() => {
    const s = statuses[i++];
    return resolution({
      status: s,
      matchedVenueId: s === "matched_existing" ? "v-1" : null,
      matchTier: s === "matched_existing" ? 1 : null,
      candidateKey: `k-${s}`,
    });
  });
  const r = await run({ adapter, resolver });

  const keys = r.eventFirst.candidates.map((c) => c.candidateKey).sort();
  assert.deepEqual(keys, ["k-needs_review", "k-safe_new_venue"]);
  assert.equal(r.eventFirst.candidates.find((c) => c.candidateKey === "k-safe_new_venue")!.status, "safe_new_venue");
  assert.equal(r.eventFirst.candidates.find((c) => c.candidateKey === "k-needs_review")!.status, "needs_review");
});

test("[aggregation] an aggregation exception cannot silently yield a 'successful' partial report", async () => {
  const adapter = scriptedAdapter({
    script: [
      acceptedEvent("https://src.test/event/e1/", "E1"),
      acceptedEvent("https://src.test/event/e2/", "E2"),
    ],
  });
  let n = 0;
  // two distinct candidates, same city + eventCount → the aggregator's sort
  // reaches `.normalizedName.localeCompare(...)`, which throws on the null.
  const resolver = scriptedResolver(() =>
    resolution({
      candidateKey: `k${n++}`,
      normalizedName: null as unknown as string,
      status: "safe_new_venue",
    }),
  );
  const r = await run({ adapter, resolver });

  assert.equal(r.stats.status, "degraded", "aggregation failure downgrades the run");
  assert.match(r.stats.notes.join(" "), /aggregation failed/);
  assert.deepEqual(r.eventFirst.candidates, [], "candidate list omitted, not partially built");
  assert.equal(r.stats.accepted, 2, "per-event stats are fully intact");
  assert.equal(r.items.filter((i) => i.stage === "accepted").length, 2);
});

// ════════════════════════════════════════════════════════════════════
//  RUN HEALTH
// ════════════════════════════════════════════════════════════════════

test("[health] exactly 50% fetch failure → degraded", async () => {
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e0/", outcome: { http: 502 } },
      { url: "https://src.test/event/e1/", outcome: { http: 502 } },
      acceptedEvent("https://src.test/event/e2/", "E2"),
      acceptedEvent("https://src.test/event/e3/", "E3"),
    ],
  });
  const r = await run({ adapter });
  assert.equal(r.stats.fetchFailed, 2);
  assert.equal(r.stats.discovered, 4);
  assert.equal(r.stats.status, "degraded");
  assert.match(r.stats.notes.join(" "), /high fetch-failure rate: 2\/4/);
});

test("[health] exactly 30% parse failure → degraded", async () => {
  const script: ScriptEntry[] = [];
  for (let i = 0; i < 10; i++) {
    script.push(
      i < 3
        ? { url: `https://src.test/event/e${i}/`, outcome: { parseFail: { reason: "missing-title" } } }
        : acceptedEvent(`https://src.test/event/e${i}/`, `E${i}`),
    );
  }
  const r = await run({ adapter: scriptedAdapter({ script }) });
  assert.equal(r.stats.parsed, 7);
  assert.equal(r.stats.parseFailed, 3);
  assert.equal(r.stats.status, "degraded");
  assert.match(r.stats.notes.join(" "), /high parse-failure rate: 3\/10/);
});

test("[health] just under the thresholds → ok", async () => {
  // 1/4 fetch failures (< 0.5) — below threshold
  const adapter = scriptedAdapter({
    script: [
      { url: "https://src.test/event/e0/", outcome: { http: 500 } },
      acceptedEvent("https://src.test/event/e1/", "E1"),
      acceptedEvent("https://src.test/event/e2/", "E2"),
      acceptedEvent("https://src.test/event/e3/", "E3"),
    ],
  });
  const r = await run({ adapter });
  assert.equal(r.stats.status, "ok");
});

test("[health] successful discovery with zero accepted events (all rejected) → ok", async () => {
  const adapter = scriptedAdapter({
    script: [0, 1, 2].map((i) => ({
      url: `https://src.test/event/e${i}/`,
      outcome: { event: ev({ externalId: `E${i}`, title: "Poslovni Sastanak", categories: [] }) } as Outcome,
    })),
  });
  const r = await run({ adapter });
  assert.equal(r.stats.discovered, 3);
  assert.equal(r.stats.rejected, 3);
  assert.equal(r.stats.accepted, 0);
  assert.equal(r.stats.status, "ok");
});

// ════════════════════════════════════════════════════════════════════
//  COUNTER INVARIANTS
// ════════════════════════════════════════════════════════════════════

test("[counters] every invariant holds across a mixed run", async () => {
  const script: ScriptEntry[] = [
    { url: "https://src.test/event/f/", outcome: { fetchThrows: "net" } },
    { url: "https://src.test/event/h/", outcome: { http: 404 } },
    { url: "https://src.test/event/pt/", outcome: { parseThrows: "boom" } },
    { url: "https://src.test/event/pf/", outcome: { parseFail: { reason: "missing-title" } } },
    { url: "https://src.test/event/rej/", outcome: { event: ev({ externalId: "REJ", title: "Konferencija o Nauci", categories: [] }) } },
    { url: "https://src.test/event/p1/", outcome: { event: ev({ externalId: "P1", title: "DJ Set", categories: ["koncert"] }) } },
    { url: "https://src.test/event/s1/", outcome: { event: ev({ externalId: "S1", title: "Nastup Komičara", categories: ["stand-up"] }) } },
    { url: "https://src.test/event/city/", outcome: { event: ev({ externalId: "C1", categories: ["koncert"], venue: { name: "", city: "Beograd" } }) } },
  ];
  const r = await run({
    adapter: scriptedAdapter({ script }),
    resolver: scriptedResolver(() => resolution()),
  });
  const s = r.stats;

  assert.ok(s.fetched <= s.discovered, "fetched <= discovered");
  assert.equal(s.parsed + s.parseFailed, s.fetched, "parsed + parseFailed === fetched");
  assert.equal(s.accepted + s.rejected + s.processFailed, s.parsed, "accepted + rejected + processFailed === parsed");
  assert.equal(s.acceptedPrimary + s.acceptedSecondary, s.accepted, "acceptedPrimary + acceptedSecondary === accepted");
  assert.equal(s.venuesNamed + s.noVenueInSource, s.accepted, "venuesNamed + noVenueInSource === accepted (resolver present)");
  assert.ok(s.plannedCanonicalInserts <= s.accepted, "plannedCanonicalInserts <= accepted");
  assert.equal(r.items.length, s.discovered, "one item per discovered ref");

  // the concrete shape for this script
  assert.deepEqual(
    { fetched: s.fetched, parsed: s.parsed, accepted: s.accepted, rejected: s.rejected, processFailed: s.processFailed },
    { fetched: 6, parsed: 4, accepted: 3, rejected: 1, processFailed: 0 },
  );
  assert.equal(s.acceptedPrimary, 2); // "DJ Set" (koncert) + city-only (koncert)
  assert.equal(s.acceptedSecondary, 1); // stand-up
  assert.equal(s.venuesNamed, 2);
  assert.equal(s.noVenueInSource, 1);
});

// ════════════════════════════════════════════════════════════════════
//  DRY-RUN / SIDE-EFFECT DISCIPLINE
// ════════════════════════════════════════════════════════════════════

test("[dry-run] the engine mutates neither the adapter script nor the resolver state", async () => {
  const script: ScriptEntry[] = [
    acceptedEvent("https://src.test/event/e1/", "E1"),
    acceptedEvent("https://src.test/event/e2/", "E2"),
  ];
  const scriptSnapshot = JSON.stringify(script);
  const resolver = scriptedResolver(() => resolution());
  const knownBefore = JSON.stringify(resolver.knownCities);
  const enabledBefore = JSON.stringify(resolver.enabledCities);

  await run({ adapter: scriptedAdapter({ script }), resolver });

  assert.equal(JSON.stringify(script), scriptSnapshot, "adapter input (events, refs) unchanged");
  assert.equal(JSON.stringify(resolver.knownCities), knownBefore);
  assert.equal(JSON.stringify(resolver.enabledCities), enabledBefore);
});

test("[dry-run] the same event object is passed to the resolver by reference and never rewritten", async () => {
  const event = ev({ externalId: "E1" });
  const before = JSON.stringify(event);
  const adapter = scriptedAdapter({ script: [{ url: event.sourceUrl, outcome: { event } }] });
  const resolver = scriptedResolver(() => resolution());
  await run({ adapter, resolver });
  assert.equal(resolver.resolveCalls[0], event, "engine passes the parsed event through, no clone");
  assert.equal(JSON.stringify(event), before, "engine never writes to the event");
});

test("[dry-run] the report always carries the read-only notes", async () => {
  const r = await run({ adapter: scriptedAdapter({ script: [acceptedEvent("https://src.test/event/e1/", "E1")] }) });
  assert.match(r.stats.notes.join("\n"), /no database writes/);
  assert.match(r.stats.notes.join("\n"), /events table not read/);
});

// ════════════════════════════════════════════════════════════════════
//  DETERMINISM
// ════════════════════════════════════════════════════════════════════

test("[determinism] identical inputs produce equivalent stats", async () => {
  const mkScript = (): ScriptEntry[] => [
    acceptedEvent("https://src.test/event/e1/", "E1"),
    { url: "https://src.test/event/e2/", outcome: { http: 404 } },
    acceptedEvent("https://src.test/event/e3/", "E3"),
  ];
  const a = await run({ adapter: scriptedAdapter({ script: mkScript() }), resolver: scriptedResolver(() => resolution()) });
  const b = await run({ adapter: scriptedAdapter({ script: mkScript() }), resolver: scriptedResolver(() => resolution()) });
  assert.deepEqual({ ...a.stats, durationMs: 0 }, { ...b.stats, durationMs: 0 });
});

test("[determinism] event/reference ordering does not change the aggregate candidate identity", async () => {
  const urls = ["https://src.test/event/e1/", "https://src.test/event/e2/", "https://src.test/event/e3/"];
  const mk = (order: string[]): ScriptEntry[] =>
    order.map((u, i) => ({ url: u, outcome: { event: ev({ externalId: `E${i}`, sourceUrl: u }) } as Outcome }));
  // all three events resolve to the SAME event-first candidate
  const resolver = () => scriptedResolver(() => resolution({ candidateKey: "shared", status: "safe_new_venue" }));

  const forward = await run({ adapter: scriptedAdapter({ script: mk(urls) }), resolver: resolver() });
  const reversed = await run({ adapter: scriptedAdapter({ script: mk([...urls].reverse()) }), resolver: resolver() });

  for (const r of [forward, reversed]) {
    assert.equal(r.eventFirst.candidates.length, 1);
    assert.equal(r.eventFirst.candidates[0].candidateKey, "shared");
    assert.equal(r.eventFirst.candidates[0].eventCount, 3);
    assert.equal(r.eventFirst.candidates[0].status, "safe_new_venue");
    assert.equal(r.stats.plannedCanonicalInserts, 3);
  }
});
