/**
 * In-memory `SourceAdapter` for tests and for proving that a new source plugs
 * into the engine with zero engine changes.
 *
 * A real adapter (GIGS TIX, an OSM adapter, a venue-website adapter) does the
 * same three things — discover / fetch / parse — but over HTTP and HTML. The
 * engine cannot tell the difference.
 */

import type {
  AdapterContext,
  EntityKind,
  NormalizedRecord,
  ParsedItem,
  RawItem,
  SourceAdapter,
  SourceCapabilities,
  SourceItemRef,
} from "../types.ts";

/** A fixture "page" the fake source would serve. */
export interface FakeItem {
  externalId: string;
  kind: EntityKind;
  /** Arbitrary JSON payload — the adapter's `parse` turns it into records. */
  payload: NormalizedRecord;
  lastModified?: string;
}

/** A fixture venue page the source hosts, addressable by `fetchLinked`. */
export interface FakeVenuePage {
  externalId: string;
  record: NormalizedRecord;
}

export interface InMemoryAdapterOptions {
  key: string;
  capabilities?: Partial<SourceCapabilities>;
  items: FakeItem[];
  venuePages?: FakeVenuePage[];
  /** Throw from discover(), to exercise the "source failure" path. */
  failDiscovery?: boolean;
}

export function createInMemoryAdapter(opts: InMemoryAdapterOptions): SourceAdapter {
  const venuePages = new Map((opts.venuePages ?? []).map((p) => [p.externalId, p.record]));

  return {
    key: opts.key,
    capabilities: {
      kinds: [...new Set(opts.items.map((i) => i.kind))],
      discovery: "index",
      givesExternalId: true,
      givesCoordinates: true,
      givesVenuePages: venuePages.size > 0,
      emitsCancellations: true,
      ...opts.capabilities,
    },

    async *discover(): AsyncIterable<SourceItemRef> {
      if (opts.failDiscovery) throw new Error("simulated source outage");
      for (const item of opts.items) {
        yield {
          url: `memory://${opts.key}/${item.externalId}`,
          externalId: item.externalId,
          kindHint: item.kind,
          lastModified: item.lastModified ?? null,
        };
      }
    },

    async fetch(ref: SourceItemRef): Promise<RawItem> {
      const item = opts.items.find((i) => i.externalId === ref.externalId);
      return {
        ref,
        url: ref.url ?? "",
        status: item ? 200 : 404,
        body: item ? JSON.stringify(item.payload) : "",
        contentType: "application/json",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      };
    },

    parse(raw: RawItem): ParsedItem {
      if (raw.status !== 200) return { ok: false, reason: `http-${raw.status}` };
      // No hash stamping: the engine computes the canonical change-detection
      // hash itself from the comparable representation. Adapters never do this.
      const record = JSON.parse(raw.body) as NormalizedRecord;
      return { ok: true, records: [record] };
    },

    async fetchLinked(
      kind: EntityKind,
      externalId: string,
      _ctx: AdapterContext,
    ): Promise<NormalizedRecord | null> {
      if (kind !== "venue") return null;
      const page = venuePages.get(externalId);
      if (!page) return null;
      // Hand back a FRESH deep copy — the same serialize/deserialize round-trip
      // `fetch` + `parse` already do for the main item path. A real adapter
      // fetches + parses a page and returns a brand-new object; it never shares
      // a reference to its own retained state. The engine caches this value in
      // `linkedVenueCache` and reuses it for every event at the venue, so a
      // shared reference would be a run-wide mutation hazard.
      return JSON.parse(JSON.stringify(page)) as NormalizedRecord;
    },
  };
}
