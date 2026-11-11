import { loadFixture } from './utils/fixtures.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  WebStoreClient,
  type RequestOptions,
  getAccessToken,
  request,
  resolveCredentials,
} from '../src/webstore.js';
import { failHttp, mockAgent, mockHttp } from './utils/http-mock.js';
import { startTunnelProxy } from './utils/proxy.js';
import { listen, startFaultyProxy } from './utils/server.js';
import { inspect } from 'node:util';
import { MockAgent } from 'undici';
import { createPublicKey, createVerify } from 'node:crypto';
import { generateKeyPairAsync } from './utils/crypto.js';
import path from 'node:path';
import { withTmp } from './utils/tmpdir.js';
import { BASE, ITEM, PUBLISH, STATUS, UPLOAD } from './utils/context.js';
import {
  cancelSubmission,
  fetchStatus,
  rollback,
  setPublishedDeployPercentage,
} from '../src/webstore.js';

const urls = await loadFixture('insecure-urls.json');

const { privateKey, publicKey } = await generateKeyPairAsync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

afterEach(() => jest.restoreAllMocks());

const make = (lines: string[] = [], overrides = {}): WebStoreClient =>
  new WebStoreClient({
    publisherId: 'pub-1',
    extensionId: 'ext-1',
    accessToken: 'SECRET-TOKEN',
    pollIntervalMs: 1,
    pollTimeoutMs: 200,
    log: (message) => lines.push(message),
    agent: mockAgent(),
    ...overrides,
  });

const tokenFor = (credentials: Parameters<typeof getAccessToken>[0]) =>
  getAccessToken(credentials, mockAgent());

