import { readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { Extension } from '../src/extension.js';
import { isRecord } from '../src/utils/object.js';
import { loadFixture } from './utils/fixtures.js';
import { withTmp } from './utils/tmpdir.js';
import { unzip } from './utils/unzip.js';

/** Locale-aware comparer, built once. */
const collator = new Intl.Collator();
const BARE_LINE_FEED = /[^\r]\n/u;
const WROTE_VERSION_1_0_0 = /^Wrote version 1\.0\.0 to /u;
const WROTE_RC_VERSION =
  /^Wrote version 1\.0\.0\.2 \(version_name 1\.0\.0-rc\.2\) to /u;

const versions = await loadFixture('manifest-versions.json');

const noop = (): void => {};

const versioned = async (
  source: string,
  semver: string,
  lines: string[] = [],
): Promise<string> =>
  withTmp({ 'manifest.json': source }, async (dir) => {
    const manifestPath = path.join(dir, 'manifest.json');
    await Extension.at(dir, [manifestPath]).setVersion(semver, (m) =>
      lines.push(m),
    );
    return readFile(manifestPath, 'utf8');
  });

describe('Extension.setVersion', () => {
  it('writes the version into a plain manifest', async () => {
    expect(
      JSON.parse(await versioned('{\n  "version": "0.0.1"\n}\n', '1.4.0')),
    ).toEqual({
      version: '1.4.0',
    });
  });

  it('works when the manifest contains comments and keeps them (issue 115)', async () => {
    const source = `{
  // Needs <all_urls> because the content script runs everywhere
  "name": "Demo", /* shown in the store */
  "version": "0.0.1",
  "permissions": ["tabs",],
}
`;
    expect(await versioned(source, '2.0.0')).toBe(
      source.replace('"0.0.1"', '"2.0.0"'),
    );
  });

  it('does not touch a nested member with the same name', async () => {
    const out = await versioned(
      '{"a": {"version": "nested"}, "version": "1"}',
      '2.0.0',
    );
    expect(JSON.parse(out)).toEqual({
      a: { version: 'nested' },
      version: '2.0.0',
    });
  });

  it('adds version when the manifest has none', async () => {
    expect(JSON.parse(await versioned('{"name": "Demo"}', '1.0.0'))).toEqual({
      name: 'Demo',
      version: '1.0.0',
    });
    expect(JSON.parse(await versioned('{}', '1.0.0'))).toEqual({
      version: '1.0.0',
    });
  });

  it('uses CRLF line endings when the file does', async () => {
    const out = await versioned('{\r\n  "name": "x"\r\n}\r\n', '1.0.0');
    expect(JSON.parse(out)).toEqual({ name: 'x', version: '1.0.0' });
    expect(out).not.toMatch(BARE_LINE_FEED);
  });

  it('writes version_name for a pre-release (issue 111)', async () => {
    expect(
      JSON.parse(await versioned('{"version": "1.0.0"}', '1.1.0-beta.3')),
    ).toEqual({
      version: versions.beta3,
      version_name: '1.1.0-beta.3',
    });
  });

  it('refreshes a stale version_name on a stable release', async () => {
    const out = await versioned(
      '{"version": "1.1.0.3", "version_name": "1.1.0-beta.3"}',
      '1.1.0',
    );
    expect(JSON.parse(out)).toEqual({
      version: '1.1.0',
      version_name: '1.1.0',
    });
  });

  it('copes with a 1 MB manifest', async () => {
    const big = JSON.stringify({
      list: Array.from({ length: 150_000 }, (_, index) => index),
      version: '1.0.0',
    });
    expect(big.length).toBeGreaterThan(900_000);
    expect(JSON.parse(await versioned(big, '2.0.0'))).toMatchObject({
      version: '2.0.0',
    });
  });

  it('tells the log what it wrote', async () => {
    const lines: string[] = [];
    await versioned('{}', '1.0.0', lines);
    await versioned('{}', '1.0.0-rc.2', lines);
    expect(lines[0]).toMatch(WROTE_VERSION_1_0_0);
    expect(lines[1]).toMatch(WROTE_RC_VERSION);
  });

  it('updates every manifest, in order (issue 81)', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'src/manifest.json': '{"version": "0"}' },
      async (dir) => {
        const paths = [
          path.join(dir, 'dist/manifest.json'),
          path.join(dir, 'src/manifest.json'),
        ];
        await Extension.at(path.join(dir, 'dist'), paths).setVersion(
          '3.0.0',
          noop,
        );
        for (const manifest of paths) {
          expect(JSON.parse(await readFile(manifest, 'utf8'))).toMatchObject({
            version: '3.0.0',
          });
        }
      },
    );
  });

  it('fails with ENOMANIFEST when the file is missing', async () => {
    await withTmp({}, async (dir) => {
      await expect(
        Extension.at(dir, [path.join(dir, 'manifest.json')]).setVersion(
          '1.0.0',
          noop,
        ),
      ).rejects.toMatchObject({ code: 'ENOMANIFEST' });
    });
  });

  it('fails with EINVALIDMANIFEST for broken JSON and non objects', async () => {
    await withTmp({ 'a.json': '{"a": ', 'b.json': '[]' }, async (dir) => {
      for (const name of ['a.json', 'b.json']) {
        await expect(
          Extension.at(dir, [path.join(dir, name)]).setVersion('1.0.0', noop),
        ).rejects.toMatchObject({ code: 'EINVALIDMANIFEST' });
      }
    });
  });

  it('rejects a version Chrome cannot use before touching any file', async () => {
    await withTmp({ 'manifest.json': '{"version":"1"}' }, async (dir) => {
      const manifestPath = path.join(dir, 'manifest.json');
      await expect(
        Extension.at(dir, [manifestPath]).setVersion('nope', noop),
      ).rejects.toMatchObject({
        code: 'EINVALIDVERSION',
      });
      expect(await readFile(manifestPath, 'utf8')).toBe('{"version":"1"}');
    });
  });
});

