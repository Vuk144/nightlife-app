/**
 * Characterization / regression tests for `src/sources/osm-overpass.ts`.
 *
 * STEP 0 of the audited refactor: these lock in the CURRENT behavior of
 * `buildOverpassQuery`, `fetchOverpass`, `parseOverpassVenues` and
 * `collectVenuesForTarget` so a later behavior-preserving refactor is provably
 * safe.
 *
 * A test that pins a KNOWN BUG from the audit is tagged `[characterizes bug Bn]`;
 * once the fix lands it is UPDATED (not deleted) into a `[Bn regression]` that
 * locks the corrected behavior.
 *
 *   B1  FIXED (Step 5) — a non-retryable HTTP status (400/401/403/404/500/…) now
 *       fails fast: it never enters the generic retry `catch`, so no second
 *       request and no back-off. Guarded by the `[B1 regression]` tests below.
 *   B2  FIXED (Step 6A) — an Overpass 200 with a meaningful top-level `remark`
 *       is now a (transient) failure whether or not `elements` is present; a
 *       degraded / partial result is never accepted. Guarded by `[B2 regression]`.
 *   B3  FIXED (Step 6B) — `parseOverpassVenues` now deduplicates by source
 *       identity (`type/id`) across ALL buckets, so a duplicate `invalid` /
 *       `excluded` element is processed and counted once; `fetched` reflects
 *       unique elements. Guarded by `[B3 regression]`. Elements with no
 *       resolvable identity (`"(unknown)"`) are still each kept.
 *   B4  FIXED (Step 6C) — the default client abort timeout is derived from the
 *       Overpass server `[timeout:…]` budget plus a named margin, so it can
 *       never be shorter than the server timeout again. Guarded by
 *       `[B4 regression]`.
 *   B5  FIXED (Step 6D) — a retryable HTTP response now has its body cancelled
 *       (`response.body?.cancel()`) before the back-off, releasing the socket.
 *       Guarded by `[B5 regression]`. The definitive-error path is out of scope.
 *
 * The fake-`fetch` + mock-timer pattern mirrors `test/events/http.test.ts`.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildOverpassQuery,
  fetchOverpass,
  parseOverpassVenues,
  collectVenuesForTarget,
} from "../src/sources/osm-overpass.ts";
import { OVERPASS_SERVER_TIMEOUT_S } from "../src/sources/osm-overpass/query.ts";
import {
  CLIENT_TIMEOUT_MARGIN_MS,
  DEFAULT_CLIENT_TIMEOUT_MS,
} from "../src/sources/osm-overpass/transport.ts";
import { rescueNameOverpass } from "../src/rescue.ts";
import type { Config } from "../src/config.ts";
import type { IngestionTarget } from "../src/targets.ts";
import type { OverpassElement, OverpassResponse } from "../src/types.ts";

// ── shared fixtures ─────────────────────────────────────────────────

/** The real, shipped Belgrade target (kept in sync with `src/targets.ts`). */
const BELGRADE: IngestionTarget = {
  countryId: "RS",
  cityName: "Belgrade",
  osmRelationId: 2728438,
};

/** A synthetic target with no rescue rows and no rescue refs for its city. */
const NO_RESCUE: IngestionTarget = {
  countryId: "ZZ",
  cityName: "Nowhereville",
  osmRelationId: 987654,
};

const CONFIG: Config = {
  supabaseUrl: "https://project.supabase.co",
  supabaseServiceRoleKey: "service-role-test-key",
  overpassUrl: "https://overpass.test/api/interpreter",
  overpassUserAgent: "nightlife-ingestion-test/0.0 (+https://example.test)",
};

const QUERY = "[out:json][timeout:5];\narea(id:1)->.a;\n(node(area.a););\nout tags center;";

// ════════════════════════════════════════════════════════════════════
//  1. buildOverpassQuery — golden / structural
// ════════════════════════════════════════════════════════════════════

/**
 * Byte-for-byte snapshot of `buildOverpassQuery(BELGRADE)` as it stands today.
 * `buildOverpassQuery` always joins with "\n"; the `\r\n` scrub only accounts
 * for this source file being checked out with CRLF endings (core.autocrlf).
 * `[no-CR]` below independently pins that the emitted query is LF-only.
 */
