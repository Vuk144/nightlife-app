/**
 * Isolated network layer for event sources.
 *
 * Nothing here parses content — callers get back a status and a body string.
 * The retry / linear back-off / abort-timeout strategy mirrors
 * `sources/osm-overpass.ts#fetchOverpass`, kept separate so parsing stays pure
 * and unit-testable without a network.
 *
 *  - Plain HTTP GET only. No browser automation, no cookies, no auth.
 *  - Transient failures (429 / 408 / 5xx / network / timeout) are retried.
 *  - A completed HTTP exchange is always returned, even for 4xx/5xx — the
 *    caller classifies it. Only a network/timeout failure throws.
 */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface HttpResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  body: string;
  contentType?: string;
}

export interface HttpGetOptions {
  userAgent: string;
  attempts?: number;
  timeoutMs?: number;
  /** Polite pause before the request fires (ms). */
  politenessMs?: number;
  accept?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET a URL as text. Returns the response for any completed exchange; throws
 * only when every attempt fails at the network/timeout level.
 */
export async function httpGetText(
  url: string,
  options: HttpGetOptions,
): Promise<HttpResponse> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (options.politenessMs && options.politenessMs > 0) {
    await sleep(options.politenessMs);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": options.userAgent,
          Accept:
            options.accept ??
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      if (!response.ok && RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        const backoff = 3_000 * attempt;
        console.warn(
          `  HTTP ${response.status} for ${url}; retrying in ${backoff / 1000}s (attempt ${attempt}/${attempts})`,
        );
        // Discard the un-read error body so its connection is released back to
        // the pool before the back-off — otherwise every retry leaks a socket
        // (undici holds the connection open until the body is consumed).
        try {
          await response.body?.cancel();
        } catch {
          // stream already closed / errored — nothing left to release
        }
        await sleep(backoff);
        continue;
      }

      const body = await response.text();
      return {
        url: response.url || url,
        status: response.status,
        body,
        contentType:
          response.headers.get("content-type")?.toLowerCase() ?? undefined,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const backoff = 3_000 * attempt;
        console.warn(
          `  Request error for ${url} (${(error as Error).message}); retrying in ${backoff / 1000}s (attempt ${attempt}/${attempts})`,
        );
        await sleep(backoff);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `GET ${url} failed after ${attempts} attempts: ${
      (lastError as Error)?.message ?? "unknown error"
    }`,
  );
}
