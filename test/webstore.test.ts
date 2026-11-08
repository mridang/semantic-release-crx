import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  WebStoreClient,
  getAccessToken,
  request,
  resolveCredentials,
} from '../src/webstore.js';
import { failFetch, mockFetch } from './utils/fetch-mock.js';
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { join } from 'node:path';
import { withTmp } from './utils/tmpdir.js';
import { BASE, ITEM, PUBLISH, STATUS, UPLOAD } from './utils/context.js';
import * as client from '../src/webstore.js';

afterEach(() => jest.restoreAllMocks());

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

  it('never retries, so an upload cannot run twice', async () => {
    const calls = mockFetch({ [UPLOAD]: { status: 503 } });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EWEBSTOREHTTP',
    });
    expect(calls).toHaveLength(1);
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
    failFetch(BASE, new Error('offline'));
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
  it('never retries, so a publish cannot run twice', async () => {
    const calls = mockFetch({ [PUBLISH]: { status: 503 } });
    await expect(
      make().publish({ publishType: 'DEFAULT_PUBLISH' }),
    ).rejects.toMatchObject({ code: 'EWEBSTOREHTTP' });
    expect(calls).toHaveLength(1);
  });

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

describe('WebStoreClient.hasPendingSubmission', () => {
  it('is true only while the submitted revision is pending review', async () => {
    mockFetch({
      [STATUS]: [
        { json: { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } } },
        { json: { submittedItemRevisionStatus: { state: 'PUBLISHED' } } },
        { json: {} },
      ],
    });
    expect(await make().hasPendingSubmission()).toBe(true);
    expect(await make().hasPendingSubmission()).toBe(false);
    expect(await make().hasPendingSubmission()).toBe(false);
  });
});

describe('WebStoreClient.submit', () => {
  const policy = { ignoredWarnings: ['IGNORED'], failOnWarnings: true };
  const reply = (json: unknown) => mockFetch({ [PUBLISH]: { json } });

  it('returns the state and logs every warning', async () => {
    const lines: string[] = [];
    reply({
      state: 'STAGED',
      warningInfo: { warnings: [{ reason: 'IGNORED', description: 'fine' }] },
    });
    expect(
      await make(lines).submit({ publishType: 'STAGED_PUBLISH' }, policy),
    ).toBe('STAGED');
    expect(lines).toEqual(['IGNORED: fine']);
  });

  it('fails once per blocking warning only when failOnWarnings is set', async () => {
    const body = {
      state: 'PENDING_REVIEW',
      warningInfo: {
        warnings: [{ reason: 'A', description: 'a' }, { reason: 'B' }],
      },
    };
    reply(body);
    await expect(
      make().submit({ publishType: 'DEFAULT_PUBLISH' }, policy),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ code: 'A' }),
        expect.objectContaining({ code: 'B', message: 'Warning' }),
      ],
    });
    expect(
      await make().submit(
        { publishType: 'DEFAULT_PUBLISH' },
        { ...policy, failOnWarnings: false },
      ),
    ).toBe('PENDING_REVIEW');
  });

  it('rejects states the store did not accept', async () => {
    for (const state of [
      'REJECTED',
      'CANCELLED',
      'ITEM_STATE_UNSPECIFIED',
      undefined,
    ]) {
      reply({ state });
      await expect(
        make().submit({ publishType: 'DEFAULT_PUBLISH' }, policy),
      ).rejects.toMatchObject({
        code: 'EPUBLISHSTATE',
      });
      jest.restoreAllMocks();
    }
  });
});

