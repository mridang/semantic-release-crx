import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// noinspection ES6PreferShortImport
import { prepare } from '../src/prepare.js';
import { CONFIG, stepContext } from './utils/context.js';
import { withTmp } from './utils/tmpdir.js';
import { unzip } from './utils/unzip.js';
import type { StepContext } from '../src/plugin-config.js';

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
      context as unknown as StepContext,
    ),
  };
};

describe('prepare', () => {
  it('versions the dist manifest and zips the dist folder', async () => {
    await withTmp(files, async (dir) => {
      const { result, lines } = run(dir, {});
      await result;
      const manifest = await readFile(join(dir, 'dist/manifest.json'), 'utf8');
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
      await run(dir, { asset: 'out/${branch.name}-${nextRelease.version}.zip' })
        .result;
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
        run(dir, { distFolder: 'missing', manifestPath: 'dist/manifest.json' })
          .result,
      ).rejects.toMatchObject({
        code: 'ENODISTFOLDER',
      });
    });
  });
});