describe('WebStoreClient.upload', () => {
  it('posts the raw zip to the V2 upload endpoint with the bearer token', async () => {
    const calls = mockHttp({
      [UPLOAD]: { json: { uploadState: 'SUCCEEDED', crxVersion: '1.2.3' } },
    });
    const zip = Buffer.from('zip-bytes');
    const result = await make().upload(zip);
    expect(result.crxVersion).toBe('1.2.3');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({
      authorization: 'Bearer SECRET-TOKEN',
      'content-type': 'application/zip',
    });
    expect(Buffer.from(calls[0].body as Uint8Array).equals(zip)).toBe(true);
  });

  it('never retries, so an upload cannot run twice', async () => {
    const calls = mockHttp({ [UPLOAD]: { status: 503 } });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EWEBSTOREHTTP',
    });
    expect(calls).toHaveLength(1);
  });

  it('polls fetchStatus while the upload is in progress, then succeeds', async () => {
    const lines: string[] = [];
    const calls = mockHttp({
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
    mockHttp({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: { json: { lastAsyncUploadState: 'FAILED' } },
    });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('gives up with EUPLOADTIMEOUT after the bounded wait', async () => {
    const calls = mockHttp({
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
    mockHttp({ [UPLOAD]: { json: { uploadState: 'FAILED' } } });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('fails with ENOTFOUND-style guidance when the item is NOT_FOUND', async () => {
    mockHttp({ [UPLOAD]: { json: { uploadState: 'NOT_FOUND' } } });
    await expect(make().upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EWEBSTORENOTFOUND',
    });
  });

  it('fails on an unspecified or missing state instead of assuming success', async () => {
    mockHttp({
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
    mockHttp({ [UPLOAD]: { status, json } });
    try {
      return await make().upload(Buffer.from('z'));
    } catch (error) {
      return error as Error & { code: string };
    }
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
    mockHttp({ [UPLOAD]: { status: 500, text: 'Internal oops' } });
    const failure = await make()
      .upload(Buffer.from('z'))
      .catch((error: unknown) => error as Error & { code: string });
    expect(failure.code).toBe('EWEBSTOREHTTP');
    expect(failure.message).toContain('Internal oops');
  });

  it('handles an error response without a message', async () => {
    const error = await failing(418, {});
    expect(error.message).toContain('no error message');
  });

  it('reports network failures as EWEBSTORENETWORK', async () => {
    failHttp(BASE, new Error('offline'));
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
    mockHttp({
      [STATUS]: {
        json: { publishedItemRevisionStatus: { state: 'PUBLISHED' } },
      },
    });
    expect(await make().fetchStatus()).toMatchObject({
      publishedItemRevisionStatus: { state: 'PUBLISHED' },
    });
  });

  it('retries transient server errors', async () => {
    const calls = mockHttp({ [STATUS]: [{ status: 503 }, { json: {} }] });
    await make().fetchStatus();
    expect(calls).toHaveLength(2);
  });

  it('url encodes the identifiers', async () => {
    const calls = mockHttp({
      [`GET ${BASE}/v2/publishers/a%2Fb/items/c%20d:fetchStatus`]: { json: {} },
    });
    await make([], { publisherId: 'a/b', extensionId: 'c d' }).fetchStatus();
    expect(calls).toHaveLength(1);
  });
});

describe('WebStoreClient.publish', () => {
  it('never retries, so a publish cannot run twice', async () => {
    const calls = mockHttp({ [PUBLISH]: { status: 503 } });
    await expect(
      make().publish({ publishType: 'DEFAULT_PUBLISH' }),
    ).rejects.toMatchObject({ code: 'EWEBSTOREHTTP' });
    expect(calls).toHaveLength(1);
  });

  it('posts the publish options as JSON and returns the state', async () => {
    const calls = mockHttp({
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
    mockHttp({
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
    return mockHttp({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: status as never,
      [PUBLISH]: { json: { state: 'PUBLISHED' } },
      ...extra,
    });
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
    const calls = mockHttp({
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
      calls.every((c) => c.headers['content-type'] === 'application/json'),
    ).toBe(true);
  });

  it('adds the precondition hint for a 403 as well', async () => {
    mockHttp({
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
    mockHttp({
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
  const reply = (json: unknown) => mockHttp({ [PUBLISH]: { json } });

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

// eslint-disable-next-line sonarjs/max-lines-per-function -- shared fixtures and helpers close over every nested case, so splitting would be artificial
describe('auth', () => {
  afterEach(() => jest.restoreAllMocks());

  const TOKEN = 'POST https://oauth2.googleapis.com/token';

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
      const failure = await resolveCredentials({
        GOOGLE_CLIENT_ID: 'id',
      }).catch((error: unknown) => error as AggregateError);
      expect(
        (failure as AggregateError).errors.map((e: { code: string }) => e.code),
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
            GOOGLE_APPLICATION_CREDENTIALS: path.join(dir, 'key.json'),
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
              GOOGLE_APPLICATION_CREDENTIALS: path.join(dir, 'wif.json'),
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
      const calls = mockHttp({});
      expect(await tokenFor({ kind: 'accessToken', accessToken: 'abc' })).toBe(
        'abc',
      );
      expect(calls).toHaveLength(0);
    });

    it('retries the token exchange on a server error', async () => {
      const calls = mockHttp({
        [TOKEN]: [{ status: 503 }, { json: { access_token: 'fresh' } }],
      });
      const token = await tokenFor({
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
      const calls = mockHttp({ [TOKEN]: { json: { access_token: 'fresh' } } });
      const token = await tokenFor({
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
      mockHttp({
        [TOKEN]: {
          status: 400,
          json: {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          },
        },
      });
      const failure = await tokenFor({
        kind: 'oauth',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'SUPER-SECRET-REFRESH',
      }).catch((error: unknown) => error as Error & { code: string });
      expect(failure.code).toBe('EREFRESHTOKEN');
      expect(failure.message).toContain('7 days');
      expect(failure.message).toContain('workload identity federation');
      expect(failure.message).not.toContain('SUPER-SECRET-REFRESH');
    });

    it('reports a rejected OAuth client', async () => {
      mockHttp({
        [TOKEN]: { status: 401, json: { error: 'invalid_client' } },
      });
      await expect(
        tokenFor({
          kind: 'oauth',
          clientId: 'id',
          clientSecret: 's',
          refreshToken: 'r',
        }),
      ).rejects.toMatchObject({ code: 'EGOOGLECLIENT' });
    });

    it('reports any other failure and an empty token response', async () => {
      mockHttp({
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
      await expect(tokenFor(credentials)).rejects.toMatchObject({
        code: 'EAUTH',
      });
      await expect(tokenFor(credentials)).rejects.toMatchObject({
        code: 'EAUTH',
      });
    });

    it('reports a network failure without leaking the request', async () => {
      failHttp('https://oauth2.googleapis.com', new Error('offline'));
      const failure = await tokenFor({
        kind: 'oauth',
        clientId: 'id',
        clientSecret: 'TOPSECRET',
        refreshToken: 'REFRESH',
      }).catch((error: unknown) => error as Error & { code: string });
      expect(failure.code).toBe('EAUTH');
      expect(failure.message).not.toMatch(/TOPSECRET|REFRESH/);
    });

    it('signs a service account assertion Google can verify', async () => {
      const calls = mockHttp({
        [TOKEN]: { json: { access_token: 'sa-token' } },
      });
      const credentials = await resolveCredentials({
        GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountJson,
      });
      expect(await tokenFor(credentials)).toBe('sa-token');
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

describe('request', () => {
  const GET = 'GET https://x.test/a';
  const URL_A = 'https://x.test/a';
  const via = (extra: RequestOptions = {}): RequestOptions => ({
    agent: mockAgent(),
    minTimeout: 1,
    ...extra,
  });

  it('decodes a JSON body', async () => {
    mockHttp({ [GET]: { json: { ok: 1 } } });
    expect(await request(URL_A, {}, via())).toEqual({
      status: 200,
      ok: true,
      body: { ok: 1 },
    });
  });

  it('falls back to text for a body that is not JSON', async () => {
    mockHttp({ [GET]: { status: 502, text: '<html>bad</html>' } });
    expect(await request(URL_A, {}, via())).toMatchObject({
      status: 502,
      ok: false,
      body: '<html>bad</html>',
    });
  });

  it('returns an undefined body for an empty response', async () => {
    mockHttp({ [GET]: {} });
    const response = await request(URL_A, {}, via());
    expect(response.body).toBeUndefined();
  });

  it('sends the default headers once, whatever the case of an override', async () => {
    const calls = mockHttp({ [GET]: {} });
    await request(
      URL_A,
      { headers: { Accept: 'text/plain', 'X-Extra': '1' } },
      via(),
    );
    expect(calls[0].headers).toEqual({
      accept: 'text/plain',
      'user-agent': 'semantic-release-crx',
      'x-extra': '1',
    });
  });

  it('retries throttling and server errors when asked to', async () => {
    const calls = mockHttp({
      [GET]: [{ status: 429 }, { status: 503 }, { json: { ok: 1 } }],
    });
    const result = await request(URL_A, {}, via({ retries: 2 }));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('returns the last response once the retries are used up', async () => {
    const calls = mockHttp({ [GET]: { status: 503, text: 'down' } });
    const result = await request(URL_A, {}, via({ retries: 2 }));
    expect(result).toMatchObject({ status: 503, ok: false, body: 'down' });
    expect(calls).toHaveLength(3);
  });

  it('retries an idempotent method other than GET', async () => {
    const calls = mockHttp({
      'PUT https://x.test/a': [{ status: 500 }, { json: {} }],
    });
    await request(URL_A, { method: 'PUT' }, via({ retries: 1 }));
    expect(calls).toHaveLength(2);
  });

  it('retries a POST only when retryPost is set, as the token exchange does', async () => {
    const calls = mockHttp({
      'POST https://x.test/a': [{ status: 500 }, { json: { ok: 1 } }],
    });
    const result = await request(
      URL_A,
      { method: 'POST' },
      via({ retries: 1, retryPost: true }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('never retries a POST without retryPost, whatever retries says', async () => {
    const calls = mockHttp({ 'POST https://x.test/a': { status: 503 } });
    const result = await request(
      URL_A,
      { method: 'POST' },
      via({ retries: 3 }),
    );
    expect(result.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('does not retry unless asked to', async () => {
    const calls = mockHttp({ [GET]: { status: 503 } });
    const response = await request(URL_A, {}, via());
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a client error', async () => {
    const calls = mockHttp({ [GET]: { status: 404 } });
    await request(URL_A, {}, via({ retries: 3 }));
    expect(calls).toHaveLength(1);
  });

  it('retries a dropped connection, then gives up with a message free of secrets', async () => {
    const attempts = failHttp(
      'https://x.test',
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const failure = await request(
      'https://x.test/a?token=secret',
      { headers: { Authorization: 'Bearer secret' } },
      via({ retries: 1 }),
    ).catch((error: unknown) => error);
    expect(String(failure)).toBe(
      'Error: Network error calling x.test: socket hang up',
    );
    expect(attempts()).toBe(2);
  });

  it('does not retry an error code that is not a connection failure', async () => {
    const attempts = failHttp(
      'https://x.test',
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    await expect(request(URL_A, {}, via({ retries: 2 }))).rejects.toThrow(
      'Network error calling x.test: denied',
    );
    expect(attempts()).toBe(1);
  });

  it('names the code of a failure with an empty message, such as a dual-stack refusal', async () => {
    failHttp(
      'https://x.test',
      Object.assign(
        new AggregateError([new Error('v4'), new Error('v6')], 'x'),
        {
          code: 'ECONNREFUSED',
          message: '',
        },
      ),
    );
    await expect(request(URL_A, {}, via())).rejects.toThrow(
      'Network error calling x.test: ECONNREFUSED',
    );
  });

  it('refuses a malformed proxy setting without printing it', async () => {
    const saved = { ...process.env };
    process.env.HTTPS_PROXY = urls.malformedProxy;
    try {
      const failure = await request(URL_A, {}).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'EPROXY' });
      const shown = [
        String(failure),
        inspect(failure, { depth: 10, showHidden: true }),
        JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
        JSON.stringify(Object.entries(failure as object)),
      ].join('\n');
      expect(shown).not.toContain('PW-SECRET');
      expect(shown).toContain('HTTPS_PROXY');
    } finally {
      process.env = saved;
    }
  });
});

// eslint-disable-next-line sonarjs/max-lines-per-function -- shared fixtures and helpers close over every nested case, so splitting would be artificial
describe('request over a real socket', () => {
  const stops: (() => Promise<void>)[] = [];
  const saved = { ...process.env };

  const serve = async (
    handler: Parameters<typeof listen>[0],
  ): ReturnType<typeof listen> => {
    const server = await listen(handler);
    stops.push(server.close);
    return server;
  };

  afterEach(async () => {
    process.env = { ...saved };
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it('honours Retry-After before retrying', async () => {
    const { url, seen } = await serve((_req, res) => {
      const first = seen.length === 1;
      res.writeHead(first ? 503 : 200, first ? { 'Retry-After': '1' } : {});
      res.end(first ? 'busy' : '{"ok":1}');
    });
    const started = Date.now();
    const result = await request(`${url}/a`, {}, { retries: 1 });
    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('caps a long Retry-After at a quarter of the deadline', async () => {
    const { url, seen } = await serve((_req, res) => {
      const first = seen.length === 1;
      res.writeHead(first ? 429 : 200, first ? { 'Retry-After': '20' } : {});
      res.end('{}');
    });
    const started = Date.now();
    await request(`${url}/a`, {}, { retries: 1, deadlineMs: 4000 });
    const took = Date.now() - started;
    expect(seen).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(3000);
  });

  it('sends a retried POST body again, intact', async () => {
    const bodies: string[] = [];
    const { url } = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString());
        res.writeHead(bodies.length === 1 ? 503 : 200);
        res.end('{}');
      });
    });
    const result = await request(
      `${url}/token`,
      { method: 'POST', body: 'grant_type=x' },
      { retries: 1, retryPost: true, minTimeout: 1 },
    );
    expect(result.ok).toBe(true);
    expect(bodies).toEqual(['grant_type=x', 'grant_type=x']);
  });

  it('sends an upload body with its content length', async () => {
    const lengths: (string | undefined)[] = [];
    const { url } = await serve((req, res) => {
      lengths.push(req.headers['content-length']);
      req.resume();
      req.on('end', () => res.end('{}'));
    });
    const zip = Buffer.from('zip-bytes');
    await request(`${url}/up`, {
      method: 'POST',
      headers: { 'Content-Length': String(zip.length) },
      body: zip,
    });
    expect(lengths).toEqual(['9']);
  });

  it('retries an attempt that stalls, as a dropped connection is', async () => {
    const { url, seen } = await serve((_req, res) => {
      if (seen.length > 1) {
        res.end('{"ok":1}');
      }
    });
    const result = await request(
      `${url}/a`,
      {},
      { retries: 1, attemptTimeoutMs: 1000, minTimeout: 1 },
    );
    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toHaveLength(2);
  }, 15_000);

  it('gives up with one request per attempt when every attempt stalls', async () => {
    const { url, seen } = await serve(() => undefined);
    await expect(
      request(
        `${url}/a`,
        {},
        { retries: 1, attemptTimeoutMs: 1000, minTimeout: 1 },
      ),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(2);
  }, 15_000);

  it('stops at the deadline, which does not include a back-off when nothing is retried', async () => {
    const { url } = await serve(() => undefined);
    const started = Date.now();
    await expect(request(`${url}/a`, {}, { deadlineMs: 1000 })).rejects.toThrow(
      /aborted due to timeout/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  }, 15_000);

  it('sends exactly retries + 1 whole requests when the body is always cut short', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('{"par');
      setTimeout(() => res.socket?.destroy(), 10);
    });
    await expect(
      request(
        `${url}/a`,
        { method: 'POST', body: 'a=1' },
        { retries: 2, retryPost: true, minTimeout: 1 },
      ),
    ).rejects.toThrow(/other side closed/);
    expect(seen).toEqual(['POST /a', 'POST /a', 'POST /a']);
  }, 15_000);

  it('sends the whole request again, never a Range resume, when the body is cut once', async () => {
    const { url, seen } = await serve((_req, res) => {
      if (seen.length === 1) {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('{"par');
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.end('{"ok":1}');
    });
    const result = await request(
      `${url}/a`,
      { method: 'POST', body: 'a=1' },
      { retries: 2, retryPost: true, minTimeout: 1 },
    );
    expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
    expect(seen).toEqual(['POST /a', 'POST /a']);
  });

  it('reports a body that is cut short when the request may not be retried', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('{"par');
      setTimeout(() => res.socket?.destroy(), 10);
    });
    await expect(
      request(`${url}/a`, { method: 'POST', body: 'a=1' }, { retries: 3 }),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(1);
  });

  it('does not read, or repeat a request for, a body larger than the cap', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(33 * 1024 * 1024, 97));
    });
    await expect(
      request(`${url}/a`, {}, { retries: 2, minTimeout: 1 }),
    ).rejects.toThrow(/Network error calling 127\.0\.0\.1/);
    expect(seen).toHaveLength(1);
  });

  it('never follows a redirect and reports where it pointed, without the query', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(302, { Location: '/elsewhere?token=SECRET' });
      res.end();
    });
    const result = await request(`${url}/a`, {
      method: 'POST',
      body: 'a=1',
    });
    expect(result).toMatchObject({
      status: 302,
      ok: false,
      location: `${url}/elsewhere`,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(seen).toEqual(['POST /a']);
  });

  it('names the code when a closed local port refuses the connection, without leaking the URL', async () => {
    const server = await listen(() => undefined);
    await server.close();
    const failure = await request(
      `http://localhost:${server.port}/a?token=SECRET`,
      { headers: { Authorization: 'Bearer SECRET' } },
    ).catch((error: unknown) => error);
    expect(String(failure)).toContain('ECONNREFUSED');
    expect(String(failure)).not.toContain('SECRET');
  });

  it('goes through the proxy named by the environment', async () => {
    const target = await serve((_req, res) => res.end('{"direct":1}'));
    const proxy = await startTunnelProxy(target.port);
    stops.push(proxy.close);
    process.env.HTTP_PROXY = proxy.url;
    process.env.NO_PROXY = '';
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    const result = await request(urls.invalidHost, {});
    expect(result.body).toEqual({ direct: 1 });
    expect(proxy.tunnelled).toEqual(['something.invalid:80']);
  });

  it('skips the proxy for hosts listed in NO_PROXY', async () => {
    const target = await serve((_req, res) => res.end('{"direct":1}'));
    const proxy = await startTunnelProxy(target.port);
    stops.push(proxy.close);
    process.env.HTTP_PROXY = proxy.url;
    process.env.NO_PROXY = '127.0.0.1';
    delete process.env.http_proxy;
    delete process.env.no_proxy;
    const result = await request(`${target.url}/a`, {});
    expect(result.body).toEqual({ direct: 1 });
    expect(proxy.tunnelled).toHaveLength(0);
  });

  it.each(['reset', 'stall'] as const)(
    'gives up at the deadline when the proxy accepts CONNECT and then %ss, and stays idle',
    async (mode) => {
      const proxy = await startFaultyProxy(mode);
      stops.push(proxy.close);
      process.env.HTTP_PROXY = proxy.url;
      process.env.NO_PROXY = '';
      delete process.env.http_proxy;
      delete process.env.no_proxy;
      const started = Date.now();
      await expect(
        request(
          urls.invalidHost,
          {},
          { retries: 1, deadlineMs: 1500, minTimeout: 1 },
        ),
      ).rejects.toThrow(/Network error calling something\.invalid/);
      expect(Date.now() - started).toBeLessThan(4000);
      const connects = proxy.connects();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(proxy.connects()).toBe(connects);
    },
    15_000,
  );

  describe('redirects', () => {
    it('are not followed unless asked for, and the target is shown without its query', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(302, { Location: '/elsewhere?token=SECRET' });
        res.end();
      });

      const result = await request(`${url}/a`, {});

      expect(result).toMatchObject({
        status: 302,
        ok: false,
        location: `${url}/elsewhere`,
      });
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(seen).toEqual(['GET /a']);
    });

    it('are followed on the same origin when asked for, credentials included', async () => {
      const headers: unknown[] = [];
      const { url, seen } = await serve((req, res) => {
        headers.push(req.headers['authorization']);
        if (seen.length === 1) {
          res.writeHead(301, { Location: '/b?x=1' }).end();
          return;
        }
        res.end('{"ok":1}');
      });

      const result = await request(
        `${url}/a`,
        { headers: { Authorization: 'Bearer T' } },
        { followRedirects: true },
      );

      expect(result).toMatchObject({ status: 200, body: { ok: 1 } });
      expect(seen).toEqual(['GET /a', 'GET /b?x=1']);
      expect(headers).toEqual(['Bearer T', 'Bearer T']);
    });

    it('are not followed to another origin, so the credentials stay put', async () => {
      const other = await serve((_req, res) => res.end('{"leak":1}'));
      const { url } = await serve((_req, res) => {
        res.writeHead(302, { Location: `${other.url}/x?token=SECRET` }).end();
      });

      const result = await request(
        `${url}/a`,
        { headers: { Authorization: 'Bearer T' } },
        { followRedirects: true },
      );

      expect(result).toMatchObject({
        status: 302,
        location: `${other.url}/x`,
      });
      expect(other.seen).toHaveLength(0);
    });

    it('are not followed from https to http', async () => {
      const agent = new MockAgent();
      agent.disableNetConnect();
      agent
        .get('https://x.test')
        .intercept({ path: '/a', method: 'GET' })
        .reply(301, '', { headers: { location: urls.redirectTarget } });

      const result = await request(
        'https://x.test/a',
        {},
        { agent, followRedirects: true },
      );

      expect(result).toMatchObject({
        status: 301,
        location: urls.redirectLocation,
      });
    });

    it('stop after three hops and report the last redirect', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(301, { Location: '/again' }).end();
      });

      const result = await request(`${url}/a`, {}, { followRedirects: true });

      expect(result).toMatchObject({ status: 301, location: `${url}/again` });
      expect(seen).toHaveLength(4);
    });

    it('are not followed for a POST', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(307, { Location: '/b' }).end();
      });

      const result = await request(
        `${url}/a`,
        { method: 'POST', body: 'a=1' },
        { followRedirects: true },
      );

      expect(result.status).toBe(307);
      expect(seen).toEqual(['POST /a']);
    });

    it('are not followed without a usable location', async () => {
      const { url, seen } = await serve((_req, res) => {
        res.writeHead(302).end();
      });

      const result = await request(`${url}/a`, {}, { followRedirects: true });

      expect(result).toMatchObject({ status: 302 });
      expect(result.location).toBeUndefined();
      expect(seen).toHaveLength(1);
    });
  });
});

describe('client', () => {
  afterEach(() => jest.restoreAllMocks());

  const base = {
    publisherId: 'pub-1',
    extensionId: 'ext-1',
    env: { CHROME_ACCESS_TOKEN: 'SECRET-TOKEN' },
    get agent() {
      return mockAgent();
    },
  };
  const ROLLBACK = `POST ${BASE}/v2/${ITEM}:rollback`;
  const CANCEL = `POST ${BASE}/v2/${ITEM}:cancelSubmission`;
  const PROMOTE = `POST ${BASE}/v2/${ITEM}:setPublishedDeployPercentage`;

  describe('client subpath', () => {
    it('exports the documented functions', () => {
      expect(
        [
          cancelSubmission,
          fetchStatus,
          rollback,
          setPublishedDeployPercentage,
        ].every((fn) => typeof fn === 'function'),
      ).toBe(true);
    });
  });

  describe('rollback', () => {
    it('sends the request schema fields with the bearer token', async () => {
      const calls = mockHttp({ [ROLLBACK]: { json: {} } });
      await rollback({
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
      expect(calls[0].headers.authorization).toBe('Bearer SECRET-TOKEN');
    });

    it('leaves out the optional fields that were not given', async () => {
      const calls = mockHttp({ [ROLLBACK]: { json: {} } });
      await rollback({
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
      const calls = mockHttp({});
      await expect(
        rollback({ ...base, rollbackReason: ' ', newVersion: '1' }),
      ).rejects.toMatchObject({ code: 'EINVALIDROLLBACK' });
      await expect(
        rollback({ ...base, rollbackReason: 'x', newVersion: '' }),
      ).rejects.toMatchObject({ code: 'EINVALIDROLLBACK' });
      expect(calls).toHaveLength(0);
    });

    it('maps store errors with a hint about the version', async () => {
      mockHttp({
        [ROLLBACK]: {
          status: 400,
          json: { error: { message: 'version too low' } },
        },
      });
      await expect(
        rollback({ ...base, rollbackReason: 'x', newVersion: '1.0.0' }),
      ).rejects.toMatchObject({
        code: 'EWEBSTOREBADREQUEST',
        message: expect.stringContaining('newVersion must be higher'),
      });
    });

    it('fails with the credentials code when none are available', async () => {
      mockHttp({});
      await expect(
        rollback({
          ...base,
          env: {},
          rollbackReason: 'x',
          newVersion: '1.0.1',
        }),
      ).rejects.toMatchObject({ code: 'ENOCREDENTIALS' });
    });

    it('never exposes the token in an error', async () => {
      mockHttp({
        [ROLLBACK]: { status: 401, json: { error: { message: 'bad' } } },
      });
      const failure = (await rollback({
        ...base,
        rollbackReason: 'x',
        newVersion: '1.0.1',
      }).catch((error: unknown) => error)) as Error;
      expect(failure.message).not.toContain('SECRET-TOKEN');
    });
  });

  describe('cancelSubmission', () => {
    it('posts an empty body', async () => {
      const calls = mockHttp({ [CANCEL]: { json: {} } });
      await cancelSubmission(base);
      expect(calls[0].body).toEqual({});
    });

    it('maps a store error', async () => {
      mockHttp({
        [CANCEL]: { status: 404, json: { error: { message: 'gone' } } },
      });
      await expect(cancelSubmission(base)).rejects.toMatchObject({
        code: 'EWEBSTORENOTFOUND',
      });
    });
  });

  describe('setPublishedDeployPercentage', () => {
    it('posts the percentage', async () => {
      const calls = mockHttp({ [PROMOTE]: { json: {} } });
      await setPublishedDeployPercentage({
        ...base,
        deployPercentage: 25,
      });
      expect(calls[0].body).toEqual({ deployPercentage: 25 });
    });

    it('rejects an invalid percentage before any request', async () => {
      const calls = mockHttp({});
      for (const deployPercentage of [-1, 101, 1.5, Number.NaN]) {
        await expect(
          setPublishedDeployPercentage({ ...base, deployPercentage }),
        ).rejects.toMatchObject({
          code: 'EINVALIDDEPLOYPERCENTAGE',
        });
      }
      expect(calls).toHaveLength(0);
    });
  });

  describe('fetchStatus', () => {
    it('returns the status', async () => {
      mockHttp({ [STATUS]: { json: { takenDown: false } } });
      expect(await fetchStatus(base)).toEqual({ takenDown: false });
    });
  });
});

describe('WebStoreClient response parsing', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps well-formed status fields, including distribution channels', async () => {
    mockHttp({
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
    mockHttp({
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
    mockHttp({ [STATUS]: { text: '"just a string"' } });
    expect(await make().fetchStatus()).toEqual({});
  });

  it('keeps only well-formed publish warnings', async () => {
    mockHttp({
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
      {},
    ]);
  });

  it('reads error details that are not all objects', async () => {
    mockHttp({
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
    const failure = await make()
      .upload(Buffer.from('z'))
      .catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('(R1)');
  });
});

describe('WebStoreClient.connect', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the default polling settings unless overridden', async () => {
    mockHttp({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: { json: { lastAsyncUploadState: 'FAILED' } },
    });
    const client = await WebStoreClient.connect({
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      credentials: { kind: 'accessToken', accessToken: 'SECRET-TOKEN' },
      pollIntervalMs: 1,
      agent: mockAgent(),
    });
    await expect(client.upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('exchanges a refresh token for the access token it uses', async () => {
    const calls = mockHttp({
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
      agent: mockAgent(),
    });
    await client.fetchStatus();
    expect(calls[1].headers.authorization).toBe('Bearer minted');
  });
});

describe('WebStoreClient.connect', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the default polling settings unless overridden', async () => {
    mockHttp({
      [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
      [STATUS]: { json: { lastAsyncUploadState: 'FAILED' } },
    });
    const client = await WebStoreClient.connect({
      publisherId: 'pub-1',
      extensionId: 'ext-1',
      credentials: { kind: 'accessToken', accessToken: 'SECRET-TOKEN' },
      pollIntervalMs: 1,
      agent: mockAgent(),
    });
    await expect(client.upload(Buffer.from('z'))).rejects.toMatchObject({
      code: 'EUPLOADFAILED',
    });
  });

  it('exchanges a refresh token for the access token it uses', async () => {
    const calls = mockHttp({
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
      agent: mockAgent(),
    });
    await client.fetchStatus();
    expect(calls[1].headers.authorization).toBe('Bearer minted');
  });
});
