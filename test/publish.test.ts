import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
// noinspection ES6PreferShortImport
import { publish } from '../src/publish.js';
import { mockFetch } from './utils/fetch-mock.js';
import {
  CONFIG,
  PUBLISH,
  STATUS,
  UPLOAD,
  stepContext,
} from './utils/context.js';
import { withTmp } from './utils/tmpdir.js';
import type { StepContext } from '../src/plugin-config.js';

afterEach(() => jest.restoreAllMocks());

const OK_UPLOAD = { json: { uploadState: 'SUCCEEDED', crxVersion: '1.1.0' } };

const run = (
  dir: string,
  config: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => {
  const { context, lines } = stepContext({ cwd: dir, ...extra });
  return {
    lines,
    result: publish(
      { ...CONFIG, ...config },
      context as unknown as StepContext,
    ),
  };
};

const withAsset = (fn: (dir: string) => Promise<void>) =>
  withTmp({ 'ext-v1.1.0.zip': 'PK-fake-zip' }, fn);

describe('publish', () => {
  it('uploads, then publishes, and returns the release link', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
      });
      const { result, lines } = run(dir);
      expect(await result).toEqual({
        name: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/ext-1',
      });
      expect(calls.map((c) => c.method + ' ' + c.url.split('/').pop())).toEqual(
        ['POST ext-1:upload', 'POST ext-1:publish'],
      );
      expect(calls[1].body).toEqual({ publishType: 'DEFAULT_PUBLISH' });
      expect(lines.join('\n')).toMatch(/state PENDING_REVIEW/);
    });
  });

  it('never publishes unless the upload succeeded', async () => {
    await withAsset(async (dir) => {
      for (const upload of [
        { json: { uploadState: 'FAILED' } },
        { json: { uploadState: 'NOT_FOUND' } },
        { json: {} },
        { status: 400, json: { error: { message: 'bad zip' } } },
      ]) {
        const calls = mockFetch({
          [UPLOAD]: upload,
          [PUBLISH]: { json: { state: 'PUBLISHED' } },
        });
        await expect(run(dir).result).rejects.toBeDefined();
        expect(calls.some((c) => c.url.endsWith(':publish'))).toBe(false);
        jest.restoreAllMocks();
      }
    });
  });

  it('waits for an asynchronous upload before publishing', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
        [STATUS]: [
          { json: { lastAsyncUploadState: 'IN_PROGRESS' } },
          { json: { lastAsyncUploadState: 'SUCCEEDED' } },
        ],
        [PUBLISH]: { json: { state: 'PUBLISHED' } },
      });
      await run(dir).result;
      expect(calls.map((c) => c.url.split(':').pop())).toEqual([
        'upload',
        'fetchStatus',
        'fetchStatus',
        'publish',
      ]);
    });
  });

  it('does not publish when the async upload fails or times out', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
        [STATUS]: { json: { lastAsyncUploadState: 'FAILED' } },
        [PUBLISH]: { json: { state: 'PUBLISHED' } },
      });
      await expect(run(dir).result).rejects.toMatchObject({
        code: 'EUPLOADFAILED',
      });
      expect(calls.some((c) => c.url.endsWith(':publish'))).toBe(false);
    });
    await withAsset(async (dir) => {
      mockFetch({
        [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
        [STATUS]: { json: { lastAsyncUploadState: 'IN_PROGRESS' } },
      });
      await expect(
        run(dir, { pollTimeoutMs: 10 }).result,
      ).rejects.toMatchObject({ code: 'EUPLOADTIMEOUT' });
    });
  });

  it('uploads but does not publish for target draft (issues 60, 90)', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({ [UPLOAD]: OK_UPLOAD });
      const { result, lines } = run(dir, { target: 'draft' });
      expect((await result)?.name).toBe('Chrome Web Store');
      expect(calls).toHaveLength(1);
      expect(lines.join('\n')).toMatch(/skipping publish step/);
    });
  });

  it('does not contact the store for target local (issue 103)', async () => {
    const calls = mockFetch({});
    const { result, lines } = run('/nowhere', {
      target: 'local',
      extensionId: undefined,
    });
    expect(await result).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(lines[0]).toMatch(/skipping the publish step/);
  });

  it('stages the submission for target staged', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { json: { state: 'STAGED' } },
      });
      await run(dir, { target: 'staged' }).result;
      expect(calls[1].body).toEqual({ publishType: 'STAGED_PUBLISH' });
    });
  });

  it('accepts trustedTesters, warns, and publishes as default', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { json: { state: 'PUBLISHED_TO_TESTERS' } },
      });
      const { result, lines } = run(dir, { target: 'trustedTesters' });
      await result;
      expect(calls[1].body).toEqual({ publishType: 'DEFAULT_PUBLISH' });
      expect(lines.join('\n')).toMatch(/Distribution settings/);
    });
  });

  it('sends rollout percentage and skipReview', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
      });
      await run(dir, { deployPercentage: 10, skipReview: true }).result;
      expect(calls[1].body).toEqual({
        publishType: 'DEFAULT_PUBLISH',
        deployInfos: [{ deployPercentage: 10 }],
        skipReview: true,
      });
    });
  });

  it('logs the friction warning but does not fail (issue 46)', async () => {
    await withAsset(async (dir) => {
      mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: {
          json: {
            state: 'PENDING_REVIEW',
            warningInfo: {
              warnings: [
                {
                  reason: 'PUBLISHED_WITH_FRICTION_WARNING',
                  description: 'needs extra time to review',
                },
              ],
            },
          },
        },
      });
      const { result, lines } = run(dir, { failOnWarnings: true });
      expect((await result)?.name).toBe('Chrome Web Store');
      expect(lines.join('\n')).toContain(
        'PUBLISHED_WITH_FRICTION_WARNING: needs extra time to review',
      );
    });
  });

  it('logs other warnings by default and fails on them with failOnWarnings', async () => {
    const reply = {
      [UPLOAD]: OK_UPLOAD,
      [PUBLISH]: {
        json: {
          state: 'PENDING_REVIEW',
          warningInfo: {
            warnings: [{ reason: 'BROAD_HOSTS', description: 'broad' }],
          },
        },
      },
    };
    await withAsset(async (dir) => {
      mockFetch(reply);
      const { result, lines } = run(dir);
      await result;
      expect(lines.join('\n')).toContain('BROAD_HOSTS: broad');
    });
    await withAsset(async (dir) => {
      mockFetch(reply);
      await expect(
        run(dir, { failOnWarnings: true }).result,
      ).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: 'BROAD_HOSTS' })],
      });
    });
  });

  it('lets the whitelist be changed', async () => {
    await withAsset(async (dir) => {
      mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: {
          json: {
            state: 'PENDING_REVIEW',
            warningInfo: { warnings: [{ reason: 'BROAD_HOSTS' }, {}] },
          },
        },
      });
      expect(
        (
          await run(dir, {
            failOnWarnings: true,
            ignoredWarnings: ['BROAD_HOSTS', ''],
          }).result
        )?.name,
      ).toBe('Chrome Web Store');
    });
  });

  it('fails clearly, not with a TypeError, on a response without a state (issue 41)', async () => {
    await withAsset(async (dir) => {
      mockFetch({ [UPLOAD]: OK_UPLOAD, [PUBLISH]: { json: {} } });
      await expect(run(dir).result).rejects.toMatchObject({
        code: 'EPUBLISHSTATE',
      });
    });
  });

  it('fails when the submission is rejected or cancelled', async () => {
    await withAsset(async (dir) => {
      for (const state of ['REJECTED', 'CANCELLED', 'ITEM_STATE_UNSPECIFIED']) {
        mockFetch({ [UPLOAD]: OK_UPLOAD, [PUBLISH]: { json: { state } } });
        await expect(run(dir).result).rejects.toMatchObject({
          code: 'EPUBLISHSTATE',
        });
        jest.restoreAllMocks();
      }
    });
  });

  it('accepts every successful submission state', async () => {
    await withAsset(async (dir) => {
      for (const state of [
        'PENDING_REVIEW',
        'STAGED',
        'PUBLISHED',
        'PUBLISHED_TO_TESTERS',
      ]) {
        mockFetch({ [UPLOAD]: OK_UPLOAD, [PUBLISH]: { json: { state } } });
        expect((await run(dir).result)?.url).toContain('ext-1');
        jest.restoreAllMocks();
      }
    });
  });

  it('surfaces the store error when publishing is refused (issues 7, 69)', async () => {
    await withAsset(async (dir) => {
      mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: {
          status: 400,
          json: {
            error: {
              status: 'FAILED_PRECONDITION',
              message: 'Privacy practices incomplete',
            },
          },
        },
      });
      await expect(run(dir).result).rejects.toMatchObject({
        code: 'EWEBSTOREBADREQUEST',
        message: expect.stringContaining('Privacy practices incomplete'),
      });
    });
  });

  it('skips pre-releases when prerelease is skip, but still publishes stable releases', async () => {
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
      });
      const skipped = run(
        dir,
        { prerelease: 'skip' },
        { nextRelease: { version: '1.1.0-beta.1' } },
      );
      expect(await skipped.result).toBeUndefined();
      expect(calls).toHaveLength(0);
      expect(skipped.lines[0]).toMatch(/pre-release/);
      expect((await run(dir, { prerelease: 'skip' }).result)?.name).toBe(
        'Chrome Web Store',
      );
    });
  });

  it('publishes to the extension mapped to the branch (issues 24, 111)', async () => {
    await withTmp({ 'ext-v1.1.0.zip': 'zip' }, async (dir) => {
      const calls = mockFetch({
        'POST https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/staging-id:upload':
          OK_UPLOAD,
        'POST https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/staging-id:publish':
          { json: { state: 'PENDING_REVIEW' } },
      });
      const { result } = run(
        dir,
        { extensionId: { main: 'prod-id', beta: 'staging-id' } },
        { branch: { name: 'beta' } },
      );
      expect((await result)?.url).toBe(
        'https://chromewebstore.google.com/detail/staging-id',
      );
      expect(calls.every((c) => c.url.includes('staging-id'))).toBe(true);
    });
  });

  it('reports every missing option together', async () => {
    mockFetch({});
    const { result } = run(
      '/nowhere',
      { extensionId: undefined, publisherId: undefined, asset: undefined },
      { env: {} },
    );
    const error = (await result.catch((e: unknown) => e)) as AggregateError;
    expect(error.errors.map((e: Error & { code?: string }) => e.code)).toEqual([
      'ENOASSET',
      'ENOEXTENSIONID',
      'ENOPUBLISHERID',
    ]);
  });

  it('fails with ENOASSETFILE when prepare has not produced the zip', async () => {
    await withTmp({}, async (dir) => {
      mockFetch({});
      await expect(run(dir).result).rejects.toMatchObject({
        code: 'ENOASSETFILE',
      });
    });
  });

  it('fails when there are no credentials', async () => {
    await withAsset(async (dir) => {
      mockFetch({});
      await expect(run(dir, {}, { env: {} }).result).rejects.toMatchObject({
        code: 'ENOCREDENTIALS',
      });
    });
  });

  it('never writes the token to the log or into an error', async () => {
    await withAsset(async (dir) => {
      mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { status: 403, json: { error: { message: 'denied' } } },
      });
      const { result, lines } = run(dir);
      const error = (await result.catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain('SECRET-TOKEN');
      expect(lines.join('\n')).not.toContain('SECRET-TOKEN');
    });
  });

  it('reads the zip the asset template points at', async () => {
    await withTmp({}, async (dir) => {
      await writeFile(join(dir, 'chrome-main.zip'), 'zip');
      mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { json: { state: 'PUBLISHED' } },
      });
      expect(
        (await run(dir, { asset: 'chrome-${branch.name}.zip' }).result)?.name,
      ).toBe('Chrome Web Store');
    });
  });
});

describe('publish blockOnWarnings', () => {
  const body = async (config: Record<string, unknown>) => {
    let sent: unknown;
    await withAsset(async (dir) => {
      const calls = mockFetch({
        [UPLOAD]: OK_UPLOAD,
        [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
      });
      await run(dir, config).result;
      sent = calls[1].body;
    });
    return sent as Record<string, unknown>;
  };

  it('asks the store to block before submitting when no warning may be ignored', async () => {
    expect(
      await body({ failOnWarnings: true, ignoredWarnings: [] }),
    ).toHaveProperty('blockOnWarnings', true);
  });

  it('does not when some warnings are ignored, the default whitelist applies, or failOnWarnings is off', async () => {
    expect(
      await body({ failOnWarnings: true, ignoredWarnings: ['X'] }),
    ).not.toHaveProperty('blockOnWarnings');
    expect(await body({ failOnWarnings: true })).not.toHaveProperty(
      'blockOnWarnings',
    );
    expect(await body({ ignoredWarnings: [] })).not.toHaveProperty(
      'blockOnWarnings',
    );
  });
});
