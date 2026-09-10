import type { Config } from "../../config.ts";
import type { OverpassResponse } from "../../types.ts";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Default number of Overpass request attempts (overridable via `options.attempts`). */
const DEFAULT_ATTEMPTS = 3;

/** Linear back-off base: attempt N sleeps `RETRY_BASE_BACKOFF_MS * N` before retrying. */
const RETRY_BASE_BACKOFF_MS = 5_000;

/** Default per-attempt client abort timeout, ms (overridable via `options.timeoutMs`). */
const DEFAULT_CLIENT_TIMEOUT_MS = 180_000;

/**
 * A non-retryable HTTP response from Overpass — a definitive failure. Thrown so
 * the retry `catch` can re-raise it immediately instead of retrying it.
 */
class DefinitiveHttpError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST the query to Overpass, with polite retries (linear back-off) on
 * transient errors and timeouts. Throws on a definitive failure — the caller
 * must then abort the run and write nothing.
 */
export async function fetchOverpass(
  query: string,
  config: Config,
  options: { attempts?: number; timeoutMs?: number } = {},
): Promise<OverpassResponse> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(config.overpassUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": config.overpassUserAgent,
          Accept: "application/json",
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
          const backoff = RETRY_BASE_BACKOFF_MS * attempt;
          console.warn(
            `  Overpass HTTP ${response.status}; retrying in ${backoff / 1000}s (attempt ${attempt}/${attempts})`,
          );
          await sleep(backoff);
          continue;
        }
        // A retryable status that has exhausted its attempts still flows through
        // the generic "after N attempts" wrapper (unchanged). A non-retryable
        // status is definitive: throw a marker the retry `catch` re-raises at
        // once, so no further request is made.
        if (RETRYABLE_STATUS.has(response.status)) {
          throw new Error(`Overpass request failed: HTTP ${response.status}`);
        }
        throw new DefinitiveHttpError(
          `Overpass request failed: HTTP ${response.status}`,
        );
      }

      const payload = (await response.json()) as OverpassResponse & {
        remark?: string;
      };
      // Overloaded / timed-out Overpass instances answer 200 with a top-level
      // `remark` (timeout / out of memory / "reduce load"), often alongside an
      // empty or truncated `elements` list. Treat any meaningful remark as a
      // transient failure, not a partial success — a degraded fetch must never
      // look like a successful sync.
      if (typeof payload.remark === "string" && payload.remark.trim() !== "") {
        throw new Error(`Overpass returned an error remark: ${payload.remark}`);
      }
      if (!Array.isArray(payload.elements)) {
        throw new Error("Overpass response had no elements array");
      }
      return payload;
    } catch (error) {
      // A definitive HTTP failure never retries — re-raise it as-is.
      if (error instanceof DefinitiveHttpError) throw error;
      lastError = error;
      if (attempt < attempts) {
        const backoff = RETRY_BASE_BACKOFF_MS * attempt;
        console.warn(
          `  Overpass request error (${(error as Error).message}); retrying in ${backoff / 1000}s (attempt ${attempt}/${attempts})`,
        );
        await sleep(backoff);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `Overpass request failed after ${attempts} attempts: ${
      (lastError as Error)?.message ?? "unknown error"
    }`,
  );
}
