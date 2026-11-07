import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// noinspection ES6PreferShortImport
import * as plugin from '../src/index.js';
import { mockFetch } from './utils/fetch-mock.js';
import {
  CONFIG,
  ITEM,
  PUBLISH,
  STATUS,
  UPLOAD,
  stepContext,
} from './utils/context.js';
// @ts-expect-error semantic-release internals are not typed
import loadPlugins from 'semantic-release/lib/plugins/index.js';
import { withTmp } from './utils/tmpdir.js';
import { unzip } from './utils/unzip.js';
import type { StepContext } from '../src/plugin-config.js';

afterEach(() => jest.restoreAllMocks());

describe('plugin entry point', () => {
  it('exports the semantic-release steps, like semantic-release-chrome', () => {
    expect(Object.keys(plugin).sort()).toEqual([
      'addChannel',
      'prepare',
      'publish',
      'verifyConditions',
    ]);
    expect(
      Object.values(plugin).every((step) => typeof step === 'function'),
    ).toBe(true);
  });

  it('versions, zips, uploads and publishes in the order semantic-release runs the steps', async () => {
    await withTmp(
      {
        'dist/manifest.json': '{ "name": "Demo", "version": "0.0.0" }',
        'dist/a.js': '1',
      },
      async (dir) => {
        const calls = mockFetch({
          [STATUS]: { json: {} },
          [UPLOAD]: { json: { uploadState: 'SUCCEEDED' } },
          [PUBLISH]: { json: { state: 'PENDING_REVIEW' } },
        });
        const { context } = stepContext({ cwd: dir });
        const ctx = context as unknown as StepContext;
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
    const calls = mockFetch({
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
