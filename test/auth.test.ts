import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { join } from 'node:path';
// noinspection ES6PreferShortImport
import { getAccessToken, resolveCredentials } from '../src/auth.js';
import { mockFetch } from './utils/fetch-mock.js';
import { withTmp } from './utils/tmpdir.js';

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
    mockFetch({ [TOKEN]: { status: 401, json: { error: 'invalid_client' } } });
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
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
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
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
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
      .verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url'));
    expect(ok).toBe(true);
  });
});