const GOLDEN_BELGRADE_QUERY = `[out:json][timeout:240];
area(id:3602728438)->.bg;
(
  // Layer A — nightlife by definition
  nwr["amenity"="nightclub"](area.bg);
  nwr["amenity"="bar"](area.bg);
  nwr["amenity"="pub"](area.bg);
  nwr["amenity"="biergarten"](area.bg);
  nwr["amenity"="music_venue"](area.bg);
  nwr["amenity"="karaoke_box"](area.bg);
  nwr["club"~"^(music|nightlife|social)$"](area.bg);
  nwr["karaoke"="yes"](area.bg);
  nwr["leisure"~"^(dance|karaoke)$"](area.bg);
  // Regional name layers — kafana / splav / shisha
  nwr["amenity"~"^(restaurant|bar|pub|cafe)$"]["name"~"kafana|кафана|Кафана|mehana|meana|механа|Механа|birtija|биртија|Биртија|krčma|krcma|крчма|Крчма|taverna|таверна|Таверна|čarda|carda|чарда|Чарда",i](area.bg);
  nwr["amenity"~"^(restaurant|bar|pub|nightclub)$"]["name"~"splav|сплав|Сплав",i](area.bg);
  nwr["amenity"~"^(cafe|bar|pub|restaurant)$"]["name"~"shisha|hookah|nargila|nargile|narghile|наргил|наргил",i](area.bg);
  nwr["amenity"~"^(cafe|restaurant)$"]["shisha"="yes"](area.bg);
  // Layer B — base category + a documented signal (server-gated)
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["live_music"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["music"~"^(live|dj)$"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["music:live"="yes"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["concert"="yes"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["dancing"="yes"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["dancefloor"="yes"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["stage"="yes"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|theatre|arts_centre|community_centre|social_centre|events_venue)$"]["karaoke"="yes"](area.bg);
  nwr["amenity"="theatre"]["theatre:type"~"^(concert_hall|music|cabaret)$"](area.bg);
  nwr["amenity"="theatre"]["theatre:genre"~"^(comedy|cabaret|stand_up)$"](area.bg);
  nwr["amenity"="community_centre"]["community_centre"~"^(music|arts|youth_centre)$"](area.bg);
  nwr["amenity"~"^(restaurant|cafe)$"]["bar"="yes"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|pub|bar)$"]["microbrewery"="yes"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|pub|bar)$"]["brewery"](area.bg);
  nwr["amenity"~"^(restaurant|cafe|pub|bar)$"]["real_ale"="yes"](area.bg);
  nwr["craft"="brewery"]["microbrewery"="yes"](area.bg);
  nwr["craft"="brewery"]["taproom"="yes"](area.bg);
  nwr["craft"="brewery"]["amenity"~"^(bar|pub)$"](area.bg);
  node(id:12872107296,4118716889,6844070707,1634937968,1634938018,1634937981,13045146275,6782874303);
  way(id:41234985,23671766,393274192,150590534,149635378);
);
out tags center;`.replace(/\r\n/g, "\n");

test("buildOverpassQuery: byte-for-byte golden for the shipped Belgrade target", () => {
  const q = buildOverpassQuery(BELGRADE);
  assert.equal(q, GOLDEN_BELGRADE_QUERY);
});

test("buildOverpassQuery: [no-CR] the emitted query is LF-only regardless of source file endings", () => {
  assert.doesNotMatch(buildOverpassQuery(BELGRADE), /\r/);
});

test("buildOverpassQuery: area id is the OSM relation id + the 3.6e9 Overpass offset", () => {
  assert.match(buildOverpassQuery(BELGRADE), /area\(id:3602728438\)->\.bg;/);
  assert.match(buildOverpassQuery(NO_RESCUE), /area\(id:3600987654\)->\.bg;/);
});

