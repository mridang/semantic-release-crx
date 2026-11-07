import { afterEach, describe, expect, it, jest } from '@jest/globals';
// noinspection ES6PreferShortImport
import { request, sleep } from '../src/http.js';
import { mockFetch } from './utils/fetch-mock.js';

afterEach(() => jest.restoreAllMocks());

describe('request', () => {
  it('decodes a JSON body', async () => {
    mockFetch({ 'GET https://x.test/a': { json: { ok: 1 } } });
    expect(await request('https://x.test/a', {})).toEqual({
      status: 200,
      ok: true,
      body: { ok: 1 },
    });
  });

  it('falls back to text for a body that is not JSON', async () => {
    mockFetch({
      'GET https://x.test/a': { status: 502, text: '<html>bad</html>' },
    });
    expect(await request('https://x.test/a', {})).toMatchObject({
      status: 502,
      ok: false,
      body: '<html>bad</html>',
    });
  });

  it('returns an undefined body for an empty response', async () => {
    mockFetch({ 'GET https://x.test/a': {} });
    expect((await request('https://x.test/a', {})).body).toBeUndefined();
  });

  it('retries throttling and server errors when asked to', async () => {
    const calls = mockFetch({
      'GET https://x.test/a': [
        { status: 429 },
        { status: 503 },
        { json: { ok: 1 } },
      ],
    });
    const result = await request('https://x.test/a', {}, { retries: 2 });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('does not retry unless asked to', async () => {
    const calls = mockFetch({ 'POST https://x.test/a': { status: 503 } });
    const result = await request('https://x.test/a', { method: 'POST' });
    expect(result.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a client error', async () => {
    const calls = mockFetch({ 'GET https://x.test/a': { status: 404 } });
    await request('https://x.test/a', {}, { retries: 3 });
    expect(calls).toHaveLength(1);
  });

  it('retries a network failure, then gives up with a message free of secrets', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('socket hang up'));
    await expect(
      request(
        'https://x.test/a?token=secret',
        { headers: { Authorization: 'Bearer secret' } },
        { retries: 1 },
      ),
    ).rejects.toThrow('Network error calling x.test: socket hang up');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('aborts a request that takes longer than the timeout', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    await expect(
      request('https://x.test/a', {}, { timeoutMs: 20 }),
    ).rejects.toThrow(/aborted/);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const start = Date.now();
    await sleep(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