describe('auth', () => {
  afterEach(() => jest.restoreAllMocks());

  const TOKEN = 'POST https://oauth2.googleapis.com/token';

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const serviceAccountJson = JSON.stringify({
    type: 'service_account',
    client_email: 'bot@project.iam.gserviceaccount.com',
    private_key: privateKey,
  });

  describe('resolveCredentials', () => {
    it('prefers a ready made access token over everything else', async () => {
      expect(
        await resolveCredentials({
          CHROME_ACCESS_TOKEN: ' ya29.token ',
          GOOGLE_CLIENT_ID: 'id',
          GOOGLE_CLIENT_SECRET: 's',
          GOOGLE_REFRESH_TOKEN: 'r',
        }),
      ).toEqual({ kind: 'accessToken', accessToken: 'ya29.token' });
    });

    it('accepts the OAuth variables the original plugin used', async () => {
      expect(
        await resolveCredentials({
          GOOGLE_CLIENT_ID: 'id',
          GOOGLE_CLIENT_SECRET: 'secret',
          GOOGLE_REFRESH_TOKEN: 'refresh\n',
        }),
      ).toEqual({
        kind: 'oauth',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
      });
    });

    it('reports each missing OAuth variable with the original codes', async () => {
      const error = await resolveCredentials({ GOOGLE_CLIENT_ID: 'id' }).catch(
        (e: unknown) => e as AggregateError,
      );
      expect(
        (error as AggregateError).errors.map((e: { code: string }) => e.code),
      ).toEqual(['EGOOGLECLIENTSECRET', 'EGOOGLEREFRESHTOKEN']);
    });

    it('says what to set when nothing is configured', async () => {
      await expect(resolveCredentials({})).rejects.toMatchObject({
        code: 'ENOCREDENTIALS',
        message: expect.stringContaining('CHROME_ACCESS_TOKEN'),
      });
    });

    it('rejects a refresh token that is the whole JSON response (issue 7)', async () => {
      await expect(
        resolveCredentials({
          GOOGLE_CLIENT_ID: 'id',
          GOOGLE_CLIENT_SECRET: 's',
          GOOGLE_REFRESH_TOKEN: '{"refresh_token":"1//x"}',
        }),
      ).rejects.toMatchObject({ code: 'EREFRESHTOKENFORMAT' });
    });

    it('reads a service account key from the environment as JSON or base64', async () => {
      const plain = await resolveCredentials({
        GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountJson,
      });
      const encoded = await resolveCredentials({
        GOOGLE_SERVICE_ACCOUNT_KEY:
          Buffer.from(serviceAccountJson).toString('base64'),
      });
      expect(plain).toMatchObject({
        kind: 'serviceAccount',
        clientEmail: 'bot@project.iam.gserviceaccount.com',
        tokenUri: 'https://oauth2.googleapis.com/token',
      });
      expect(encoded).toEqual(plain);
    });

    it('reads a service account key file', async () => {
      await withTmp({ 'key.json': serviceAccountJson }, async (dir) => {
        expect(
          await resolveCredentials({
            GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'key.json'),
          }),
        ).toMatchObject({ kind: 'serviceAccount' });
      });
    });

    it('rejects a missing, malformed or incomplete service account key', async () => {
      await expect(
        resolveCredentials({
          GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/key.json',
        }),
      ).rejects.toMatchObject({ code: 'ESERVICEACCOUNT' });
      await expect(
        resolveCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY: '{not json' }),
      ).rejects.toMatchObject({ code: 'ESERVICEACCOUNT' });
      await expect(
        resolveCredentials({
          GOOGLE_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}',
        }),
      ).rejects.toMatchObject({ code: 'ESERVICEACCOUNT' });
    });

    it('explains how to use workload identity federation instead of a credentials file (issue 105)', async () => {
      await withTmp(
        { 'wif.json': JSON.stringify({ type: 'external_account' }) },
        async (dir) => {
          await expect(
            resolveCredentials({
              GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'wif.json'),
            }),
          ).rejects.toMatchObject({
            code: 'ESERVICEACCOUNT',
            message: expect.stringContaining('CHROME_ACCESS_TOKEN'),
          });
        },
      );
    });

    it('does not touch the credentials file when an access token is set', async () => {
      expect(
        await resolveCredentials({
          CHROME_ACCESS_TOKEN: 't',
          GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/wif.json',
        }),
      ).toEqual({ kind: 'accessToken', accessToken: 't' });
    });
  });

  describe('getAccessToken', () => {
    it('returns an access token without any network call', async () => {
      const calls = mockFetch({});
      expect(
        await getAccessToken({ kind: 'accessToken', accessToken: 'abc' }),
      ).toBe('abc');
      expect(calls).toHaveLength(0);
    });

    it('retries the token exchange on a server error', async () => {
      const calls = mockFetch({
        [TOKEN]: [{ status: 503 }, { json: { access_token: 'fresh' } }],
      });
      const token = await getAccessToken({
        kind: 'oauth',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
      });
      expect(token).toBe('fresh');
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toEqual(calls[0].body);
    });

    it('exchanges a refresh token', async () => {
      const calls = mockFetch({ [TOKEN]: { json: { access_token: 'fresh' } } });
      const token = await getAccessToken({
        kind: 'oauth',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
      });
      expect(token).toBe('fresh');
      expect(calls[0].body).toEqual({
        client_id: 'id',
        client_secret: 'secret',
        refresh_token: 'refresh',
        grant_type: 'refresh_token',
      });
    });

    it('explains an expired or revoked refresh token (issue 114)', async () => {
      mockFetch({
        [TOKEN]: {
          status: 400,
          json: {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          },
        },
      });
      const error = await getAccessToken({
        kind: 'oauth',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'SUPER-SECRET-REFRESH',
      }).catch((e: unknown) => e as Error & { code: string });
      expect(error.code).toBe('EREFRESHTOKEN');
      expect(error.message).toContain('7 days');
      expect(error.message).toContain('workload identity federation');
      expect(error.message).not.toContain('SUPER-SECRET-REFRESH');
    });

    it('reports a rejected OAuth client', async () => {
      mockFetch({
        [TOKEN]: { status: 401, json: { error: 'invalid_client' } },
      });
      await expect(
        getAccessToken({
          kind: 'oauth',
          clientId: 'id',
          clientSecret: 's',
          refreshToken: 'r',
        }),
      ).rejects.toMatchObject({ code: 'EGOOGLECLIENT' });
    });

    it('reports any other failure and an empty token response', async () => {
      mockFetch({
        [TOKEN]: [
          { status: 400, json: { error: 'access_denied' } },
          { json: {} },
        ],
      });
      const credentials = {
        kind: 'oauth',
        clientId: 'i',
        clientSecret: 's',
        refreshToken: 'r',
      } as const;
      await expect(getAccessToken(credentials)).rejects.toMatchObject({
        code: 'EAUTH',
      });
      await expect(getAccessToken(credentials)).rejects.toMatchObject({
        code: 'EAUTH',
      });
    });

    it('reports a network failure without leaking the request', async () => {
      failFetch('https://oauth2.googleapis.com', new Error('offline'));
      const error = await getAccessToken({
        kind: 'oauth',
        clientId: 'id',
        clientSecret: 'TOPSECRET',
        refreshToken: 'REFRESH',
      }).catch((e: unknown) => e as Error & { code: string });
      expect(error.code).toBe('EAUTH');
      expect(error.message).not.toMatch(/TOPSECRET|REFRESH/);
    });

    it('signs a service account assertion Google can verify', async () => {
      const calls = mockFetch({
        [TOKEN]: { json: { access_token: 'sa-token' } },
      });
      const credentials = await resolveCredentials({
        GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountJson,
      });
      expect(await getAccessToken(credentials)).toBe('sa-token');
      const body = calls[0].body as { grant_type: string; assertion: string };
      expect(body.grant_type).toBe(
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
      );
      const [header, claims, signature] = body.assertion.split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
        alg: 'RS256',
        typ: 'JWT',
      });
      const payload = JSON.parse(
        Buffer.from(claims, 'base64url').toString(),
      ) as Record<string, unknown>;
      expect(payload).toMatchObject({
        iss: 'bot@project.iam.gserviceaccount.com',
        scope: 'https://www.googleapis.com/auth/chromewebstore',
        aud: 'https://oauth2.googleapis.com/token',
      });
      expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
      const ok = createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(
          createPublicKey(publicKey),
          Buffer.from(signature, 'base64url'),
        );
      expect(ok).toBe(true);
    });
  });
});

