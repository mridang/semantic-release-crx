import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// noinspection ES6PreferShortImport
import { writeManifestVersion } from '../src/manifest.js';
import { toManifestVersion } from '../src/version.js';
import { withTmp } from './utils/tmpdir.js';

const noop = (): void => {};

describe('writeManifestVersion', () => {
  it('writes the version into a plain manifest', async () => {
    await withTmp(
      { 'manifest.json': '{\n  "version": "0.0.1"\n}\n' },
      async (dir) => {
        const path = join(dir, 'manifest.json');
        await writeManifestVersion(
          path,
          toManifestVersion('1.4.0'),
          '1.4.0',
          noop,
        );
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
          version: '1.4.0',
        });
      },
    );
  });

  it('works when the manifest contains comments and keeps them (issue 115)', async () => {
    const source = `{
  // Needs <all_urls> because the content script runs everywhere
  "name": "Demo", /* shown in the store */
  "version": "0.0.1",
  "permissions": ["tabs",],
}
`;
    await withTmp({ 'manifest.json': source }, async (dir) => {
      const path = join(dir, 'manifest.json');
      await writeManifestVersion(
        path,
        toManifestVersion('2.0.0'),
        '2.0.0',
        noop,
      );
      expect(await readFile(path, 'utf8')).toBe(
        source.replace('"0.0.1"', '"2.0.0"'),
      );
    });
  });

  it('adds version when the manifest has none', async () => {
    await withTmp({ 'manifest.json': '{"name": "Demo"}' }, async (dir) => {
      const path = join(dir, 'manifest.json');
      await writeManifestVersion(
        path,
        toManifestVersion('1.0.0'),
        '1.0.0',
        noop,
      );
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        version: '1.0.0',
        name: 'Demo',
      });
    });
  });

  it('writes version_name for a pre-release (issue 111)', async () => {
    await withTmp({ 'manifest.json': '{"version": "1.0.0"}' }, async (dir) => {
      const path = join(dir, 'manifest.json');
      await writeManifestVersion(
        path,
        toManifestVersion('1.1.0-beta.3'),
        '1.1.0-beta.3',
        noop,
      );
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        version: '1.1.0.3',
        version_name: '1.1.0-beta.3',
      });
    });
  });

  it('refreshes a stale version_name on a stable release', async () => {
    await withTmp(
      {
        'manifest.json':
          '{"version": "1.1.0.3", "version_name": "1.1.0-beta.3"}',
      },
      async (dir) => {
        const path = join(dir, 'manifest.json');
        await writeManifestVersion(
          path,
          toManifestVersion('1.1.0'),
          '1.1.0',
          noop,
        );
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
          version: '1.1.0',
          version_name: '1.1.0',
        });
      },
    );
  });

  it('tells the log what it wrote', async () => {
    await withTmp({ 'manifest.json': '{}' }, async (dir) => {
      const lines: string[] = [];
      const path = join(dir, 'manifest.json');
      await writeManifestVersion(
        path,
        toManifestVersion('1.0.0'),
        '1.0.0',
        (m) => lines.push(m),
      );
      expect(lines).toEqual([`Wrote version 1.0.0 to ${path}`]);
    });
  });

  it('fails with ENOMANIFEST when the file is missing', async () => {
    await withTmp({}, async (dir) => {
      await expect(
        writeManifestVersion(
          join(dir, 'manifest.json'),
          toManifestVersion('1.0.0'),
          '1.0.0',
          noop,
        ),
      ).rejects.toMatchObject({ code: 'ENOMANIFEST' });
    });
  });

  it('fails with EINVALIDMANIFEST for broken JSON and non objects', async () => {
    await withTmp({ 'a.json': '{"a": ', 'b.json': '[]' }, async (dir) => {
      await expect(
        writeManifestVersion(
          join(dir, 'a.json'),
          toManifestVersion('1.0.0'),
          '1.0.0',
          noop,
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDMANIFEST' });
      await expect(
        writeManifestVersion(
          join(dir, 'b.json'),
          toManifestVersion('1.0.0'),
          '1.0.0',
          noop,
        ),
      ).rejects.toMatchObject({ code: 'EINVALIDMANIFEST' });
    });
  });
});
