import { MockAgent, setGlobalDispatcher } from 'undici';
import { isRecord } from '../../src/utils/object.js';

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  delayMs?: number;
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = Reply | ((call: Call) => Reply) | Reply[];

let agent: MockAgent | undefined;

/**
 * Put a fresh `MockAgent` in front of undici, which `fetch` and the
 * `RetryAgent` in `request()` both resolve through, so no test reaches the
 * network. Each call replaces the previous agent. An unmocked request fails with a `MockNotMatchedError`.
 *
 * @returns The agent to register interceptors on.
 */
function install(): MockAgent {
  void agent?.close();
  agent = new MockAgent({ enableCallHistory: true });
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent;
}

/**
 * Turn the headers undici hands to a dispatcher into a plain record.
 *
 * @param headers Either an object or a flat list of name and value pairs.
 * @returns The headers keyed by their original names.
 */
function headerRecord(headers: unknown): Record<string, string> {
  return Array.isArray(headers)
    ? Object.fromEntries(
        headers.flatMap((_, i) =>
          i % 2 === 0 ? [[String(headers[i]), String(headers[i + 1])]] : [],
        ),
      )
    : isRecord(headers)
      ? Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k, String(v)]),
        )
      : {};
}

/**
 * Decode a request body the way the tests want to inspect it.
 *
 * @param body The body undici hands to the dispatcher.
 * @param headers The request headers, to tell a form from JSON.
 * @returns A form as an object, JSON parsed, bytes as they are.
 */
function decodeBody(body: unknown, headers: Record<string, string>): unknown {
  const type = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === 'content-type',
  )?.[1];
  return typeof body === 'string'
    ? type?.includes('x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(body))
      : (JSON.parse(body) as unknown)
    : body instanceof Uint8Array
      ? body
      : undefined;
}

/**
 * Route undici requests to canned replies so tests never touch the network.
 * Routes are keyed `"METHOD url"`, ignoring any query string. A list of
 * replies is served in order and the last one repeats; a request with no
 * route fails the test loudly.
 *
 * @param routes Responses keyed by method and URL.
 * @returns Every request that was made, in order.
 */
export function mockFetch(routes: Record<string, Responder>): Call[] {
  const calls: Call[] = [];
  const mock = install();
  Object.entries(routes).forEach(([key, route]) => {
    const [method, rawUrl] = key.split(' ');
    const url = new URL(rawUrl);
    const path = url.pathname;
    let served = 0;
    const scope = mock
      .get(url.origin)
      .intercept({
        method,
        path: (actual: string) => actual.split('?')[0] === path,
      })
      .reply((options) => {
        const headers = headerRecord(options.headers);
        const call: Call = {
          method,
          url: `${url.origin}${options.path}`,
          headers,
          body: decodeBody(options.body, headers),
        };
        calls.push(call);
        const index = served++;
        const reply =
          typeof route === 'function'
            ? route(call)
            : Array.isArray(route)
              ? route[Math.min(index, route.length - 1)]
              : route;
        return {
          statusCode: reply.status ?? 200,
          data:
            reply.text ??
            (reply.json === undefined ? '' : JSON.stringify(reply.json)),
        };
      })
      .persist();
    if (!Array.isArray(route) && typeof route !== 'function' && route.delayMs) {
      scope.delay(route.delayMs);
    }
  });
  return calls;
}

/**
 * Make every request to `origin` fail with a connection error.
 *
 * @param origin The scheme and host to break.
 * @param error What the socket reports.
 * @returns A function giving the number of attempts made so far.
 */
export function failFetch(origin: string, error: Error): () => number {
  const mock = install();
  mock
    .get(origin)
    .intercept({ path: () => true })
    .replyWithError(error)
    .persist();
  return () => mock.getCallHistory()?.calls().length ?? 0;
}
