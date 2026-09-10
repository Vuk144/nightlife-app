/**
 * Characterization / regression tests for `src/sources/osm-overpass.ts`.
 *
 * STEP 0 of the audited refactor: these lock in the CURRENT behavior of
 * `buildOverpassQuery`, `fetchOverpass`, `parseOverpassVenues` and
 * `collectVenuesForTarget` so a later behavior-preserving refactor is provably
 * safe.
 *
 * A few tests intentionally pin KNOWN BUGS from the audit — each is tagged
 * `[characterizes bug Bn]`. When the corresponding fix lands, that test must be
 * UPDATED (not deleted) to describe the corrected behavior:
 *
 *   B1  a non-retryable HTTP status (e.g. 400) is still retried `attempts`
 *       times, because the "definitive failure" throw is caught by the generic
 *       retry `catch`.
 *   B2  an Overpass 200 that carries a `remark` AND a (partial) `elements`
 *       array is returned as a success — a truncated result is not detected.
 *   B3  `parseOverpassVenues` deduplicates accepted venues only; duplicate
 *       `invalid` / `excluded` elements from overlapping query clauses are
 *       counted twice and inflate `fetched`.
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
}

/** A step the fake `fetch` replays: a response, a thrown error, or "hang until aborted". */
type Step = FakeRes | Error | "abort-pending";

function fakeResponse(o: FakeRes): Response {
  return {
    ok: o.status >= 200 && o.status < 300,
    status: o.status,
    url: "",
    headers: { get: () => null },
    body: null,
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

test("fetchOverpass: [characterizes bug B1] a NON-retryable 400 is still retried `attempts` times", async (t) => {
  // CURRENT behavior: line 152 throws `Overpass request failed: HTTP 400`
  // from inside the `try`, so the generic `catch` re-runs it up to `attempts`
  // times. A malformed query (400) SHOULD fail fast on the first response.
  const { calls } = installFetch(t, [{ status: 400 }]);

  const { value, error } = await run(t, () => fetchOverpass(QUERY, CONFIG, { attempts: 3 }));

  assert.equal(value, undefined);
  assert.equal(calls.length, 3, "BUG B1: a 400 is retried 3x instead of failing fast");
  assert.match((error as Error).message, /Overpass request failed after 3 attempts/);
  assert.match((error as Error).message, /HTTP 400/);
});

test("fetchOverpass: a single-attempt non-retryable 400 throws after one call", async (t) => {
  const { calls } = installFetch(t, [{ status: 400 }]);

  await assert.rejects(
    fetchOverpass(QUERY, CONFIG, { attempts: 1 }),
    /Overpass request failed after 1 attempts: Overpass request failed: HTTP 400/,
  );
  assert.equal(calls.length, 1);
});

test("fetchOverpass: a 200 with a `remark` and no `elements` array is a hard failure", async (t) => {
  installFetch(t, [{ status: 200, json: { remark: "runtime error: please reduce your query load" } }]);

  await assert.rejects(
    fetchOverpass(QUERY, CONFIG, { attempts: 1 }),
    /Overpass request failed after 1 attempts: Overpass returned an error remark: runtime error: please reduce your query load/,
  );
});

test("fetchOverpass: [characterizes bug B2] a 200 with a `remark` AND a partial `elements` array is returned as success", async (t) => {
  // CURRENT behavior: the remark guard only fires when `elements` is NOT an
  // array. Overpass emits `remark` + a truncated `elements` list when a query
  // times out mid-run; that truncated payload is handed back as if complete.
  const partial = {
    elements: [{ type: "node", id: 1, lat: 44.8, lon: 20.4, tags: { amenity: "bar", name: "A" } }],
    remark: "runtime error: Query timed out in 'query' at line 3 after 240 seconds.",
  };
  installFetch(t, [{ status: 200, json: partial }]);

  const res = (await fetchOverpass(QUERY, CONFIG, { attempts: 1 })) as OverpassResponse & {
    remark?: string;
  };

  assert.equal(res.elements?.length, 1, "BUG B2: truncated result accepted");
  assert.equal(res.remark, partial.remark, "BUG B2: the timeout remark is ignored, not surfaced");
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

test("parseOverpassVenues: [characterizes bug B3] a repeated INVALID element is counted once per occurrence", () => {
  // CURRENT behavior: the `seen` set is only consulted on the accepted branch.
  const { invalid } = parseOverpassVenues({ elements: [INVALID_EL, INVALID_EL] });

  assert.equal(invalid.length, 2, "BUG B3: invalid duplicates are not deduped");
  assert.deepEqual(invalid[0], invalid[1]);
  assert.equal(invalid[0].ref, "node/4004");
});

test("parseOverpassVenues: [characterizes bug B3] a repeated EXCLUDED element is counted once per occurrence", () => {
  const { excluded } = parseOverpassVenues({ elements: [EXCLUDED_EL, EXCLUDED_EL] });

  assert.equal(excluded.length, 2, "BUG B3: excluded duplicates are not deduped");
  assert.deepEqual(excluded[0], excluded[1]);
  assert.equal(excluded[0].ref, "node/6006");
});

test("parseOverpassVenues: mixed duplicates - only the accepted one collapses", () => {
  const { venues, invalid, excluded } = parseOverpassVenues({
    elements: [ACCEPTED_EL, INVALID_EL, EXCLUDED_EL, ACCEPTED_EL, INVALID_EL, EXCLUDED_EL],
  });

  assert.equal(venues.length, 1);
  assert.equal(invalid.length, 2); // B3
  assert.equal(excluded.length, 2); // B3
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

test("collectVenuesForTarget: [characterizes bug B3] duplicate invalid/excluded elements inflate `fetched`", async (t) => {
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
  assert.equal(result.invalid.length, 2, "B3");
  assert.equal(result.excluded.length, 2, "B3");
  assert.equal(result.fetched, 5, "BUG B3: `fetched` (5) overcounts the 3 distinct elements");
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
