import { afterEach, describe, expect, it, jest } from '@jest/globals';
// noinspection ES6PreferShortImport
import { WebStoreClient } from '../src/webstore-client.js';
import { mockFetch } from './utils/fetch-mock.js';

afterEach(() => jest.restoreAllMocks());

const BASE = 'https://chromewebstore.googleapis.com';
const ITEM = 'publishers/pub-1/items/ext-1';
const UPLOAD = `POST ${BASE}/upload/v2/${ITEM}:upload`;
const STATUS = `GET ${BASE}/v2/${ITEM}:fetchStatus`;
const PUBLISH = `POST ${BASE}/v2/${ITEM}:publish`;

const make = (lines: string[] = [], overrides = {}): WebStoreClient =>
  new WebStoreClient({
    publisherId: 'pub-1',
    extensionId: 'ext-1',
    accessToken: 'SECRET-TOKEN',
    pollIntervalMs: 1,
    pollTimeoutMs: 200,
    log: (message) => lines.push(message),
    ...overrides,
  });

describe('WebStoreClient.upload', () => {
  it('posts the raw zip to the V2 upload endpoint with the bearer token', async () => {
    const calls = mockFetch({
      [UPLOAD]: { json: { uploadState: 'SUCCEEDED', crxVersion: '1.2.3' } },
    });
    const zip = Buffer.from('zip-bytes');
    const result = await make().upload(zip);
    expect(result.crxVersion).toBe('1.2.3');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({
      Authorization: 'Bearer SECRET-TOKEN',
      'Content-Type': 'application/zip',
    });
    expect(Buffer.from(calls[0].body as Uint8Array).equals(zip)).toBe(true);
  });

  it('polls fetchStatus while the upload is in progress, then succeeds', async () => {
    const lines: string[] = [];
    const calls = mockFetch({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: [
        { json: { lastAsyncUploadState: 'IN_PROGRESS' } },
        { json: { lastAsyncUploadState: 'NOT_FOUND' } },
        { json: { lastAsyncUploadState: 'SUCCEEDED' } },
      ],
    });
    await make(lines).upload(Buffer.from('z'));
    expect(calls.filter((c) => c.url.includes('fetchStatus'))).toHaveLength(3);
    expect(lines[0]).toMatch(/being processed/);
  });

  it('fails with EUPLOADFAILED when the async upload fails', async () => {
    mockFetch({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: { json: { lastAsyncUploadState: 'FAILED' } },
    });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('gives up with EUPLOADTIMEOUT after the bounded wait', async () => {
    const calls = mockFetch({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: { json: { lastAsyncUploadState: 'IN_PROGRESS' } },
    });
    const started = Date.now();
    await expect(
      make([], { pollTimeoutMs: 30 }).upload(Buffer.from('z')),
    ).rejects.toMatchObject({
      code: 'EUPLOADTIMEOUT',
      message: expect.stringContaining('Nothing was published'),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls.length).toBeGreaterThan(2);
  });

  it('fails when the upload is reported as FAILED', async () => {
    mockFetch({ [UPLOAD]: { json: { uploadState: 'FAILED' } } });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('fails with ENOTFOUND-style guidance when the item is NOT_FOUND', async () => {
    mockFetch({ [UPLOAD]: { json: { uploadState: 'NOT_FOUND' } } });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EWEBSTORENOTFOUND',
    });
  });

  it('fails on an unspecified or missing state instead of assuming success', async () => {
    mockFetch({
      [UPLOAD]: [
        { json: { uploadState: 'UPLOAD_STATE_UNSPECIFIED' } },
        { json: {} },
        {},
      ],
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
        code: 'EUPLOADFAILED',
      });
    }
  });
});

describe('WebStoreClient errors', () => {
  const failing = async (status: number, json: unknown) => {
    mockFetch({ [UPLOAD]: { status, json } });
    return make()
      .upload(Buffer.from('z'))
      .catch((e: unknown) => e as Error & { code: string });
  };

  it('explains a 400 with the Google message and a checklist (issues 7, 69)', async () => {
    const error = await failing(400, {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Item is missing a privacy policy',
        details: [{ reason: 'PRIVACY_TAB_INCOMPLETE' }],
      },
    });
    expect(error.code).toBe('EWEBSTOREBADREQUEST');
    expect(error.message).toContain('HTTP 400 INVALID_ARGUMENT');
    expect(error.message).toContain('Item is missing a privacy policy');
    expect(error.message).toContain('PRIVACY_TAB_INCOMPLETE');
    expect(error.message).toContain('Privacy and Distribution');
  });

  it('explains a 401 as an expired or invalid token', async () => {
    const error = await failing(401, {
      error: { message: 'Invalid Credentials' },
    });
    expect(error.code).toBe('EWEBSTOREAUTH');
    expect(error.message).toContain('expired');
  });

  it('explains a 403 as missing publisher membership or a disabled API', async () => {
    const error = await failing(403, {
      error: { message: 'denied', status: 'PERMISSION_DENIED' },
    });
    expect(error.code).toBe('EWEBSTOREPERMISSION');
    expect(error.message).toMatch(/member of the publisher/);
  });

  it('explains a 404 as a wrong id or a missing draft', async () => {
    const error = await failing(404, { error: { message: 'not found' } });
    expect(error.code).toBe('EWEBSTORENOTFOUND');
    expect(error.message).toMatch(/draft/);
  });

  it('handles other statuses and non JSON bodies', async () => {
    mockFetch({ [UPLOAD]: { status: 500, text: 'Internal oops' } });
    const error = await make()
      .upload(Buffer.from('z'))
      .catch((e: unknown) => e as Error & { code: string });
    expect(error.code).toBe('EWEBSTOREHTTP');
    expect(error.message).toContain('Internal oops');
  });

  it('handles an error response without a message', async () => {
    const error = await failing(418, {});
    expect(error.message).toContain('no error message');
  });

  it('reports network failures as EWEBSTORENETWORK', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EWEBSTORENETWORK',
    });
  });

  it('never puts the access token in an error message', async () => {
    const error = await failing(401, { error: { message: 'bad' } });
    expect(error.message).not.toContain('SECRET-TOKEN');
  });
});

