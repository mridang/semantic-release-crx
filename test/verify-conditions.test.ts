import { afterEach, describe, expect, it, jest } from '@jest/globals';
// noinspection ES6PreferShortImport
import { verifyConditions } from '../src/verify-conditions.js';
import { mockFetch } from './utils/fetch-mock.js';
import { CONFIG, STATUS, TOKEN, stepContext } from './utils/context.js';
import type { StepContext } from '../src/plugin-config.js';

afterEach(() => jest.restoreAllMocks());

const run = (
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  const { context, lines } = stepContext(extra);
  return {
    lines,
    result: verifyConditions(
      { ...CONFIG, ...config },
      context as unknown as StepContext,
    ),
  };
};

const codes = async (promise: Promise<unknown>): Promise<string[]> => {
  const error = await promise.catch((e: unknown) => e);
  const list =
    error instanceof AggregateError
      ? (error.errors as Error[])
      : [error as Error];
  return list.map((e) => (e as Error & { code: string }).code);
};

describe('verifyConditions', () => {
  it('proves the credentials work by fetching the item status', async () => {
    const calls = mockFetch({
      [STATUS]: {
        json: { publishedItemRevisionStatus: { state: 'PUBLISHED' } },
      },
    });
    const { result, lines } = run({});
    await result;
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer SECRET-TOKEN');
    expect(lines).toContain('Chrome Web Store credentials are valid.');
  });

  it('does nothing for target local, even without credentials', async () => {
    const calls = mockFetch({});
    const { result, lines } = run(
      { target: 'local', extensionId: undefined },
      { env: {} },
    );
    await result;
    expect(calls).toHaveLength(0);
    expect(lines[0]).toMatch(/Skipping verification/);
  });

  it('does nothing on a pre-release branch when prerelease is skip', async () => {
    const calls = mockFetch({});
    const { result } = run(
      { prerelease: 'skip' },
      { env: {}, branch: { name: 'beta', prerelease: 'beta' } },
    );
    await result;
    expect(calls).toHaveLength(0);
  });

  it('rejects a pre-release branch when prerelease is reject', async () => {
    mockFetch({ [STATUS]: { json: {} } });
    const { result } = run(
      { prerelease: 'reject' },
      { branch: { name: 'beta', prerelease: 'beta' } },
    );
    expect(await codes(result)).toEqual(['EPRERELEASE']);
  });

  it('reports every configuration problem at once', async () => {
    mockFetch({});
    const { result } = run(
      { extensionId: undefined, publisherId: undefined, target: 'nope' },
      { env: {} },
    );
    expect(await codes(result)).toEqual([
      'EINVALIDTARGET',
      'ENOEXTENSIONID',
      'ENOPUBLISHERID',
      'ENOCREDENTIALS',
    ]);
  });

  it('reports the individual missing OAuth variables like the original plugin', async () => {
    mockFetch({});
    const { result } = run({}, { env: { GOOGLE_CLIENT_ID: 'id' } });
    expect(await codes(result)).toEqual([
      'EGOOGLECLIENTSECRET',
      'EGOOGLEREFRESHTOKEN',
    ]);
  });

  it('uses the extension id for the current branch', async () => {
    const calls = mockFetch({
      'GET https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/staging-id:fetchStatus':
        { json: {} },
    });
    const { result } = run(
      { extensionId: { main: 'prod-id', beta: 'staging-id' } },
      { branch: { name: 'beta', prerelease: 'beta' } },
    );
    await result;
    expect(calls[0].url).toContain('staging-id');
  });

  it('exchanges a refresh token before checking the item', async () => {
    const calls = mockFetch({
      [TOKEN]: { json: { access_token: 'minted' } },
      [STATUS]: { json: {} },
    });
    const { result } = run(
      {},
      {
        env: {
          GOOGLE_CLIENT_ID: 'i',
          GOOGLE_CLIENT_SECRET: 's',
          GOOGLE_REFRESH_TOKEN: 'r',
        },
      },
    );
    await result;
    expect(calls[1].headers.Authorization).toBe('Bearer minted');
  });

  it('fails clearly when the store rejects the credentials, without leaking them', async () => {
    mockFetch({
      [STATUS]: {
        status: 401,
        json: { error: { message: 'Invalid Credentials' } },
      },
    });
    const { result } = run({});
    const error = (await result.catch((e: unknown) => e)) as Error & {
      code: string;
    };
    expect(error.code).toBe('EWEBSTOREAUTH');
    expect(error.message).not.toContain('SECRET-TOKEN');
  });

  it('warns about a taken down or warned item', async () => {
    mockFetch({
      [STATUS]: [{ json: { takenDown: true } }, { json: { warned: true } }],
    });
    const first = run({});
    await first.result;
    expect(first.lines.join('\n')).toMatch(/taken down/);
    const second = run({});
    await second.result;
    expect(second.lines.join('\n')).toMatch(/policy warning/);
  });
});
