export interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Wait for a number of milliseconds.
 *
 * @param ms Duration to wait.
 * @returns A promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a request and decode a JSON (or fall back to text) response. The
 * request is aborted after `timeoutMs`. Read requests are retried a few times
 * on throttling, server errors and network failures; requests that change
 * state are never retried, so an upload or a publish cannot run twice.
 *
 * @param url Absolute URL to call.
 * @param init Request options passed to `fetch`.
 * @param options Timeout in milliseconds, and the number of retries for
 * idempotent requests.
 * @returns The status and decoded body.
 * @throws If the network call fails after the allowed attempts. The message
 * never contains request headers or bodies.
 */
export async function request(
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<HttpResult> {
  const { timeoutMs = 60000, retries = 0 } = options;
  const attempt = async (left: number): Promise<HttpResult> => {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const body = (() => {
        try {
          return text === '' ? undefined : (JSON.parse(text) as unknown);
        } catch {
          return text.slice(0, 500);
        }
      })();
      if (RETRYABLE.has(response.status) && left > 0) {
        await sleep(500 * 2 ** (retries - left));
        return attempt(left - 1);
      }
      return { status: response.status, ok: response.ok, body };
    } catch (error) {
      if (left > 0) {
        await sleep(500 * 2 ** (retries - left));
        return attempt(left - 1);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Network error calling ${new URL(url).host}: ${reason}`);
    }
  };
  return attempt(retries);
}
