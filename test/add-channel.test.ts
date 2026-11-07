import { afterEach, describe, expect, it, jest } from '@jest/globals';
// noinspection ES6PreferShortImport
import { addChannel } from '../src/add-channel.js';
import { mockFetch } from './utils/fetch-mock.js';
import { BASE, CONFIG, ITEM, stepContext } from './utils/context.js';
import type { StepContext } from '../src/plugin-config.js';

afterEach(() => jest.restoreAllMocks());

const PROMOTE = `POST ${BASE}/v2/${ITEM}:setPublishedDeployPercentage`;

const run = (
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  const { context, lines } = stepContext(extra);
  return {
    lines,
    result: addChannel(
      { ...CONFIG, ...config },
      context as unknown as StepContext,
    ),
  };
};

describe('addChannel', () => {
  it('does nothing unless promoteDeployPercentage is set', async () => {
    const calls = mockFetch({});
    expect(await run({}).result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('does nothing for target local', async () => {
    const calls = mockFetch({});
    expect(
      await run({ promoteDeployPercentage: 50, target: 'local' }).result,
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('raises the published rollout and returns the release link', async () => {
    const calls = mockFetch({ [PROMOTE]: { json: {} } });
    const { result, lines } = run({ promoteDeployPercentage: 50 });
    expect(await result).toEqual({
      name: 'Chrome Web Store',
      url: 'https://chromewebstore.google.com/detail/ext-1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ deployPercentage: 50 });
    expect(calls[0].headers.Authorization).toBe('Bearer SECRET-TOKEN');
    expect(lines.join('\n')).not.toContain('SECRET-TOKEN');
  });

  it('accepts 0 and 100', async () => {
    mockFetch({ [PROMOTE]: { json: {} } });
    await run({ promoteDeployPercentage: 0 }).result;
    await run({ promoteDeployPercentage: 100 }).result;
  });

  it('rejects an invalid percentage with the deployPercentage code', async () => {
    mockFetch({});
    for (const value of [101, -1, 2.5]) {
      const error = (await run({ promoteDeployPercentage: value }).result.catch(
        (e: unknown) => e,
      )) as AggregateError;
      expect(error.errors[0]).toMatchObject({
        code: 'EINVALIDDEPLOYPERCENTAGE',
      });
    }
  });

  it('reports missing options and credentials', async () => {
    mockFetch({});
    const missing = (await run(
      {
        promoteDeployPercentage: 5,
        extensionId: undefined,
        publisherId: undefined,
      },
      { env: {} },
    ).result.catch((e: unknown) => e)) as AggregateError;
    expect(
      missing.errors.map((e: Error & { code?: string }) => e.code),
    ).toEqual(['ENOEXTENSIONID', 'ENOPUBLISHERID']);
    await expect(
      run({ promoteDeployPercentage: 5 }, { env: {} }).result,
    ).rejects.toMatchObject({ code: 'ENOCREDENTIALS' });
  });

  it('surfaces the store refusal with the preconditions', async () => {
    mockFetch({
      [PROMOTE]: {
        status: 400,
        json: { error: { message: 'percentage must be larger' } },
      },
    });
    await expect(
      run({ promoteDeployPercentage: 5 }).result,
    ).rejects.toMatchObject({
      code: 'EWEBSTOREBADREQUEST',
      message: expect.stringMatching(/larger than the current target.*10,000/),
    });
  });

  it('maps a permission failure', async () => {
    mockFetch({
      [PROMOTE]: { status: 403, json: { error: { message: 'denied' } } },
    });
    await expect(
      run({ promoteDeployPercentage: 5 }).result,
    ).rejects.toMatchObject({ code: 'EWEBSTOREPERMISSION' });
  });

  it('falls back to the default polling settings and to process.env', async () => {
    const saved = { ...process.env };
    process.env.CHROME_ACCESS_TOKEN = 'ENV-TOKEN';
    try {
      const calls = mockFetch({ [PROMOTE]: { json: {} } });
      await run(
        {
          promoteDeployPercentage: 5,
          pollIntervalMs: undefined,
          pollTimeoutMs: undefined,
        },
        { env: undefined },
      ).result;
      expect(calls[0].headers.Authorization).toBe('Bearer ENV-TOKEN');
    } finally {
      process.env = saved;
    }
  });
});
