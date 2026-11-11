import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mockHttp } from './utils/http-mock.js';
import {
  BASE,
  CONFIG,
  ITEM,
  PUBLISH,
  STATUS,
  TOKEN,
  UPLOAD,
  stepContext,
} from './utils/context.js';
import { withTmp } from './utils/tmpdir.js';
import { unzip } from './utils/unzip.js';
import type {
  AddChannelContext,
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import {
  addChannel,
  prepare,
  publish,
  verifyConditions,
} from '../src/index.js';
import * as plugin from '../src/index.js';
// @ts-expect-error semantic-release internals are not typed
import loadPlugins from 'semantic-release/lib/plugins/index.js';

afterEach(() => jest.restoreAllMocks());

describe('plugin entry point', () => {
  it('exports the semantic-release steps, like semantic-release-chrome', () => {
    expect(Object.keys(plugin).sort()).toEqual([
      'addChannel',
      'default',
      'prepare',
      'publish',
      'verifyConditions',
    ]);
    expect(Object.keys(plugin.default).sort()).toEqual([
      'addChannel',
      'prepare',
      'publish',
      'verifyConditions',
    ]);
  });

  it('versions, zips, uploads and publishes in the order semantic-release runs the steps', async () => {
    await withTmp(
      {
        'dist/manifest.json': '{ "name": "Demo", "version": "0.0.0" }',
        'dist/a.js': '1',
      },
      async (dir) => {
        const calls = mockHttp({
          [STATUS]: { json: {} },
          [UPLOAD]: { json: { uploadState: 'SUCCEEDED' } },
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        const { context } = stepContext({ cwd: dir });
        const ctx = context as unknown as PublishContext;
        await plugin.verifyConditions(CONFIG, ctx);
        await plugin.prepare(CONFIG, ctx);
        const release = await plugin.publish(CONFIG, ctx);
        expect(release?.url).toBe(
          'https://chromewebstore.google.com/detail/ext-1',
        );
        const uploaded = calls.find((c) => c.url.endsWith(':upload'))
          ?.body as Uint8Array;
        const entries = unzip(Buffer.from(uploaded));
        expect(JSON.parse(entries['manifest.json'].toString()).version).toBe(
          '1.1.0',
        );
        expect(
          JSON.parse(await readFile(join(dir, 'dist/manifest.json'), 'utf8'))
            .version,
        ).toBe('1.1.0');
      },
    );
  });

  it('is loaded by the real semantic-release plugin loader, addChannel included', async () => {
    const calls = mockHttp({
      [`POST https://chromewebstore.googleapis.com/v2/${ITEM}:setPublishedDeployPercentage`]:
        { json: {} },
    });
    const { context } = stepContext();
    const scope = () => ({
      log() {},
      success() {},
      warn() {},
      error() {},
      scope: () => scope(),
    });
    const logger = scope();
    const steps = await loadPlugins(
      {
        cwd: process.cwd(),
        env: context.env,
        logger,
        options: {
          plugins: [
            [{ ...plugin }, { ...CONFIG, promoteDeployPercentage: 30 }],
          ],
        },
      },
      {},
    );
    expect(typeof steps.addChannel).toBe('function');
    expect(typeof steps.verifyConditions).toBe('function');
    const release = await steps.addChannel({
      cwd: process.cwd(),
      env: context.env,
      options: {},
      branch: { name: 'main' },
      nextRelease: { version: '1.1.0', channel: 'latest' },
      lastRelease: {},
      commits: [],
      logger,
    });
    expect(release).toMatchObject([
      {
        name: 'Chrome Web Store',
        version: '1.1.0',
        url: 'https://chromewebstore.google.com/detail/ext-1',
      },
    ]);
    expect(calls[0].body).toEqual({ deployPercentage: 30 });
  });
});

describe('verifyConditions', () => {
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
        context as unknown as VerifyConditionsContext,
      ),
    };
  };

  const codes = async (promise: Promise<unknown>): Promise<string[]> => {
    const error = await promise.catch((error_: unknown) => error_);
    const list =
      error instanceof AggregateError
        ? (error.errors as Error[])
        : [error as Error];
    return list.map((e) => (e as Error & { code: string }).code);
  };

  describe('verifyConditions', () => {
    it('proves the credentials work by fetching the item status', async () => {
      const calls = mockHttp({
        [STATUS]: {
          json: { publishedItemRevisionStatus: { state: 'PUBLISHED' } },
        },
      });
      const { result, lines } = run({});
      await result;
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.authorization).toBe('Bearer SECRET-TOKEN');
      expect(lines).toContain('Chrome Web Store credentials are valid.');
    });

    it('does nothing for target local, even without credentials', async () => {
      const calls = mockHttp({});
      const { result, lines } = run(
        { target: 'local', extensionId: undefined },
        { env: {} },
      );
      await result;
      expect(calls).toHaveLength(0);
      expect(lines[0]).toMatch(/Skipping verification/);
    });

    it('does nothing on a pre-release branch when prerelease is skip', async () => {
      const calls = mockHttp({});
      const { result } = run(
        { prerelease: 'skip' },
        { env: {}, branch: { name: 'beta', prerelease: 'beta' } },
      );
      await result;
      expect(calls).toHaveLength(0);
    });

    it('rejects a pre-release branch when prerelease is reject', async () => {
      mockHttp({ [STATUS]: { json: {} } });
      const { result } = run(
        { prerelease: 'reject' },
        { branch: { name: 'beta', prerelease: 'beta' } },
      );
      expect(await codes(result)).toEqual(['EPRERELEASE']);
    });

    it('reports every configuration problem at once', async () => {
      mockHttp({});
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
      mockHttp({});
      const { result } = run({}, { env: { GOOGLE_CLIENT_ID: 'id' } });
      expect(await codes(result)).toEqual([
        'EGOOGLECLIENTSECRET',
        'EGOOGLEREFRESHTOKEN',
      ]);
    });

    it('uses the extension id for the current branch', async () => {
      const calls = mockHttp({
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
      const calls = mockHttp({
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
      expect(calls[1].headers.authorization).toBe('Bearer minted');
    });

    it('fails clearly when the store rejects the credentials, without leaking them', async () => {
      mockHttp({
        [STATUS]: {
          status: 401,
          json: { error: { message: 'Invalid Credentials' } },
        },
      });
      const { result } = run({});
      const error = (await result.catch(
        (error_: unknown) => error_,
      )) as Error & {
        code: string;
      };
      expect(error.code).toBe('EWEBSTOREAUTH');
      expect(error.message).not.toContain('SECRET-TOKEN');
    });

    it('warns about a taken down or warned item', async () => {
      mockHttp({
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
});

describe('prepare', () => {
  const files = {
    'dist/manifest.json':
      '{\n  // note\n  "name": "Demo",\n  "version": "0.0.1"\n}\n',
    'dist/background.js': 'console.log(1);',
    'src/manifest.json': '{ "version": "0.0.1" }',
  };

  const run = (
    dir: string,
    config: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const { context, lines } = stepContext({ cwd: dir, ...extra });
    return {
      lines,
      result: prepare(
        { ...CONFIG, ...config },
        context as unknown as PrepareContext,
      ),
    };
  };

  describe('prepare', () => {
    it('versions the dist manifest and zips the dist folder', async () => {
      await withTmp(files, async (dir) => {
        const { result, lines } = run(dir, {});
        await result;
        const manifest = await readFile(
          join(dir, 'dist/manifest.json'),
          'utf8',
        );
        expect(manifest).toContain('// note');
        expect(JSON.parse(manifest.replace('// note', ''))).toMatchObject({
          version: '1.1.0',
        });
        const entries = unzip(await readFile(join(dir, 'ext-v1.1.0.zip')));
        expect(Object.keys(entries).sort()).toEqual([
          'background.js',
          'manifest.json',
        ]);
        expect(entries['manifest.json'].toString()).toContain(
          '"version": "1.1.0"',
        );
        expect(lines.join('\n')).toMatch(/Wrote zipped file with 2 files/);
      });
    });

    it('honours distFolder and manifestPath', async () => {
      await withTmp(
        {
          'build/ext/manifest.json': '{}',
          'build/ext/a.js': '1',
          'build/other.json': '{}',
        },
        async (dir) => {
          await run(dir, {
            distFolder: 'build/ext',
            manifestPath: 'build/ext/manifest.json',
          }).result;
          expect(
            JSON.parse(
              await readFile(join(dir, 'build/ext/manifest.json'), 'utf8'),
            ),
          ).toEqual({
            version: '1.1.0',
          });
        },
      );
    });

    it('also updates the source manifest committed to git (issue 81)', async () => {
      await withTmp(files, async (dir) => {
        await run(dir, { additionalManifests: ['src/manifest.json'] }).result;
        expect(
          JSON.parse(await readFile(join(dir, 'src/manifest.json'), 'utf8')),
        ).toEqual({
          version: '1.1.0',
        });
      });
    });

    it('renders the asset template and zips the manifest it just wrote', async () => {
      await withTmp(files, async (dir) => {
        await run(dir, {
          asset: 'out/${branch.name}-${nextRelease.version}.zip',
        }).result;
        const entries = unzip(await readFile(join(dir, 'out/main-1.1.0.zip')));
        expect(entries['manifest.json'].toString()).toContain('1.1.0');
      });
    });

    it('writes a four part version for a pre-release (issue 111)', async () => {
      await withTmp(files, async (dir) => {
        await run(dir, {}, { nextRelease: { version: '1.2.0-beta.4' } }).result;
        expect(
          JSON.parse(
            (await readFile(join(dir, 'dist/manifest.json'), 'utf8')).replace(
              '// note',
              '',
            ),
          ),
        ).toMatchObject({
          version: '1.2.0.4',
          version_name: '1.2.0-beta.4',
        });
      });
    });

    it('refuses a pre-release when prerelease is reject', async () => {
      await withTmp(files, async (dir) => {
        await expect(
          run(
            dir,
            { prerelease: 'reject' },
            { nextRelease: { version: '1.2.0-beta.4' } },
          ).result,
        ).rejects.toMatchObject({ code: 'EPRERELEASE' });
      });
    });

    it('works with target local', async () => {
      await withTmp(files, async (dir) => {
        await run(dir, { target: 'local' }).result;
        expect(await readFile(join(dir, 'ext-v1.1.0.zip'))).toBeDefined();
      });
    });

    it('requires asset (ENOASSET)', async () => {
      await withTmp(files, async (dir) => {
        await expect(run(dir, { asset: undefined }).result).rejects.toThrow(
          expect.objectContaining({
            errors: [expect.objectContaining({ code: 'ENOASSET' })],
          }),
        );
      });
    });

    it('requires a version from semantic-release', async () => {
      await withTmp(files, async (dir) => {
        await expect(
          run(dir, {}, { nextRelease: undefined }).result,
        ).rejects.toMatchObject({
          code: 'ENOVERSION',
        });
      });
    });

    it('fails when the dist folder or manifest is missing', async () => {
      await withTmp({}, async (dir) => {
        await expect(run(dir, {}).result).rejects.toMatchObject({
          code: 'ENOMANIFEST',
        });
      });
      await withTmp({ 'dist/manifest.json': '{}' }, async (dir) => {
        await expect(
          run(dir, {
            distFolder: 'missing',
            manifestPath: 'dist/manifest.json',
          }).result,
        ).rejects.toMatchObject({
          code: 'ENODISTFOLDER',
        });
      });
    });
  });

  describe('prepare asset template', () => {
    it('supports the other lodash delimiters and every documented variable', async () => {
      await withTmp(files, async (dir) => {
        await run(
          dir,
          {
            asset:
              '<%= lastRelease.version %>-${nextRelease.version}-${commits.length}.zip',
          },
          { lastRelease: { version: '1.0.0' }, commits: [{}, {}] },
        ).result;
        expect(await readFile(join(dir, '1.0.0-1.1.0-2.zip'))).toBeDefined();
      });
    });

    it('writes to an absolute asset path as given', async () => {
      await withTmp(files, async (dir) => {
        await run(dir, { asset: join(dir, 'abs', 'ext.zip') }).result;
        expect(await readFile(join(dir, 'abs', 'ext.zip'))).toBeDefined();
      });
    });

    it('reports EINVALIDASSET when the template cannot be evaluated', async () => {
      await withTmp(files, async (dir) => {
        await expect(
          run(dir, { asset: '${nope.version}.zip' }).result,
        ).rejects.toMatchObject({
          code: 'EINVALIDASSET',
        });
      });
    });
  });
});

describe('publish', () => {
  afterEach(() => jest.restoreAllMocks());

  const mock = (routes: Record<string, unknown>) =>
    mockHttp({ [STATUS]: { json: {} }, ...routes } as never);

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
        context as unknown as PublishContext,
      ),
    };
  };

  const withAsset = (fn: (dir: string) => Promise<void>) =>
    withTmp({ 'ext-v1.1.0.zip': 'PK-fake-zip' }, fn);

  describe('publish', () => {
    it('uploads, then publishes, and returns the release link', async () => {
      await withAsset(async (dir) => {
        const calls = mock({
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        const { result, lines } = run(dir);
        expect(await result).toEqual({
          name: 'Chrome Web Store',
          url: 'https://chromewebstore.google.com/detail/ext-1',
        });
        expect(
          calls.map((c) => c.method + ' ' + c.url.split('/').pop()),
        ).toEqual([
          'GET ext-1:fetchStatus',
          'POST ext-1:upload',
          'POST ext-1:publish',
        ]);
        expect(calls[2].body).toEqual({ publishType: 'DEFAULT_PUBLISH' });
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
          const calls = mock({
            [UPLOAD]: upload,
            [PUBLISH]: { json: { state: 'PUBLISHED' } },
          });
          await expect(run(dir).result).rejects.toBeDefined();
          expect(calls.some((c) => c.url.endsWith(':publish'))).toBe(false);
        }
      });
    });

    it('waits for an asynchronous upload before publishing', async () => {
      await withAsset(async (dir) => {
        const calls = mock({
          [UPLOAD]: { json: { uploadState: 'IN_PROGRESS' } },
          [STATUS]: [
            { json: {} },
            { json: { lastAsyncUploadState: 'IN_PROGRESS' } },
            { json: { lastAsyncUploadState: 'SUCCEEDED' } },
          ],
          [PUBLISH]: { json: { state: 'PUBLISHED' } },
        });
        await run(dir).result;
        expect(calls.map((c) => c.url.split(':').pop())).toEqual([
          'fetchStatus',
          'upload',
          'fetchStatus',
          'fetchStatus',
          'publish',
        ]);
      });
    });

    it('does not publish when the async upload fails or times out', async () => {
      await withAsset(async (dir) => {
        const calls = mock({
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
        mock({
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
        const calls = mock({ [UPLOAD]: OK_UPLOAD });
        const { result, lines } = run(dir, { target: 'draft' });
        expect((await result)?.name).toBe('Chrome Web Store');
        expect(calls).toHaveLength(2);
        expect(lines.join('\n')).toMatch(/skipping publish step/);
      });
    });

    it('does not contact the store for target local (issue 103)', async () => {
      const calls = mock({});
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
        const calls = mock({
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'STAGED' } },
        });
        await run(dir, { target: 'staged' }).result;
        expect(calls[2].body).toEqual({ publishType: 'STAGED_PUBLISH' });
      });
    });

    it('accepts trustedTesters, warns, and publishes as default', async () => {
      await withAsset(async (dir) => {
        const calls = mock({
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PUBLISHED_TO_TESTERS' } },
        });
        const { result, lines } = run(dir, { target: 'trustedTesters' });
        await result;
        expect(calls[2].body).toEqual({ publishType: 'DEFAULT_PUBLISH' });
        expect(lines.join('\n')).toMatch(/Distribution settings/);
      });
    });

    it('sends rollout percentage and skipReview', async () => {
      await withAsset(async (dir) => {
        const calls = mock({
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        await run(dir, { deployPercentage: 10, skipReview: true }).result;
        expect(calls[2].body).toEqual({
          publishType: 'DEFAULT_PUBLISH',
          deployInfos: [{ deployPercentage: 10 }],
          skipReview: true,
        });
      });
    });

    it('logs the friction warning but does not fail (issue 46)', async () => {
      await withAsset(async (dir) => {
        mock({
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
        mock(reply);
        const { result, lines } = run(dir);
        await result;
        expect(lines.join('\n')).toContain('BROAD_HOSTS: broad');
      });
      await withAsset(async (dir) => {
        mock(reply);
        await expect(
          run(dir, { failOnWarnings: true }).result,
        ).rejects.toMatchObject({
          errors: [expect.objectContaining({ code: 'BROAD_HOSTS' })],
        });
      });
    });

    it('lets the whitelist be changed', async () => {
      await withAsset(async (dir) => {
        mock({
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
        mock({ [UPLOAD]: OK_UPLOAD, [PUBLISH]: { json: {} } });
        await expect(run(dir).result).rejects.toMatchObject({
          code: 'EPUBLISHSTATE',
        });
      });
    });

    it('fails when the submission is rejected or cancelled', async () => {
      await withAsset(async (dir) => {
        for (const state of [
          'REJECTED',
          'CANCELLED',
          'ITEM_STATE_UNSPECIFIED',
        ]) {
          mock({ [UPLOAD]: OK_UPLOAD, [PUBLISH]: { json: { state } } });
          await expect(run(dir).result).rejects.toMatchObject({
            code: 'EPUBLISHSTATE',
          });
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
          mock({ [UPLOAD]: OK_UPLOAD, [PUBLISH]: { json: { state } } });
          expect((await run(dir).result)?.url).toContain('ext-1');
        }
      });
    });

    it('surfaces the store error when publishing is refused (issues 7, 69)', async () => {
      await withAsset(async (dir) => {
        mock({
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
        const calls = mock({
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
        const calls = mock({
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
      mock({});
      const { result } = run(
        '/nowhere',
        { extensionId: undefined, publisherId: undefined, asset: undefined },
        { env: {} },
      );
      const error = (await result.catch(
        (error_: unknown) => error_,
      )) as AggregateError;
      expect(
        error.errors.map((e: Error & { code?: string }) => e.code),
      ).toEqual(['ENOASSET', 'ENOEXTENSIONID', 'ENOPUBLISHERID']);
    });

    it('fails with ENOASSETFILE when prepare has not produced the zip', async () => {
      await withTmp({}, async (dir) => {
        mock({});
        await expect(run(dir).result).rejects.toMatchObject({
          code: 'ENOASSETFILE',
        });
      });
    });

    it('fails when there are no credentials', async () => {
      await withAsset(async (dir) => {
        mock({});
        await expect(run(dir, {}, { env: {} }).result).rejects.toMatchObject({
          code: 'ENOCREDENTIALS',
        });
      });
    });

    it('never writes the token to the log or into an error', async () => {
      await withAsset(async (dir) => {
        mock({
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { status: 403, json: { error: { message: 'denied' } } },
        });
        const { result, lines } = run(dir);
        const error = (await result.catch(
          (error_: unknown) => error_,
        )) as Error;
        expect(error.message).not.toContain('SECRET-TOKEN');
        expect(lines.join('\n')).not.toContain('SECRET-TOKEN');
      });
    });

    it('reads the zip the asset template points at', async () => {
      await withTmp({}, async (dir) => {
        await writeFile(join(dir, 'chrome-main.zip'), 'zip');
        mock({
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
        const calls = mock({
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        await run(dir, config).result;
        sent = calls[2].body;
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

  describe('publish cancelPendingSubmission', () => {
    const PENDING = {
      json: { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } },
    };
    const CANCEL = `POST ${BASE}/v2/${ITEM}:cancelSubmission`;
    const ops = (calls: { url: string }[]) =>
      calls.map((c) => c.url.split(':').pop());

    it('cancels exactly once, before the upload, when a submission is pending', async () => {
      await withAsset(async (dir) => {
        const calls = mockHttp({
          [STATUS]: PENDING,
          [CANCEL]: { json: {} },
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        const { result, lines } = run(dir, { cancelPendingSubmission: true });
        await result;
        expect(ops(calls)).toEqual([
          'fetchStatus',
          'cancelSubmission',
          'upload',
          'publish',
        ]);
        expect(lines.join('\n')).toMatch(/Cancelling/);
      });
    });

    it('keeps the individual warning errors when a pending submission is left in place', async () => {
      await withAsset(async (dir) => {
        mockHttp({
          [STATUS]: PENDING,
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: {
            json: {
              state: 'PENDING_REVIEW',
              warningInfo: {
                warnings: [{ reason: 'BROAD_HOSTS', description: 'broad' }],
              },
            },
          },
        });
        const error = (await run(dir, { failOnWarnings: true }).result.catch(
          (error_: unknown) => error_,
        )) as AggregateError;
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toEqual([
          expect.objectContaining({ code: 'BROAD_HOSTS', message: 'broad' }),
        ]);
      });
    });

    it('does not cancel when nothing is pending', async () => {
      await withAsset(async (dir) => {
        const calls = mockHttp({
          [STATUS]: {
            json: { submittedItemRevisionStatus: { state: 'PUBLISHED' } },
          },
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        await run(dir, { cancelPendingSubmission: true }).result;
        expect(ops(calls)).toEqual(['fetchStatus', 'upload', 'publish']);
      });
    });

    it('only warns when the option is off', async () => {
      await withAsset(async (dir) => {
        const calls = mockHttp({
          [STATUS]: PENDING,
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        const { result, lines } = run(dir);
        await result;
        expect(ops(calls)).toEqual(['fetchStatus', 'upload', 'publish']);
        expect(lines.join('\n')).toMatch(
          /still pending review.*cancelPendingSubmission/,
        );
      });
    });

    it('adds a hint to a refusal when a pending submission was left in place', async () => {
      await withAsset(async (dir) => {
        mockHttp({
          [STATUS]: PENDING,
          [UPLOAD]: {
            status: 400,
            json: { error: { message: 'item is under review' } },
          },
        });
        await expect(run(dir).result).rejects.toMatchObject({
          code: 'EWEBSTOREBADREQUEST',
          message: expect.stringContaining(
            'set cancelPendingSubmission to true',
          ),
        });
      });
    });

    it('adds the same hint when the publish call is refused', async () => {
      await withAsset(async (dir) => {
        mockHttp({
          [STATUS]: PENDING,
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { status: 400, json: { error: { message: 'busy' } } },
        });
        await expect(run(dir).result).rejects.toMatchObject({
          message: expect.stringContaining('cancelPendingSubmission'),
        });
      });
    });

    it('uploads nothing and publishes nothing when the cancel fails', async () => {
      await withAsset(async (dir) => {
        const calls = mockHttp({
          [STATUS]: PENDING,
          [CANCEL]: {
            status: 400,
            json: { error: { message: 'nothing to cancel' } },
          },
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PUBLISHED' } },
        });
        await expect(
          run(dir, { cancelPendingSubmission: true }).result,
        ).rejects.toMatchObject({
          code: 'EWEBSTOREBADREQUEST',
          message: expect.stringContaining('active submission'),
        });
        expect(ops(calls)).toEqual(['fetchStatus', 'cancelSubmission']);
      });
    });

    it('stops when the status check fails and cancelling was requested', async () => {
      await withAsset(async (dir) => {
        const calls = mockHttp({
          [STATUS]: { status: 403, json: { error: { message: 'no' } } },
        });
        await expect(
          run(dir, { cancelPendingSubmission: true }).result,
        ).rejects.toMatchObject({
          code: 'EWEBSTOREPERMISSION',
        });
        expect(calls.some((c) => c.url.endsWith(':upload'))).toBe(false);
      });
    });

    it('carries on with a warning when the status check fails and cancelling was not requested', async () => {
      await withAsset(async (dir) => {
        mockHttp({
          [STATUS]: { status: 403, json: { error: { message: 'no' } } },
          [UPLOAD]: OK_UPLOAD,
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        const { result, lines } = run(dir);
        expect((await result)?.name).toBe('Chrome Web Store');
        expect(lines.join('\n')).toMatch(
          /Could not check for a pending submission/,
        );
      });
    });

    it('never looks for a pending submission for target local', async () => {
      const calls = mockHttp({});
      await run('/nowhere', { target: 'local', cancelPendingSubmission: true })
        .result;
      expect(calls).toHaveLength(0);
    });
  });

  describe('publish asset template', () => {
    it('reports EINVALIDASSET when the template cannot be evaluated', async () => {
      mockHttp({});
      await expect(
        run('/nowhere', { asset: '${nope.version}.zip' }).result,
      ).rejects.toMatchObject({
        code: 'EINVALIDASSET',
      });
    });
  });
});

describe('addChannel', () => {
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
        context as unknown as AddChannelContext,
      ),
    };
  };

  describe('addChannel', () => {
    it('does nothing unless promoteDeployPercentage is set', async () => {
      const calls = mockHttp({});
      expect(await run({}).result).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it('does nothing for target local', async () => {
      const calls = mockHttp({});
      expect(
        await run({ promoteDeployPercentage: 50, target: 'local' }).result,
      ).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it('raises the published rollout and returns the release link', async () => {
      const calls = mockHttp({ [PROMOTE]: { json: {} } });
      const { result, lines } = run({ promoteDeployPercentage: 50 });
      expect(await result).toEqual({
        name: 'Chrome Web Store',
        url: 'https://chromewebstore.google.com/detail/ext-1',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ deployPercentage: 50 });
      expect(calls[0].headers.authorization).toBe('Bearer SECRET-TOKEN');
      expect(lines.join('\n')).not.toContain('SECRET-TOKEN');
    });

    it('accepts 0 and 100', async () => {
      mockHttp({ [PROMOTE]: { json: {} } });
      await run({ promoteDeployPercentage: 0 }).result;
      await run({ promoteDeployPercentage: 100 }).result;
    });

    it('rejects an invalid percentage with the deployPercentage code', async () => {
      mockHttp({});
      for (const value of [101, -1, 2.5]) {
        const error = (await run({
          promoteDeployPercentage: value,
        }).result.catch((error_: unknown) => error_)) as AggregateError;
        expect(error.errors[0]).toMatchObject({
          code: 'EINVALIDDEPLOYPERCENTAGE',
        });
      }
    });

    it('reports missing options and credentials', async () => {
      mockHttp({});
      const missing = (await run(
        {
          promoteDeployPercentage: 5,
          extensionId: undefined,
          publisherId: undefined,
        },
        { env: {} },
      ).result.catch((error: unknown) => error)) as AggregateError;
      expect(
        missing.errors.map((e: Error & { code?: string }) => e.code),
      ).toEqual(['ENOEXTENSIONID', 'ENOPUBLISHERID']);
      await expect(
        run({ promoteDeployPercentage: 5 }, { env: {} }).result,
      ).rejects.toMatchObject({ code: 'ENOCREDENTIALS' });
    });

    it('surfaces the store refusal with the preconditions', async () => {
      mockHttp({
        [PROMOTE]: {
          status: 400,
          json: { error: { message: 'percentage must be larger' } },
        },
      });
      await expect(
        run({ promoteDeployPercentage: 5 }).result,
      ).rejects.toMatchObject({
        code: 'EWEBSTOREBADREQUEST',
        message: expect.stringMatching(
          /larger than the current target.*10,000/,
        ),
      });
    });

    it('maps a permission failure', async () => {
      mockHttp({
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
        const calls = mockHttp({ [PROMOTE]: { json: {} } });
        await run(
          {
            promoteDeployPercentage: 5,
            pollIntervalMs: undefined,
            pollTimeoutMs: undefined,
          },
          { env: undefined },
        ).result;
        expect(calls[0].headers.authorization).toBe('Bearer ENV-TOKEN');
      } finally {
        process.env = saved;
      }
    });
  });
});
