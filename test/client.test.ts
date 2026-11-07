import { afterEach, describe, expect, it, jest } from '@jest/globals';
// noinspection ES6PreferShortImport
import * as client from '../src/client.js';
import { mockFetch } from './utils/fetch-mock.js';
import { BASE, ITEM, STATUS } from './utils/context.js';

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
    expect(Object.keys(client).sort()).toEqual([
      'cancelSubmission',
      'fetchStatus',
      'rollback',
      'setPublishedDeployPercentage',
    ]);
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