describe('WebStoreClient.fetchStatus', () => {
  it('returns the decoded status', async () => {
    mockFetch({
      [STATUS]: {
        json: { publishedItemRevisionStatus: { state: 'PUBLISHED' } },
      },
    });
    expect(
      (await make().fetchStatus()).publishedItemRevisionStatus?.state,
    ).toBe('PUBLISHED');
  });

  it('retries transient server errors', async () => {
    const calls = mockFetch({ [STATUS]: [{ status: 503 }, { json: {} }] });
    await make().fetchStatus();
    expect(calls).toHaveLength(2);
  });

  it('url encodes the identifiers', async () => {
    const calls = mockFetch({
      [`GET ${BASE}/v2/publishers/a%2Fb/items/c%20d:fetchStatus`]: { json: {} },
    });
    await make([], { publisherId: 'a/b', extensionId: 'c d' }).fetchStatus();
    expect(calls).toHaveLength(1);
  });
});

describe('WebStoreClient.publish', () => {
  it('posts the publish options as JSON and returns the state', async () => {
    const calls = mockFetch({
      [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
    });
    const result = await make().publish({
      publishType: 'STAGED_PUBLISH',
      deployInfos: [{ deployPercentage: 5 }],
    });
    expect(result.state).toBe('PENDING_REVIEW');
    expect(calls[0].body).toEqual({
      publishType: 'STAGED_PUBLISH',
      deployInfos: [{ deployPercentage: 5 }],
    });
  });

  it('surfaces an API error', async () => {
    mockFetch({
      [PUBLISH]: {
        status: 400,
        json: { error: { message: 'pending review' } },
      },
    });
    await expect(
      make().publish({ publishType: 'DEFAULT_PUBLISH' }),
    ).rejects.toMatchObject({
      code: 'EWEBSTOREBADREQUEST',
    });
  });
});

describe('WebStoreClient polling edge cases', () => {
  const polling = (status: unknown, extra: Record<string, unknown> = {}) => {
    const calls = mockFetch({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: status as never,
      [PUBLISH]: { json: { state: 'PUBLISHED' } },
      ...extra,
    });
    return calls;
  };
  const published = (calls: { url: string }[]) =>
    calls.some((c) => c.url.endsWith(':publish'));

  it('keeps waiting on NOT_FOUND and ends in EUPLOADTIMEOUT without publishing', async () => {
    const calls = polling({ json: { lastAsyncUploadState: 'NOT_FOUND' } });
    await expect(
      make([], { pollTimeoutMs: 30 }).upload(Buffer.from('z')),
    ).rejects.toMatchObject({
      code: 'EUPLOADTIMEOUT',
    });
    expect(
      calls.filter((c) => c.url.includes('fetchStatus')).length,
    ).toBeGreaterThan(1);
    expect(published(calls)).toBe(false);
  });

  it('surfaces a coded error when fetchStatus fails while polling', async () => {
    const calls = polling({
      status: 403,
      json: { error: { message: 'denied' } },
    });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EWEBSTOREPERMISSION',
    });
    expect(published(calls)).toBe(false);
  });

  it('fails with EUPLOADFAILED when polling reports FAILED', async () => {
    const calls = polling([
      { json: { lastAsyncUploadState: 'IN_PROGRESS' } },
      { json: { lastAsyncUploadState: 'FAILED' } },
    ]);
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
    expect(published(calls)).toBe(false);
  });
});

describe('WebStoreClient promotion, cancel and rollback', () => {
  it('uses the V2 operation URLs and JSON bodies', async () => {
    const calls = mockFetch({
      [`POST ${BASE}/v2/${ITEM}:cancelSubmission`]: { json: {} },
      [`POST ${BASE}/v2/${ITEM}:setPublishedDeployPercentage`]: { json: {} },
      [`POST ${BASE}/v2/${ITEM}:rollback`]: { json: {} },
    });
    const client = make();
    await client.cancelSubmission();
    await client.setPublishedDeployPercentage(40);
    await client.rollback({ rollbackReason: 'r', newVersion: '2' });
    expect(calls.map((c) => [c.url.split(':').pop(), c.body])).toEqual([
      ['cancelSubmission', {}],
      ['setPublishedDeployPercentage', { deployPercentage: 40 }],
      ['rollback', { rollbackReason: 'r', newVersion: '2' }],
    ]);
    expect(
      calls.every((c) => c.headers['Content-Type'] === 'application/json'),
    ).toBe(true);
  });

  it('adds the precondition hint for a 403 as well', async () => {
    mockFetch({
      [`POST ${BASE}/v2/${ITEM}:setPublishedDeployPercentage`]: {
        status: 403,
        json: { error: { message: 'no' } },
      },
    });
    await expect(make().setPublishedDeployPercentage(10)).rejects.toMatchObject(
      {
        message: expect.stringContaining('10,000 seven-day active users'),
      },
    );
  });
});
