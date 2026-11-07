import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// noinspection ES6PreferShortImport
import * as plugin from '../src/index.js';
import { mockFetch } from './utils/fetch-mock.js';
import {
  CONFIG,
  PUBLISH,
  STATUS,
  UPLOAD,
  stepContext,
} from './utils/context.js';
import { withTmp } from './utils/tmpdir.js';
import { unzip } from './utils/unzip.js';
import type { StepContext } from '../src/plugin-config.js';

afterEach(() => jest.restoreAllMocks());

describe('plugin entry point', () => {
  it('exports the three semantic-release steps, like semantic-release-chrome', () => {
    expect(Object.keys(plugin).sort()).toEqual([
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
});
