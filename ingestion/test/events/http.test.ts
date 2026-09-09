/**
 * Network layer — `../../src/events/http.ts#httpGetText`.
 *
 * `globalThis.fetch` is replaced with a scripted fake; the linear back-off is
 * driven with `node:test` mock timers so nothing waits 3/6 real seconds.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { httpGetText } from "../../src/events/http.ts";

// ── fake Response ────────────────────────────────────────────────────
interface FakeResOpts {
  status: number;
  body?: string;
  url?: string;
  contentType?: string;
  onBodyCancel?: () => void;
  onText?: () => void;
}

function fakeResponse(o: FakeResOpts): Response {
  const bodyStream =
    o.onBodyCancel || o.status >= 300
      ? {
          cancel: async () => {
            o.onBodyCancel?.();
          },
        }
      : null;
  return {
    ok: o.status >= 200 && o.status < 300,
    status: o.status,
    url: o.url ?? "",
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "content-type" ? (o.contentType ?? null) : null,
    },
    body: bodyStream,
    text: async () => {
      o.onText?.();
      return o.body ?? "";
    },
  } as unknown as Response;
}

type FetchCall = { url: string; init: RequestInit };

/** Install a fake `fetch` that replays `script` entries in order. */
function installFetch(
  t: { after: (fn: () => void) => void },
  script: (FakeResOpts | Error)[],
): { calls: FetchCall[] } {
  const real = globalThis.fetch;
  const calls: FetchCall[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return fakeResponse(step);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return { calls };
}

/**
 * Run `httpGetText` to completion under fake timers: drain microtasks, then
 * advance the clock past whatever back-off it parked on, and repeat. `timeoutMs`
 * is huge so the abort timer never fires under this ticking.
 */
async function run(
  t: { mock: typeof mock },
  ...args: Parameters<typeof httpGetText>
): Promise<{ value?: Awaited<ReturnType<typeof httpGetText>>; error?: unknown }> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const out: { value?: Awaited<ReturnType<typeof httpGetText>>; error?: unknown } = {};
    void httpGetText(...args).then(
      (v) => {
        done = true;
        out.value = v;
      },
      (e) => {
        done = true;
        out.error = e;
      },
    );
    for (let n = 0; n < 40 && !done; n++) {
      await new Promise((r) => setImmediate(r));
      if (!done) t.mock.timers.tick(10_000);
    }
    assert.ok(done, "httpGetText did not settle under fake timers");
    return out;
  } finally {
    t.mock.timers.reset();
  }
}

const UA = "nightlife-test/1.0";

// ════════════════════════════════════════════════════════════════════
//  REGRESSION: a retried error response releases its body
// ════════════════════════════════════════════════════════════════════

test("[regression] a retried 5xx response has its body cancelled before the back-off", async (t) => {
  let cancels = 0;
  const { calls } = installFetch(t, [
    { status: 503, onBodyCancel: () => cancels++ },
    { status: 200, body: "OK" },
  ]);

  const { value, error } = await run(t, "https://x.test/p", { userAgent: UA, attempts: 3 });

  assert.equal(error, undefined);
  assert.equal(value!.status, 200);
  assert.equal(value!.body, "OK");
  assert.equal(calls.length, 2, "retried once");
  assert.equal(cancels, 1, "the un-read 503 body must be cancelled exactly once");
});

test("[regression] every retried error body is released; the final retryable response is RETURNED", async (t) => {
  let cancels = 0;
  let finalTextReads = 0;
  installFetch(t, [
    { status: 500, onBodyCancel: () => cancels++ },
    { status: 502, onBodyCancel: () => cancels++ },
    { status: 503, onBodyCancel: () => cancels++, body: "still busy", onText: () => finalTextReads++ },
  ]);
  const { value, error } = await run(t, "https://x.test/p", { userAgent: UA, attempts: 3 });
  assert.equal(error, undefined);
  assert.equal(value!.status, 503, "final retryable response is returned, not thrown");
  assert.equal(value!.body, "still busy");
  assert.equal(cancels, 2, "attempts 1 and 2 release their body; the final one is read normally");
  assert.equal(finalTextReads, 1, "the returned response body is read exactly once");
});

// ════════════════════════════════════════════════════════════════════
//  Completed exchanges are returned (no timers needed)
// ════════════════════════════════════════════════════════════════════

test("a 404 is returned immediately, never retried", async (t) => {
  const { calls } = installFetch(t, [{ status: 404, body: "nope" }]);
  const res = await httpGetText("https://x.test/missing", { userAgent: UA, attempts: 3 });
  assert.equal(res.status, 404);
  assert.equal(res.body, "nope");
  assert.equal(calls.length, 1, "no retry for a non-retryable 4xx");
});

test("a 501 (not in the retryable set) is returned immediately", async (t) => {
  const { calls } = installFetch(t, [{ status: 501 }]);
  const res = await httpGetText("https://x.test/x", { userAgent: UA, attempts: 3 });
  assert.equal(res.status, 501);
  assert.equal(calls.length, 1);
});

