import { jest } from '@jest/globals';

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = Reply | ((call: Call) => Reply) | Reply[];

/**
 * Replace the global `fetch` with a router so tests never touch the network.
 * Routes are keyed `"METHOD url"`, ignoring any query string. A list of
 * replies is served in order and the last one repeats; a request with no
 * route fails the test loudly.
 *
 * @param routes Responses keyed by method and URL.
 * @returns Every request that was made, in order.
 */
export function mockFetch(routes: Record<string, Responder>): Call[] {
  const calls: Call[] = [];
  const served = new Map<string, number>();
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.split('?')[0]}`;
    const rawBody = init?.body;
    const call: Call = {
      method,
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body:
        rawBody instanceof URLSearchParams
          ? Object.fromEntries(rawBody)
          : rawBody instanceof Uint8Array
            ? rawBody
            : typeof rawBody === 'string'
              ? (JSON.parse(rawBody) as unknown)
              : undefined,
    };
    calls.push(call);
    const route = routes[key];
    if (route === undefined) {
      throw new Error(`unexpected request: ${key}`);
    }
    const index = served.get(key) ?? 0;
    served.set(key, index + 1);
    const reply =
      typeof route === 'function'
        ? route(call)
        : Array.isArray(route)
          ? route[Math.min(index, route.length - 1)]
          : route;
    const status = reply.status ?? 200;
    return new Response(
      reply.text ??
        (reply.json === undefined ? '' : JSON.stringify(reply.json)),
      { status },
    );
  });
  return calls;
}
