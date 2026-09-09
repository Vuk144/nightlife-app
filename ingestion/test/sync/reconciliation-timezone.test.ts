/**
 * Regression: reconciliation must decide "is this event in the past / frozen?"
 * from the event's ABSOLUTE UTC instant, timezone-independently — never from a
 * zone-less local wall-clock parsed with `Date.parse` (which applies the host
 * process's timezone).
 *
 * Covers `toInstantMs` (pure) and the engine's `buildSnapshots` frozen logic
 * exercised through `planSync`. Runs every scenario under several process
 * timezones and event timezones with different UTC offsets.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planSync } from "../../src/sync/engine.ts";
import { toComparableInstant, toInstantMs } from "../../src/sync/time-zone.ts";
import {
  InMemoryCanonicalStore,
  type CanonicalEvent,
  type CityRecord,
  type SourceLink,
} from "../../src/sync/store.ts";
import { createInMemoryAdapter } from "../../src/sync/adapters/in-memory.ts";
import { provider, eventRecord, fakeItem } from "./world.ts";

/** Run `fn` once per process timezone; restore TZ afterwards. */
function underEachProcessTz(fn: (tz: string) => void): void {
  const saved = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Tokyo", "America/New_York", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      fn(tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}
async function underEachProcessTzAsync(fn: (tz: string) => Promise<void>): Promise<void> {
  const saved = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Tokyo", "America/New_York", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      await fn(tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

// ── toInstantMs: pure, timezone-independent ────────────────────────────
test("toInstantMs: explicit-offset strings resolve to their absolute instant", () => {
  underEachProcessTz(() => {
    assert.equal(toInstantMs("2026-07-01T20:00:00.000Z", null), Date.UTC(2026, 6, 1, 20, 0, 0));
    assert.equal(toInstantMs("2026-07-01T20:00:00+00:00", null), Date.UTC(2026, 6, 1, 20, 0, 0));
    assert.equal(toInstantMs("2026-07-01T15:00:00-05:00", null), Date.UTC(2026, 6, 1, 20, 0, 0));
    assert.equal(toInstantMs("2026-07-01T22:00:00+02:00", null), Date.UTC(2026, 6, 1, 20, 0, 0));
  });
});

test("toInstantMs: a zone-less wall-clock is interpreted as UTC, NOT process-local", () => {
  underEachProcessTz((tz) => {
    // 22:00 with no zone -> 22:00Z regardless of TZ. Date.parse would give a
    // different answer under Asia/Tokyo vs America/New_York.
    assert.equal(
      toInstantMs("2026-07-01T22:00", null),
      Date.UTC(2026, 6, 1, 22, 0, 0),
      `TZ=${tz}`,
    );
    assert.equal(toInstantMs("2026-07-01T22:00:30", null), Date.UTC(2026, 6, 1, 22, 0, 30));
  });
});

test("toInstantMs: wall-clock + IANA zone converts correctly, with DST", () => {
  underEachProcessTz(() => {
    // Europe/Belgrade: summer = UTC+2, winter = UTC+1
    assert.equal(toInstantMs("2026-07-01T22:00", "Europe/Belgrade"), Date.UTC(2026, 6, 1, 20, 0, 0));
    assert.equal(toInstantMs("2026-01-01T22:00", "Europe/Belgrade"), Date.UTC(2026, 0, 1, 21, 0, 0));
    // Pacific/Honolulu: UTC-10, no DST — a very different offset
    assert.equal(toInstantMs("2026-07-01T22:00", "Pacific/Honolulu"), Date.UTC(2026, 6, 2, 8, 0, 0));
  });
});

test("toInstantMs: date-only is UTC midnight; garbage is null", () => {
  underEachProcessTz(() => {
    assert.equal(toInstantMs("2026-07-01", null), Date.UTC(2026, 6, 1, 0, 0, 0));
    assert.equal(toInstantMs("2026-07-01", "Europe/Belgrade"), Date.UTC(2026, 6, 1, 0, 0, 0));
  });
  assert.equal(toInstantMs("not a date", null), null);
  assert.equal(toInstantMs(null, null), null);
});

test("toComparableInstant: zone-less wall-clock canonicalises to UTC, not process-local", () => {
  underEachProcessTz(() => {
    assert.equal(toComparableInstant("2026-07-01T22:00", null), "2026-07-01T22:00:00.000Z");
    assert.equal(toComparableInstant("2026-07-01T22:00", "Europe/Belgrade"), "2026-07-01T20:00:00.000Z");
    assert.equal(toComparableInstant("2026-07-01T20:00:00+00:00", null), "2026-07-01T20:00:00.000Z");
  });
});

// ── engine buildSnapshots: frozen/past decided on the absolute instant ─
function cityRow(id: string, cc: string, name: string, tz: string): CityRecord {
  return { id, countryCode: cc, name, timeZone: tz };
}

function persistedEvent(startLocal: string, timeZone: string | null): CanonicalEvent {
  return {
    id: "ev-old",
    venueId: "v-bg",
    title: "Old Party",
    description: null,
    startLocal,
    timeZone,
    endLocal: null,
    status: "scheduled",
    ticketUrl: null,
    coverImageUrl: null,
    canonicalSourceKey: "gigstix",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function oldLink(): SourceLink {
  return {
    id: "l-old",
    kind: "event",
    sourceKey: "gigstix",
    externalId: "OLD-1",
    sourceUrl: null,
    canonicalId: "ev-old",
    contentHash: "h",
    comparableFields: {},
    reported: {},
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    sourceStatus: "active",
    consecutiveMisses: 0,
  };
}

function storeWith(startLocal: string, timeZone: string | null): InMemoryCanonicalStore {
  return new InMemoryCanonicalStore({
    cities: [cityRow("city-bg", "RS", "Belgrade", "Europe/Belgrade")],
    venues: [
      {
        id: "v-bg",
        cityId: "city-bg",
        cityName: "Belgrade",
        countryCode: "RS",
        name: "Tvornica",
        normalizedName: "tvornica",
        address: null,
        coordinates: null,
        coordinatesSource: null,
        website: null,
        wikidata: null,
        openingHours: null,
        description: null,
        openingTime: null,
        closingTime: null,
        isActive: true,
        sourceKey: null,
        externalId: null,
        sourceUrl: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    events: [persistedEvent(startLocal, timeZone)],
    sourceLinks: [oldLink()],
  });
}

/** A healthy run that discovers ONE unrelated event, so reconciliation runs. */
function healthyAdapter() {
  return createInMemoryAdapter({
    key: "gigstix",
    items: [
      fakeItem(
        eventRecord({
          sourceKey: "gigstix",
          externalId: "NEW-1",
          countryCode: "RS",
          cityText: "Beograd",
          title: "Fresh Party",
          startLocal: "2027-06-01T22:00",
          venueName: "Tvornica",
          sourceVenueId: null,
        }),
      ),
    ],
  });
}

async function reconcileAction(startLocal: string, timeZone: string | null, now: string) {
  const store = storeWith(startLocal, timeZone);
  const plan = await planSync({
    adapter: healthyAdapter(),
    source: provider().source("gigstix")!,
    config: provider(),
    store,
    now,
    runId: "r1",
  });
  assert.equal(plan.stats.status, "ok", "run must be healthy so reconciliation runs");
  assert.equal(plan.reconciliation.reconciled, true);
  return plan.reconciliation.actions.find((a) => a.key === "gigstix:OLD-1")!;
}

test("[reconciliation] a PAST event (by absolute instant) is frozen -> no-op, same under any process TZ", async () => {
  // 22:00 Belgrade summer = 20:00Z. `now` is 20:30Z -> the event has started.
  await underEachProcessTzAsync(async (tz) => {
    const a = await reconcileAction("2026-07-01T22:00", "Europe/Belgrade", "2026-07-01T20:30:00.000Z");
    assert.equal(a.transition, "no-op", `TZ=${tz}`);
    assert.match(a.note, /frozen/, `TZ=${tz}`);
  });
});

test("[reconciliation] a FUTURE event (by absolute instant) is NOT frozen -> mark-stale, same under any process TZ", async () => {
  // `now` is 19:30Z -> before the 20:00Z start.
  await underEachProcessTzAsync(async (tz) => {
    const a = await reconcileAction("2026-07-01T22:00", "Europe/Belgrade", "2026-07-01T19:30:00.000Z");
    assert.equal(a.transition, "mark-stale", `TZ=${tz}`);
  });
});

test("[reconciliation] a second event timezone with a different offset (Pacific/Honolulu UTC-10)", async () => {
  // 22:00 Honolulu = 08:00Z next day.
  await underEachProcessTzAsync(async (tz) => {
    const past = await reconcileAction("2026-07-01T22:00", "Pacific/Honolulu", "2026-07-02T09:00:00.000Z");
    assert.equal(past.transition, "no-op", `past, TZ=${tz}`);
    const future = await reconcileAction("2026-07-01T22:00", "Pacific/Honolulu", "2026-07-02T07:00:00.000Z");
    assert.equal(future.transition, "mark-stale", `future, TZ=${tz}`);
  });
});

test("[reconciliation] an already-absolute startLocal (Supabase-style offset string) is handled", async () => {
  // The Supabase store returns `startLocal` = the offset-bearing `events.start_at`.
  await underEachProcessTzAsync(async (tz) => {
    const a = await reconcileAction("2026-07-01T20:00:00+00:00", null, "2026-07-01T20:30:00.000Z");
    assert.equal(a.transition, "no-op", `TZ=${tz}`);
  });
});

test("[reconciliation] a zone-less startLocal with NO timeZone is treated as UTC (not process-local)", async () => {
  // If this used Date.parse(startLocal) it would flip between frozen/not-frozen
  // depending on the process TZ. As UTC: 22:00Z start, now 22:30Z -> frozen.
  await underEachProcessTzAsync(async (tz) => {
    const past = await reconcileAction("2026-07-01T22:00", null, "2026-07-01T22:30:00.000Z");
    assert.equal(past.transition, "no-op", `TZ=${tz}`);
    const future = await reconcileAction("2026-07-01T22:00", null, "2026-07-01T21:30:00.000Z");
    assert.equal(future.transition, "mark-stale", `TZ=${tz}`);
  });
});