test("a single-attempt 503 is returned, not thrown", async (t) => {
  installFetch(t, [{ status: 503, body: "busy" }]);
  const res = await httpGetText("https://x.test/x", { userAgent: UA, attempts: 1 });
  assert.equal(res.status, 503);
  assert.equal(res.body, "busy");
});

test("content-type is lower-cased and the final redirect URL is returned", async (t) => {
  installFetch(t, [
    { status: 200, body: "<html>", url: "https://x.test/final/", contentType: "TEXT/HTML; charset=UTF-8" },
  ]);
  const res = await httpGetText("https://x.test/start", { userAgent: UA });
  assert.equal(res.url, "https://x.test/final/");
  assert.equal(res.contentType, "text/html; charset=utf-8");
});

// ════════════════════════════════════════════════════════════════════
//  Retry / throw classification
// ════════════════════════════════════════════════════════════════════

test("429 is retried, then the eventual 200 is returned", async (t) => {
  const { calls } = installFetch(t, [{ status: 429 }, { status: 200, body: "ok" }]);
  const { value } = await run(t, "https://x.test/x", { userAgent: UA, attempts: 3 });
  assert.equal(value!.status, 200);
  assert.equal(calls.length, 2);
});

test("a persistent network failure runs every attempt and then throws with context", async (t) => {
  const { calls } = installFetch(t, [
    new Error("ECONNRESET"),
    new Error("ECONNRESET"),
    new Error("ECONNRESET"),
  ]);
  const { value, error } = await run(t, "https://x.test/down", { userAgent: UA, attempts: 3 });
  assert.equal(value, undefined);
  assert.equal(calls.length, 3, "all attempts happen");
  assert.match((error as Error).message, /failed after 3 attempts/);
  assert.match((error as Error).message, /ECONNRESET/);
  assert.match((error as Error).message, /x\.test\/down/);
});

test("network failure -> 503 -> network failure: still throws after 3 attempts", async (t) => {
  const { calls } = installFetch(t, [
    new Error("dns"),
    { status: 503 },
    new Error("reset"),
  ]);
  const { value, error } = await run(t, "https://x.test/x", { userAgent: UA, attempts: 3 });
  assert.equal(value, undefined);
  assert.equal(calls.length, 3);
  assert.match((error as Error).message, /failed after 3 attempts/);
});

test("a single-attempt network failure throws immediately", async (t) => {
  const { calls } = installFetch(t, [new Error("boom")]);
  await assert.rejects(
    httpGetText("https://x.test/x", { userAgent: UA, attempts: 1 }),
    /failed after 1 attempts: boom/,
  );
  assert.equal(calls.length, 1);
});

// ════════════════════════════════════════════════════════════════════
//  Headers / purity
// ════════════════════════════════════════════════════════════════════

test("User-Agent comes from options; default Accept is sent; no auth or cookies", async (t) => {
  const { calls } = installFetch(t, [{ status: 200, body: "" }]);
  await httpGetText("https://x.test/x", { userAgent: UA });
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h["User-Agent"], UA);
  assert.match(h.Accept, /text\/html/);
  assert.equal(h.Cookie, undefined);
  assert.equal(h.Authorization, undefined);
  assert.equal(calls[0].init.redirect, "follow");
  assert.ok(calls[0].init.signal, "an abort signal is always attached");
});

test("a custom Accept is respected", async (t) => {
  const { calls } = installFetch(t, [{ status: 200, body: "" }]);
  await httpGetText("https://x.test/x", { userAgent: UA, accept: "application/xml" });
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, "application/xml");
});

test("the caller-owned options object is not mutated", async (t) => {
  installFetch(t, [{ status: 429 }, { status: 200, body: "" }]);
  const opts = { userAgent: UA, attempts: 3, timeoutMs: 30_000, politenessMs: 0, accept: "application/xml" };
  const snapshot = JSON.stringify(opts);
  await run(t, "https://x.test/x", opts);
  assert.equal(JSON.stringify(opts), snapshot);
});

// ════════════════════════════════════════════════════════════════════
//  Politeness
// ════════════════════════════════════════════════════════════════════

test("the politeness delay elapses before the first request fires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { calls } = installFetch(t, [{ status: 200, body: "" }]);
    let done = false;
    void httpGetText("https://x.test/x", { userAgent: UA, politenessMs: 400 }).then(() => {
      done = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0, "no request until the politeness pause elapses");
    t.mock.timers.tick(400);
    for (let n = 0; n < 10 && !done; n++) await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.ok(done);
  } finally {
    t.mock.timers.reset();
  }
});

test("politenessMs of 0 / negative / NaN is skipped, request fires immediately", async (t) => {
  for (const politenessMs of [0, -100, Number.NaN]) {
    const { calls } = installFetch(t, [{ status: 200, body: "" }]);
    await httpGetText("https://x.test/x", { userAgent: UA, politenessMs });
    assert.equal(calls.length, 1, `politenessMs=${politenessMs} must not block`);
  }
});