describe('Extension.zip', () => {
  it('puts the folder contents at the archive root with intact data', async () => {
    const files = {
      'dist/manifest.json': '{"version":"1.0.0"}',
      'dist/js/app.js': 'console.log("hi");\n'.repeat(200),
      'dist/img/ü.png': Buffer.from([0, 1, 2, 3]),
    };
    await withTmp(files, async (dir) => {
      const out = path.join(dir, 'out', 'ext.zip');
      const count = await Extension.at(path.join(dir, 'dist'), []).zip(out);
      const entries = await unzip(await readFile(out));
      expect(count).toBe(3);
      expect(
        Object.keys(entries).toSorted((a, b) => collator.compare(a, b)),
      ).toEqual(['img/ü.png', 'js/app.js', 'manifest.json']);
      expect(entries['js/app.js'].toString()).toBe(files['dist/js/app.js']);
      expect([...entries['img/ü.png']]).toEqual([0, 1, 2, 3]);
    });
  });

  it('is accepted by an independent zip tool', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'dist/a/b.txt': 'x'.repeat(5000) },
      async (dir) => {
        const out = path.join(dir, 'ext.zip');
        await Extension.at(path.join(dir, 'dist'), []).zip(out);
        // A spawn failure (no unzip binary) is a string code and skips the check.
        const status = await promisify(execFile)('/usr/bin/unzip', ['-tq', out])
          .then(() => 0)
          .catch((error: unknown) =>
            isRecord(error) && typeof error.code !== 'string'
              ? error.code
              : undefined,
          );
        if (status !== undefined) {
          expect(status).toBe(0);
        }
      },
    );
  });

  it('never includes the archive itself when written inside the folder (issue 89)', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'dist/a.js': '1' },
      async (dir) => {
        const out = path.join(dir, 'dist', 'asset.zip');
        const extension = Extension.at(path.join(dir, 'dist'), []);
        await extension.zip(out);
        await extension.zip(out);
        expect(
          Object.keys(await unzip(await readFile(out))).toSorted((a, b) =>
            collator.compare(a, b),
          ),
        ).toEqual(['a.js', 'manifest.json']);
      },
    );
  });

  it('has finished writing when it resolves (issue 89)', async () => {
    await withTmp(
      {
        'dist/manifest.json': '{}',
        'dist/big.bin': Buffer.alloc(3_000_000, 7),
      },
      async (dir) => {
        const out = path.join(dir, 'asset.zip');
        await Extension.at(path.join(dir, 'dist'), []).zip(out);
        const entries = await unzip(await readFile(out));
        expect(entries['big.bin']).toHaveLength(3_000_000);
      },
    );
  });

  it('produces identical bytes for identical input', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'dist/a.js': 'abc' },
      async (dir) => {
        const extension = Extension.at(path.join(dir, 'dist'), []);
        await extension.zip(path.join(dir, '1.zip'));
        await extension.zip(path.join(dir, '2.zip'));
        const first = await readFile(path.join(dir, '1.zip'));
        const second = await readFile(path.join(dir, '2.zip'));
        expect(first.equals(second)).toBe(true);
      },
    );
  });

  it('archives many files in sorted order', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `dist/f${String(index).padStart(3, '0')}.txt`,
        `file ${index}`,
      ]),
    );
    await withTmp({ ...files, 'dist/manifest.json': '{}' }, async (dir) => {
      const out = path.join(dir, 'a.zip');
      expect(await Extension.at(path.join(dir, 'dist'), []).zip(out)).toBe(101);
      const entries = await unzip(await readFile(out));
      expect(Object.keys(entries)).toEqual(
        Object.keys(entries).toSorted((a, b) => collator.compare(a, b)),
      );
      expect(entries['f042.txt'].toString()).toBe('file 42');
    });
  });

  it('follows symlinks to files', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'real.txt': 'linked' },
      async (dir) => {
        await symlink(
          path.join(dir, 'real.txt'),
          path.join(dir, 'dist', 'link.txt'),
        );
        const out = path.join(dir, 'asset.zip');
        await Extension.at(path.join(dir, 'dist'), []).zip(out);
        const entries = await unzip(await readFile(out));
        expect(
          Object.keys(entries).toSorted((a, b) => collator.compare(a, b)),
        ).toEqual(['link.txt', 'manifest.json']);
        expect(entries['link.txt'].toString()).toBe('linked');
      },
    );
  });

  it('refuses a symlink to a folder rather than leaving its files out', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'assets/a.png': 'x' },
      async (dir) => {
        await symlink(
          path.join(dir, 'assets'),
          path.join(dir, 'dist', 'assets'),
        );
        await expect(
          Extension.at(path.join(dir, 'dist'), []).zip(path.join(dir, 'a.zip')),
        ).rejects.toMatchObject({
          code: 'ESYMLINKDIR',
          message: expect.stringContaining('assets'),
        });
      },
    );
  });

  it('refuses a symlink loop', async () => {
    await withTmp({ 'dist/manifest.json': '{}' }, async (dir) => {
      await symlink(path.join(dir, 'dist'), path.join(dir, 'dist', 'loop'));
      await expect(
        Extension.at(path.join(dir, 'dist'), []).zip(path.join(dir, 'a.zip')),
      ).rejects.toMatchObject({ code: 'ESYMLINKDIR' });
    });
  });

  it('produces the same bytes in every timezone and does not fail west of UTC', async () => {
    const saved = process.env.TZ;
    try {
      await withTmp(
        { 'dist/manifest.json': '{}', 'dist/a.js': 'abc' },
        async (dir) => {
          const zips = await Promise.all(
            ['UTC', 'Australia/Sydney', 'America/Los_Angeles'].map(
              async (tz, index) => {
                process.env.TZ = tz;
                const out = path.join(dir, `${index}.zip`);
                await Extension.at(path.join(dir, 'dist'), []).zip(out);
                return readFile(out);
              },
            ),
          );
          expect(zips[1].equals(zips[0])).toBe(true);
          expect(zips[2].equals(zips[0])).toBe(true);
        },
      );
    } finally {
      if (saved === undefined) {
        delete process.env.TZ;
      } else {
        // eslint-disable-next-line require-atomic-updates -- restores the variable after the awaited work
        process.env.TZ = saved;
      }
    }
  });

  it('fails with a coded error naming a broken symlink', async () => {
    await withTmp({ 'dist/manifest.json': '{}' }, async (dir) => {
      await symlink(
        path.join(dir, 'missing.txt'),
        path.join(dir, 'dist', 'dangling.txt'),
      );
      await expect(
        Extension.at(path.join(dir, 'dist'), []).zip(path.join(dir, 'a.zip')),
      ).rejects.toMatchObject({
        code: 'EBROKENSYMLINK',
        message: expect.stringContaining('dangling.txt'),
      });
    });
  });

  it('fails with ENODISTFOLDER when the folder is missing or empty', async () => {
    await withTmp({ 'dist/sub/.keep': '' }, async (dir) => {
      await expect(
        Extension.at(path.join(dir, 'nope'), []).zip(path.join(dir, 'a.zip')),
      ).rejects.toMatchObject({
        code: 'ENODISTFOLDER',
      });
      await expect(
        Extension.at(path.join(dir, 'dist'), []).zip(
          path.join(dir, 'dist', 'sub', '.keep'),
        ),
      ).rejects.toMatchObject({ code: 'ENODISTFOLDER' });
    });
  });
});