test("buildOverpassQuery: a target with rescue refs emits Layer C id clauses, NOT a by-name clause", () => {
  // Every shipped RESCUE_ENTRIES row (all cities) currently carries an `osmRef`,
  // so `rescueNameOverpass` returns "" and the `// Layer C — curated rescue
  // (by name)` branch of buildOverpassQuery is presently unreachable for every
  // real target. This pins that state; adding a ref-less rescue row later will
  // (correctly) fail this test and force a real by-name golden.
  assert.equal(rescueNameOverpass("RS", "Belgrade"), "");

  const q = buildOverpassQuery(BELGRADE);
  assert.doesNotMatch(q, /Layer C — curated rescue \(by name\)/);
  assert.doesNotMatch(q, /\["name"~"\^\(/); // no anchored name-alternation clause
  // …but the id-based Layer C clauses ARE present (node then way, no relation):
  assert.match(
    q,
    /\n  node\(id:12872107296,4118716889,6844070707,1634937968,1634938018,1634937981,13045146275,6782874303\);\n/,
  );
  assert.match(q, /\n  way\(id:41234985,23671766,393274192,150590534,149635378\);\n/);
  assert.doesNotMatch(q, /\n  relation\(id:/);
});

test("buildOverpassQuery: a target with no rescue rows and no rescue refs has no Layer C section at all", () => {
  const q = buildOverpassQuery(NO_RESCUE);
  assert.doesNotMatch(q, /Layer C/);
  assert.doesNotMatch(q, /node\(id:/);
  assert.doesNotMatch(q, /way\(id:/);
  assert.doesNotMatch(q, /relation\(id:/);
  // the union still closes straight after the brewery clauses:
  assert.match(q, /nwr\["craft"="brewery"\]\["amenity"~"\^\(bar\|pub\)\$"\]\(area\.bg\);\n\);\nout tags center;$/);
  assert.doesNotMatch(q, /\r/);
});

// ════════════════════════════════════════════════════════════════════
//  fake fetch + timer pump  (mirrors test/events/http.test.ts)
// ════════════════════════════════════════════════════════════════════

interface FakeRes {
  status: number;
  /** Value returned by `response.json()`. */
  json?: unknown;
  /** When true, `response.json()` rejects (unparseable body). */
  jsonThrows?: boolean;
  /**
   * When set, the fake exposes a `response.body` whose `cancel()` invokes this
   * (so a test can observe the transport releasing an un-read error body).
   * Left unset → `body` is `null`, exactly as before.
   */
  onBodyCancel?: () => void;
}

/** A step the fake `fetch` replays: a response, a thrown error, or "hang until aborted". */
type Step = FakeRes | Error | "abort-pending";

function fakeResponse(o: FakeRes): Response {
  return {
    ok: o.status >= 200 && o.status < 300,
    status: o.status,
    url: "",
    headers: { get: () => null },
    body: o.onBodyCancel
      ? {
          cancel: async () => {
            o.onBodyCancel?.();
          },
        }
      : null,
    json: async () => {
      if (o.jsonThrows) throw new SyntaxError("Unexpected token < in JSON at position 0");
      return o.json ?? {};
    },
    text: async () => "",
  } as unknown as Response;
}

type FetchCall = { url: string; init: RequestInit };

/** Install a fake `globalThis.fetch` that replays `script` (last entry repeats). */
function installFetch(
  t: { after: (fn: () => void) => void },
  script: Step[],
): { calls: FetchCall[] } {
  const real = globalThis.fetch;
  const calls: FetchCall[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step === "abort-pending") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () =>
          reject(signal.reason ?? new Error("aborted")),
        );
      });
    }
    if (step instanceof Error) throw step;
    return fakeResponse(step);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return { calls };
}

/**
 * Drive an async factory to completion under fake `setTimeout`: flush
 * microtasks, then advance the clock past whatever back-off it parked on, and
 * repeat. Returns `{ value }` or `{ error }`.
 */
async function run<T>(
  t: { mock: typeof mock },
  factory: () => Promise<T>,
): Promise<{ value?: T; error?: unknown }> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const out: { value?: T; error?: unknown } = {};
    void factory().then(
      (v) => {
        done = true;
        out.value = v;
      },
      (e) => {
        done = true;
        out.error = e;
      },
    );
    for (let n = 0; n < 80 && !done; n++) {
      await new Promise((r) => setImmediate(r));
      if (!done) t.mock.timers.tick(10_000);
    }
    assert.ok(done, "operation did not settle under fake timers");
    return out;
  } finally {
    t.mock.timers.reset();
  }
}

const elementsBody = (elements: OverpassElement[]): FakeRes => ({
  status: 200,
  json: { elements } satisfies OverpassResponse,
});

// ════════════════════════════════════════════════════════════════════
//  2. fetchOverpass
// ════════════════════════════════════════════════════════════════════

test("fetchOverpass: happy path returns the parsed payload unchanged", async (t) => {
  const payload = { elements: [{ type: "node", id: 1, lat: 1, lon: 2, tags: {} }] };
  installFetch(t, [{ status: 200, json: payload }]);

  const res = await fetchOverpass(QUERY, CONFIG, { attempts: 1 });

  assert.deepEqual(res, payload);
});