describe('http', () => {
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

    it('returns the last response once the retries are used up', async () => {
      const calls = mockFetch({
        'GET https://x.test/a': {
          status: 503,
          text: 'down',
        },
      });
      const result = await request('https://x.test/a', {}, { retries: 2 });
      expect(result).toMatchObject({ status: 503, ok: false, body: 'down' });
      expect(calls).toHaveLength(3);
    });

    it('retries a POST when it is given retries, as the token exchange is', async () => {
      const calls = mockFetch({
        'POST https://x.test/a': [{ status: 500 }, { json: { ok: 1 } }],
      });
      const result = await request(
        'https://x.test/a',
        { method: 'POST' },
        { retries: 1 },
      );
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
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

    it('retries a dropped connection, then gives up with a message free of secrets', async () => {
      const attempts = failFetch(
        'https://x.test',
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );
      await expect(
        request(
          'https://x.test/a?token=secret',
          { headers: { Authorization: 'Bearer secret' } },
          { retries: 1 },
        ),
      ).rejects.toThrow('Network error calling x.test: socket hang up');
      expect(attempts()).toBe(2);
    });

    it('does not retry an error code that is not a connection failure', async () => {
      const attempts = failFetch(
        'https://x.test',
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
      await expect(
        request('https://x.test/a', {}, { retries: 2 }),
      ).rejects.toThrow('Network error calling x.test: denied');
      expect(attempts()).toBe(1);
    });

    it('aborts a request that takes longer than the timeout', async () => {
      mockFetch({ 'GET https://x.test/a': { delayMs: 300 } });
      await expect(
        request('https://x.test/a', {}, { timeoutMs: 20 }),
      ).rejects.toThrow(/aborted/);
    });
  });
});

describe('client', () => {
  afterEach(() => jest.restoreAllMocks());

  const base = {
    publisherId: 'pub-1',
    extensionId: 'ext-1',
    env: { CHROME_ACCESS_TOKEN: 'SECRET-TOKEN' },
  };
  const ROLLBACK = `POST ${BASE}/v2/${ITEM}:rollback`;
  const CANCEL = `POST ${BASE}/v2/${ITEM}:cancelSubmission`;
  const PROMOTE = `POST ${BASE}/v2/${ITEM}:setPublishedDeployPercentage`;

  describe('client subpath', () => {
    it('exports the documented functions', () => {
      expect(
        [
          client.cancelSubmission,
          client.fetchStatus,
          client.rollback,
          client.setPublishedDeployPercentage,
        ].every((fn) => typeof fn === 'function'),
      ).toBe(true);
    });
  });

  describe('rollback', () => {
    it('sends the request schema fields with the bearer token', async () => {
      const calls = mockFetch({ [ROLLBACK]: { json: {} } });
      await client.rollback({
        ...base,
        rollbackReason: 'crash on start',
        newVersion: '1.2.1',
        targetCrxVersion: '1.1.0',
        validateOnly: true,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({
        rollbackReason: 'crash on start',
        newVersion: '1.2.1',
        targetCrxVersion: '1.1.0',
        validateOnly: true,
      });
      expect(calls[0].headers.Authorization).toBe('Bearer SECRET-TOKEN');
    });

    it('leaves out the optional fields that were not given', async () => {
      const calls = mockFetch({ [ROLLBACK]: { json: {} } });
      await client.rollback({
        ...base,
        rollbackReason: 'bad',
        newVersion: '2.0.1',
      });
      expect(calls[0].body).toEqual({
        rollbackReason: 'bad',
        newVersion: '2.0.1',
      });
    });

    it('requires a reason and a new version before any request', async () => {
      const calls = mockFetch({});
      await expect(
        client.rollback({ ...base, rollbackReason: ' ', newVersion: '1' }),
      ).rejects.toMatchObject({ code: 'EINVALIDROLLBACK' });
      await expect(
        client.rollback({ ...base, rollbackReason: 'x', newVersion: '' }),
      ).rejects.toMatchObject({ code: 'EINVALIDROLLBACK' });
      expect(calls).toHaveLength(0);
    });

    it('maps store errors with a hint about the version', async () => {
      mockFetch({
        [ROLLBACK]: {
          status: 400,
          json: { error: { message: 'version too low' } },
        },
      });
      await expect(
        client.rollback({ ...base, rollbackReason: 'x', newVersion: '1.0.0' }),
      ).rejects.toMatchObject({
        code: 'EWEBSTOREBADREQUEST',
        message: expect.stringContaining('newVersion must be higher'),
      });
    });

    it('fails with the credentials code when none are available', async () => {
      mockFetch({});
      await expect(
        client.rollback({
          ...base,
          env: {},
          rollbackReason: 'x',
          newVersion: '1.0.1',
        }),
      ).rejects.toMatchObject({ code: 'ENOCREDENTIALS' });
    });

    it('never exposes the token in an error', async () => {
      mockFetch({
        [ROLLBACK]: { status: 401, json: { error: { message: 'bad' } } },
      });
      const error = (await client
        .rollback({ ...base, rollbackReason: 'x', newVersion: '1.0.1' })
        .catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain('SECRET-TOKEN');
    });
  });

  describe('cancelSubmission', () => {
    it('posts an empty body', async () => {
      const calls = mockFetch({ [CANCEL]: { json: {} } });
      await client.cancelSubmission(base);
      expect(calls[0].body).toEqual({});
    });

    it('maps a store error', async () => {
      mockFetch({
        [CANCEL]: { status: 404, json: { error: { message: 'gone' } } },
      });
      await expect(client.cancelSubmission(base)).rejects.toMatchObject({
        code: 'EWEBSTORENOTFOUND',
      });
    });
  });

  describe('setPublishedDeployPercentage', () => {
    it('posts the percentage', async () => {
      const calls = mockFetch({ [PROMOTE]: { json: {} } });
      await client.setPublishedDeployPercentage({
        ...base,
        deployPercentage: 25,
      });
      expect(calls[0].body).toEqual({ deployPercentage: 25 });
    });

    it('rejects an invalid percentage before any request', async () => {
      const calls = mockFetch({});
      for (const deployPercentage of [-1, 101, 1.5, Number.NaN]) {
        await expect(
          client.setPublishedDeployPercentage({ ...base, deployPercentage }),
        ).rejects.toMatchObject({
          code: 'EINVALIDDEPLOYPERCENTAGE',
        });
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe('fetchStatus', () => {
    it('returns the status', async () => {
      mockFetch({ [STATUS]: { json: { takenDown: false } } });
      expect(await client.fetchStatus(base)).toEqual({ takenDown: false });
    });
  });
});

describe('WebStoreClient response parsing', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps well-formed status fields, including distribution channels', async () => {
    mockFetch({
      [STATUS]: {
        json: {
          lastAsyncUploadState: 'SUCCEEDED',
          submittedItemRevisionStatus: { state: 'PENDING_REVIEW' },
          publishedItemRevisionStatus: {
            state: 'PUBLISHED',
            distributionChannels: [
              { deployPercentage: 50, crxVersion: '1.2.3' },
              'junk',
            ],
          },
          takenDown: false,
          warned: true,
        },
      },
    });
    const status = await make().fetchStatus();
    expect(status.lastAsyncUploadState).toBe('SUCCEEDED');
    expect(status.submittedItemRevisionStatus?.state).toBe('PENDING_REVIEW');
    expect(status.publishedItemRevisionStatus?.distributionChannels).toEqual([
      { deployPercentage: 50, crxVersion: '1.2.3' },
    ]);
    expect(status.takenDown).toBe(false);
    expect(status.warned).toBe(true);
  });

  it('drops values of the wrong type or outside the enum rather than trusting them', async () => {
    mockFetch({
      [STATUS]: {
        json: {
          lastAsyncUploadState: 'MAYBE',
          submittedItemRevisionStatus: 'nope',
          publishedItemRevisionStatus: { state: 7, distributionChannels: 'x' },
          takenDown: 'yes',
          warned: 1,
        },
      },
    });
    const status = await make().fetchStatus();
    expect(status.lastAsyncUploadState).toBeUndefined();
    expect(status.submittedItemRevisionStatus).toBeUndefined();
    expect(status.publishedItemRevisionStatus?.state).toBeUndefined();
    expect(
      status.publishedItemRevisionStatus?.distributionChannels,
    ).toBeUndefined();
    expect(status.takenDown).toBeUndefined();
    expect(status.warned).toBeUndefined();
  });

  it('treats a non-object body as an empty response', async () => {
    mockFetch({ [STATUS]: { text: '"just a string"' } });
    expect(await make().fetchStatus()).toEqual({});
  });

  it('keeps only well-formed publish warnings', async () => {
    mockFetch({
      [PUBLISH]: {
        json: {
          state: 'PENDING_REVIEW',
          warningInfo: {
            warnings: [{ reason: 'A', description: 'a' }, 5, { reason: 2 }],
          },
        },
      },
    });
    const result = await make().publish({ publishType: 'DEFAULT_PUBLISH' });
    expect(result.warningInfo?.warnings).toEqual([
      { reason: 'A', description: 'a' },
      { reason: undefined, description: undefined },
    ]);
  });

  it('reads error details that are not all objects', async () => {
    mockFetch({
      [UPLOAD]: {
        status: 400,
        json: {
          error: {
            message: 'bad',
            details: [{ reason: 'R1' }, 'x', { reason: 3 }],
          },
        },
      },
    });
    const error = await make()
      .upload(Buffer.from('z'))
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('(R1)');
  });
});

describe('WebStoreClient.connect', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the default polling settings unless overridden', async () => {
    mockFetch({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: { json: { lastAsyncUploadState: 'FAILED' } },
    });
    const client = await WebStoreClient.connect({
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      credentials: { kind: 'accessToken', accessToken: 'SECRET-TOKEN' },
      pollIntervalMs: 1,
    });
    await expect(client.upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('exchanges a refresh token for the access token it uses', async () => {
    const calls = mockFetch({
      'POST https://oauth2.googleapis.com/token': {
        json: { access_token: 'minted' },
      },
      [STATUS]: { json: {} },
    });
    const client = await WebStoreClient.connect({
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      credentials: {
        kind: 'oauth',
        clientId: 'i',
        clientSecret: 's',
        refreshToken: 'r',
      },
    });
    await client.fetchStatus();
    expect(calls[1].headers.Authorization).toBe('Bearer minted');
  });
});

describe('WebStoreClient.connect', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the default polling settings unless overridden', async () => {
    mockFetch({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: { json: { lastAsyncUploadState: 'FAILED' } },
    });
    const client = await WebStoreClient.connect({
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      credentials: { kind: 'accessToken', accessToken: 'SECRET-TOKEN' },
      pollIntervalMs: 1,
    });
    await expect(client.upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('exchanges a refresh token for the access token it uses', async () => {
    const calls = mockFetch({
      'POST https://oauth2.googleapis.com/token': {
        json: { access_token: 'minted' },
      },
      [STATUS]: { json: {} },
    });
    const client = await WebStoreClient.connect({
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      credentials: {
        kind: 'oauth',
        clientId: 'i',
        clientSecret: 's',
        refreshToken: 'r',
      },
    });
    await client.fetchStatus();
    expect(calls[1].headers.Authorization).toBe('Bearer minted');
  });
});