test("fetchOverpass: request method / headers / url are the Overpass POST contract", async (t) => {
  const { calls } = installFetch(t, [elementsBody([])]);

  await fetchOverpass(QUERY, CONFIG, { attempts: 1 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CONFIG.overpassUrl);
  const init = calls[0].init;
  assert.equal(init.method, "POST");
  const h = init.headers as Record<string, string>;
  assert.equal(h["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(h["User-Agent"], CONFIG.overpassUserAgent);
  assert.equal(h["Accept"], "application/json");
  assert.ok(init.signal, "an abort signal is always attached");
  assert.equal(typeof init.body, "string");
  assert.match(init.body as string, /^data=/);
});

test("fetchOverpass: the query round-trips through the urlencoded body verbatim", async (t) => {
  const { calls } = installFetch(t, [elementsBody([])]);
  const tricky =
    'nwr["name"~"kafana|кафана",i](area.bg);\n// + & = ; special «chars» 100%';

  await fetchOverpass(tricky, CONFIG, { attempts: 1 });

  const decoded = new URLSearchParams(calls[0].init.body as string).get("data");
  assert.equal(decoded, tricky);
});

test("fetchOverpass: a real Belgrade query round-trips through the body", async (t) => {
  const { calls } = installFetch(t, [elementsBody([])]);
  const q = buildOverpassQuery(BELGRADE);

  await fetchOverpass(q, CONFIG, { attempts: 1 });

  assert.equal(new URLSearchParams(calls[0].init.body as string).get("data"), q);
});

test("fetchOverpass: a retryable status (429) is retried, then the eventual 200 is returned", async (t) => {
  const { calls } = installFetch(t, [{ status: 429 }, elementsBody([])]);

  const { value, error } = await run(t, () => fetchOverpass(QUERY, CONFIG));

  assert.equal(error, undefined);
  assert.deepEqual(value, { elements: [] });
  assert.equal(calls.length, 2, "one retry after the 429");
});

test("fetchOverpass: every retryable-status attempt fails -> throws after `attempts` tries", async (t) => {
  const { calls } = installFetch(t, [{ status: 503 }]);

  const { value, error } = await run(t, () => fetchOverpass(QUERY, CONFIG, { attempts: 3 }));

  assert.equal(value, undefined);
  assert.equal(calls.length, 3);
  assert.match((error as Error).message, /Overpass request failed after 3 attempts/);
  assert.match((error as Error).message, /HTTP 503/);
});

test("fetchOverpass: [B1 regression] a non-retryable HTTP status fails fast — one request, no back-off", async (t) => {
  // A non-retryable response (400/401/403/404/500/…) is a DEFINITIVE failure: it
  // must not enter the generic retry `catch`, so no second request and no
  // back-off sleep, whatever `attempts` says. Fake timers are enabled but the
  // clock is NEVER advanced — if a back-off were scheduled the call could not
  // settle here and `assert.ok(settled)` fails.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const status of [400, 401, 404, 500]) {
      const { calls } = installFetch(t, [{ status }]);

      let settled: { err: unknown } | "resolved" | undefined;
      void fetchOverpass(QUERY, CONFIG, { attempts: 3 }).then(
        () => (settled = "resolved"),
        (err) => (settled = { err }),
      );
      for (let n = 0; n < 20 && !settled; n++) {
        await new Promise((r) => setImmediate(r));
      }

      assert.ok(settled, `HTTP ${status}: must settle with no timer delay`);
      assert.notEqual(settled, "resolved", `HTTP ${status}: must reject`);
      const message = ((settled as { err: Error }).err).message;
      assert.match(message, new RegExp(`HTTP ${status}`), `HTTP ${status}: error names the status`);
      assert.doesNotMatch(
        message,
        /after \d+ attempts/,
        `HTTP ${status}: failed on the first response, not after exhausting retries`,
      );
      assert.equal(calls.length, 1, `HTTP ${status}: exactly one request — never retried`);
    }
  } finally {
    t.mock.timers.reset();
  }
});

test("fetchOverpass: [B1 regression] a non-retryable 400 with attempts:1 rejects with the unwrapped HTTP error", async (t) => {
  const { calls } = installFetch(t, [{ status: 400 }]);

  await assert.rejects(fetchOverpass(QUERY, CONFIG, { attempts: 1 }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Overpass request failed: HTTP 400/);
    assert.doesNotMatch(err.message, /after \d+ attempts/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("fetchOverpass: a 200 with a `remark` and no `elements` array is a hard failure", async (t) => {
  installFetch(t, [{ status: 200, json: { remark: "runtime error: please reduce your query load" } }]);

  await assert.rejects(
    fetchOverpass(QUERY, CONFIG, { attempts: 1 }),
    /Overpass request failed after 1 attempts: Overpass returned an error remark: runtime error: please reduce your query load/,
  );
});

const TIMEOUT_REMARK =
  "runtime error: Query timed out in 'query' at line 3 after 240 seconds.";

test("fetchOverpass: [B2 regression] a 200 with a meaningful `remark` and EMPTY `elements` is a failure", async (t) => {
  installFetch(t, [{ status: 200, json: { remark: TIMEOUT_REMARK, elements: [] } }]);

  await assert.rejects(
    fetchOverpass(QUERY, CONFIG, { attempts: 1 }),
    /Overpass returned an error remark: runtime error: Query timed out/,
  );
});

test("fetchOverpass: [B2 regression] a 200 with a meaningful `remark` and PARTIAL `elements` is a failure", async (t) => {
  // Overpass emits `remark` + a truncated `elements` list when a query times out
  // mid-run. That degraded payload must not be accepted as a partial success.
  const json = {
    remark: TIMEOUT_REMARK,
    elements: [{ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "A" } }],
  };
  installFetch(t, [{ status: 200, json }]);

  await assert.rejects(
    fetchOverpass(QUERY, CONFIG, { attempts: 1 }),
    /Overpass returned an error remark: runtime error: Query timed out/,
  );
});

test("fetchOverpass: [B2 regression] a `remark` response is transient — retried, then fails after `attempts`", async (t) => {
  const { calls } = installFetch(t, [{ status: 200, json: { remark: TIMEOUT_REMARK, elements: [] } }]);

  const { value, error } = await run(t, () => fetchOverpass(QUERY, CONFIG, { attempts: 3 }));

  assert.equal(value, undefined);
  assert.equal(calls.length, 3, "a `remark` response is retried like other transient failures");
  assert.match((error as Error).message, /Overpass request failed after 3 attempts/);
  assert.match((error as Error).message, /Overpass returned an error remark/);
});

test("fetchOverpass: a 200 with no `elements` array and no `remark` is a hard failure", async (t) => {
  installFetch(t, [{ status: 200, json: { version: 0.6, generator: "Overpass API" } }]);

  await assert.rejects(
    fetchOverpass(QUERY, CONFIG, { attempts: 1 }),
    /Overpass request failed after 1 attempts: Overpass response had no elements array/,
  );
});

test("fetchOverpass: a 200 whose body will not parse as JSON is treated as transient and retried", async (t) => {
  const { calls } = installFetch(t, [{ status: 200, jsonThrows: true }]);

  const { value, error } = await run(t, () => fetchOverpass(QUERY, CONFIG, { attempts: 2 }));

  assert.equal(value, undefined);
  assert.equal(calls.length, 2, "a JSON parse failure is retried");
  assert.match((error as Error).message, /Overpass request failed after 2 attempts/);
});

test("fetchOverpass: a persistent network error runs every attempt then throws with context", async (t) => {
  const { calls } = installFetch(t, [
    new Error("ECONNRESET"),
    new Error("ECONNRESET"),
    new Error("ECONNRESET"),
  ]);

  const { value, error } = await run(t, () => fetchOverpass(QUERY, CONFIG, { attempts: 3 }));

  assert.equal(value, undefined);
  assert.equal(calls.length, 3);
  assert.match((error as Error).message, /Overpass request failed after 3 attempts/);
  assert.match((error as Error).message, /ECONNRESET/);
});

test("fetchOverpass: a single-attempt network error throws immediately", async (t) => {
  const { calls } = installFetch(t, [new Error("boom")]);

  await assert.rejects(
    fetchOverpass(QUERY, CONFIG, { attempts: 1 }),
    /Overpass request failed after 1 attempts: boom/,
  );
  assert.equal(calls.length, 1);
});

test("fetchOverpass: the abort timer fires on timeout and the attempt fails", async (t) => {
  const { calls } = installFetch(t, ["abort-pending"]);

  const { value, error } = await run(t, () =>
    fetchOverpass(QUERY, CONFIG, { attempts: 1, timeoutMs: 5_000 }),
  );

  assert.equal(value, undefined);
  assert.equal(calls.length, 1);
  assert.match((error as Error).message, /Overpass request failed after 1 attempts/);
  assert.match((error as Error).message, /abort/i);
});

test("fetchOverpass: a timed-out attempt is retried before the run ultimately fails", async (t) => {
  const { calls } = installFetch(t, ["abort-pending"]);

  const { value, error } = await run(t, () =>
    fetchOverpass(QUERY, CONFIG, { attempts: 3, timeoutMs: 5_000 }),
  );

  assert.equal(value, undefined);
  assert.equal(calls.length, 3, "each timeout is retried");
  assert.match((error as Error).message, /Overpass request failed after 3 attempts/);
});

test("fetchOverpass: [B4 regression] with the default timeout the client does NOT abort before the server's 240s budget", async (t) => {
  // The query asks Overpass for `[timeout:240]`. With the default client
  // timeout, a still-pending request at t = 240s must NOT have been aborted —
  // otherwise the client abandons work the server would still answer and
  // triggers an avoidable retry.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { calls } = installFetch(t, ["abort-pending"]);

    let settled: "resolved" | { err: unknown } | undefined;
    void fetchOverpass(QUERY, CONFIG, { attempts: 1 }).then(
      () => (settled = "resolved"),
      (err) => (settled = { err }),
    );

    t.mock.timers.tick(240_000); // exactly the Overpass server-side budget
    for (let n = 0; n < 20 && !settled; n++) {
      await new Promise((r) => setImmediate(r));
    }

    assert.equal(settled, undefined, "client must still be waiting at t = 240s (server budget)");
    assert.equal(calls.length, 1, "no retry — the client has not timed out");
  } finally {
    t.mock.timers.reset();
  }
});

test("[B4 regression] the default client timeout exceeds the Overpass server timeout by a positive margin", () => {
  // Future guard: if someone makes the client give up before the server's own
  // `[timeout:…]` budget again, this fails loudly.
  const serverMs = OVERPASS_SERVER_TIMEOUT_S * 1000;

  assert.ok(
    DEFAULT_CLIENT_TIMEOUT_MS > serverMs,
    `client ${DEFAULT_CLIENT_TIMEOUT_MS}ms must exceed server ${serverMs}ms`,
  );
  assert.ok(CLIENT_TIMEOUT_MARGIN_MS > 0, "the safety margin must be positive");
  assert.equal(DEFAULT_CLIENT_TIMEOUT_MS, serverMs + CLIENT_TIMEOUT_MARGIN_MS);
});

test("fetchOverpass: [B4 regression] the default client timeout still eventually aborts a hung request", async (t) => {
  // 3d — the abort/retry mechanism is unchanged; only the default duration grew.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { calls } = installFetch(t, ["abort-pending"]);

    let settled: "resolved" | { err: unknown } | undefined;
    void fetchOverpass(QUERY, CONFIG, { attempts: 1 }).then(
      () => (settled = "resolved"),
      (err) => (settled = { err }),
    );

    t.mock.timers.tick(DEFAULT_CLIENT_TIMEOUT_MS + 1_000);
    for (let n = 0; n < 20 && !settled; n++) {
      await new Promise((r) => setImmediate(r));
    }

    assert.ok(settled && typeof settled === "object", "aborts once the default timeout elapses");
    assert.match((settled as { err: Error }).err.message, /abort/i);
    assert.equal(calls.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("fetchOverpass: [B5 regression] every retryable status cancels its body BEFORE the back-off, then retries", async (t) => {
  for (const status of [429, 502, 503, 504]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let cancels = 0;
      const { calls } = installFetch(t, [
        { status, onBodyCancel: () => { cancels += 1; } },
        elementsBody([]),
      ]);

      let settled: "resolved" | { err: unknown } | undefined;
      void fetchOverpass(QUERY, CONFIG, { attempts: 3 }).then(
        () => (settled = "resolved"),
        (err) => (settled = { err }),
      );

      // Drain microtasks only — do NOT advance the clock. By now the fixed code
      // has received the error response, cancelled its body, and parked on the
      // back-off `sleep`. The retry has NOT fired yet.
      for (let n = 0; n < 20 && cancels === 0 && !settled; n++) {
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(cancels, 1, `HTTP ${status}: body cancelled before the back-off`);
      assert.equal(calls.length, 1, `HTTP ${status}: retry has not fired — still on the back-off`);
      assert.equal(settled, undefined, `HTTP ${status}: not settled during the back-off`);

      // Let the back-off elapse → the retry fires and the 200 succeeds.
      for (let n = 0; n < 20 && !settled; n++) {
        await new Promise((r) => setImmediate(r));
        if (!settled) t.mock.timers.tick(10_000);
      }
      assert.equal(settled, "resolved", `HTTP ${status}: the retry still happens exactly as before`);
      assert.equal(calls.length, 2, `HTTP ${status}: exactly one retry`);
      assert.equal(cancels, 1, `HTTP ${status}: only the error body was cancelled`);
    } finally {
      t.mock.timers.reset();
    }
  }
});

test("fetchOverpass: [B5 regression] a successful response body is NOT cancelled", async (t) => {
  let cancels = 0;
  installFetch(t, [
    { status: 200, json: { elements: [] }, onBodyCancel: () => { cancels += 1; } },
  ]);

  const res = await fetchOverpass(QUERY, CONFIG, { attempts: 1 });

  assert.deepEqual(res, { elements: [] });
  assert.equal(cancels, 0, "a 2xx body is consumed by json(), never cancelled");
});

test("fetchOverpass: [B5 regression] a non-retryable response fails fast without cancelling its body (B1 boundary)", async (t) => {
  let cancels = 0;
  const { calls } = installFetch(t, [{ status: 400, onBodyCancel: () => { cancels += 1; } }]);

  await assert.rejects(fetchOverpass(QUERY, CONFIG, { attempts: 3 }), /HTTP 400/);

  assert.equal(calls.length, 1, "B1: one request, no retry");
  assert.equal(cancels, 0, "the definitive-error path is out of B5 scope — body not cancelled");
});

test("fetchOverpass: with options omitted it makes up to 3 attempts (default `attempts`)", async (t) => {
  // Two transient failures then success still resolves -> the default is >= 3.
  const { calls } = installFetch(t, [{ status: 502 }, { status: 504 }, elementsBody([])]);

  const { value, error } = await run(t, () => fetchOverpass(QUERY, CONFIG));

  assert.equal(error, undefined);
  assert.deepEqual(value, { elements: [] });
  assert.equal(calls.length, 3, "default attempts = 3");
});

// ════════════════════════════════════════════════════════════════════
//  3. parseOverpassVenues — duplicate handling
// ════════════════════════════════════════════════════════════════════

const ACCEPTED_EL: OverpassElement = {
  type: "node",
  id: 1001,
  lat: 44.8185,
  lon: 20.4884,
  tags: { amenity: "nightclub", name: "Drugstore" },
};
const INVALID_EL: OverpassElement = {
  type: "node",
  id: 4004,
  lat: 44.805,
  lon: 20.476,
  tags: { amenity: "nightclub" }, // no name -> invalid
};
const EXCLUDED_EL: OverpassElement = {
  type: "node",
  id: 6006,
  lat: 44.8,
  lon: 20.45,
  tags: { amenity: "restaurant", name: "Ordinary Restaurant", cuisine: "italian" },
};

test("parseOverpassVenues: an accepted element repeated by overlapping clauses is deduped to one venue", () => {
  const { venues, invalid, excluded } = parseOverpassVenues({
    elements: [ACCEPTED_EL, ACCEPTED_EL, ACCEPTED_EL],
  });

  assert.equal(venues.length, 1);
  assert.equal(venues[0].externalId, "node/1001");
  assert.equal(invalid.length, 0);
  assert.equal(excluded.length, 0);
});

test("parseOverpassVenues: [B3 regression] a repeated INVALID element is counted once", () => {
  const { invalid } = parseOverpassVenues({ elements: [INVALID_EL, INVALID_EL, INVALID_EL] });

  assert.equal(invalid.length, 1, "the same node/4004 must be reported once");
  assert.equal(invalid[0].ref, "node/4004");
});

test("parseOverpassVenues: [B3 regression] a repeated EXCLUDED element is counted once", () => {
  const { excluded } = parseOverpassVenues({ elements: [EXCLUDED_EL, EXCLUDED_EL, EXCLUDED_EL] });

  assert.equal(excluded.length, 1, "the same node/6006 must be reported once");
  assert.equal(excluded[0].ref, "node/6006");
});

test("parseOverpassVenues: [B3 regression] mixed duplicates all collapse by identity", () => {
  const { venues, invalid, excluded } = parseOverpassVenues({
    elements: [ACCEPTED_EL, INVALID_EL, EXCLUDED_EL, ACCEPTED_EL, INVALID_EL, EXCLUDED_EL],
  });

  assert.equal(venues.length, 1);
  assert.equal(invalid.length, 1);
  assert.equal(excluded.length, 1);
});

test("parseOverpassVenues: [B3 regression] distinct elements sharing a name are NOT collapsed", () => {
  // Same name, different OSM identity → two real, separate venues.
  const a: OverpassElement = {
    type: "node",
    id: 111,
    lat: 44.81,
    lon: 20.41,
    tags: { amenity: "bar", name: "Same Name Bar" },
  };
  const b: OverpassElement = {
    type: "node",
    id: 222,
    lat: 44.92,
    lon: 20.52,
    tags: { amenity: "bar", name: "Same Name Bar" },
  };

  const { venues } = parseOverpassVenues({ elements: [a, b] });

  assert.equal(venues.length, 2);
  assert.deepEqual(venues.map((v) => v.externalId).sort(), ["node/111", "node/222"]);
});

test("parseOverpassVenues: [B3 regression] distinct invalid and distinct excluded elements are each counted", () => {
  const inv1: OverpassElement = { type: "node", id: 301, lat: 44.8, lon: 20.4, tags: { amenity: "nightclub" } };
  const inv2: OverpassElement = { type: "way", id: 302, center: { lat: 44.8, lon: 20.4 }, tags: { amenity: "bar" } };
  const exc1: OverpassElement = {
    type: "node",
    id: 401,
    lat: 44.8,
    lon: 20.4,
    tags: { amenity: "restaurant", name: "Plain One" },
  };
  const exc2: OverpassElement = {
    type: "node",
    id: 402,
    lat: 44.8,
    lon: 20.4,
    tags: { amenity: "restaurant", name: "Plain Two" },
  };

  const { invalid, excluded } = parseOverpassVenues({ elements: [inv1, inv2, exc1, exc2] });

  assert.equal(invalid.length, 2);
  assert.equal(excluded.length, 2);
});

test("parseOverpassVenues: [B3 regression] elements with no resolvable identity are each kept", () => {
  // Neither has a numeric id → both resolve to ref "(unknown)"; they are two
  // different broken elements and must not be merged into one.
  const broken1 = { type: "node", tags: { note: "one" } } as unknown as OverpassElement;
  const broken2 = { type: "node", tags: { note: "two" } } as unknown as OverpassElement;

  const { invalid } = parseOverpassVenues({ elements: [broken1, broken2] });

  assert.equal(invalid.length, 2);
  assert.ok(invalid.every((i) => i.ref === "(unknown)"));
});

// ════════════════════════════════════════════════════════════════════
//  4. collectVenuesForTarget
// ════════════════════════════════════════════════════════════════════

const COLLECT_RESPONSE: OverpassResponse = {
  elements: [ACCEPTED_EL, INVALID_EL, EXCLUDED_EL],
};

test("collectVenuesForTarget: builds the target query, POSTs it, and parses the response", async (t) => {
  const { calls } = installFetch(t, [{ status: 200, json: COLLECT_RESPONSE }]);

  const result = await collectVenuesForTarget(BELGRADE, CONFIG);

  // fetch wiring: the exact target query is what gets POSTed to the configured URL
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CONFIG.overpassUrl);
  assert.equal(
    new URLSearchParams(calls[0].init.body as string).get("data"),
    buildOverpassQuery(BELGRADE),
  );

  // parse wiring: identical to calling parseOverpassVenues directly with the target
  const expected = parseOverpassVenues(COLLECT_RESPONSE, BELGRADE);
  assert.deepEqual(result.venues, expected.venues);
  assert.deepEqual(result.invalid, expected.invalid);
  assert.deepEqual(result.excluded, expected.excluded);
  assert.equal(result.venues.length, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.excluded.length, 1);
});

test("collectVenuesForTarget: `fetched` = venues + invalid + excluded (post-dedup counts)", async (t) => {
  installFetch(t, [{ status: 200, json: COLLECT_RESPONSE }]);

  const result = await collectVenuesForTarget(BELGRADE, CONFIG);

  assert.equal(result.fetched, 3);
  assert.equal(
    result.fetched,
    result.venues.length + result.invalid.length + result.excluded.length,
  );
});

test("collectVenuesForTarget: [B3 regression] `fetched` counts unique elements, not raw duplicate occurrences", async (t) => {
  installFetch(t, [
    {
      status: 200,
      json: {
        elements: [ACCEPTED_EL, ACCEPTED_EL, INVALID_EL, INVALID_EL, EXCLUDED_EL, EXCLUDED_EL],
      },
    },
  ]);

  const result = await collectVenuesForTarget(BELGRADE, CONFIG);

  assert.equal(result.venues.length, 1, "accepted collapses");
  assert.equal(result.invalid.length, 1, "invalid collapses");
  assert.equal(result.excluded.length, 1, "excluded collapses");
  assert.equal(result.fetched, 3, "`fetched` is the 3 distinct elements, not 6 raw occurrences");
});

test("collectVenuesForTarget: has no knob for retry/timeout - it always uses fetchOverpass defaults", async (t) => {
  // Two transient failures then success: `collectVenuesForTarget` still resolves,
  // proving it relies on the default `attempts` (3). There is deliberately no
  // parameter on `collectVenuesForTarget` to change this today.
  const { calls } = installFetch(t, [{ status: 503 }, { status: 503 }, { status: 200, json: COLLECT_RESPONSE }]);

  const { value, error } = await run(t, () => collectVenuesForTarget(BELGRADE, CONFIG));

  assert.equal(error, undefined);
  assert.equal(calls.length, 3);
  assert.equal(value?.fetched, 3);
});

test("collectVenuesForTarget: a definitive fetch failure propagates (caller writes nothing)", async (t) => {
  installFetch(t, [{ status: 400 }]);

  const { value, error } = await run(t, () => collectVenuesForTarget(BELGRADE, CONFIG));

  assert.equal(value, undefined);
  assert.match((error as Error).message, /Overpass request failed/);
});
