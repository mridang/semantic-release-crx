import { describe, expect, it } from '@jest/globals';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// noinspection ES6PreferShortImport
import { zipFolder } from '../src/zip.js';
import { withTmp } from './utils/tmpdir.js';
import { unzip } from './utils/unzip.js';

describe('zipFolder', () => {
  it('puts the folder contents at the archive root with intact data', async () => {
    const files = {
      'dist/manifest.json': '{"version":"1.0.0"}',
      'dist/js/app.js': 'console.log("hi");\n'.repeat(200),
      'dist/img/ü.png': Buffer.from([0, 1, 2, 3]),
    };
    await withTmp(files, async (dir) => {
      const out = join(dir, 'out', 'ext.zip');
      const count = await zipFolder(join(dir, 'dist'), out);
      const entries = unzip(await readFile(out));
      expect(count).toBe(3);
      expect(Object.keys(entries).sort()).toEqual([
        'img/ü.png',
        'js/app.js',
        'manifest.json',
      ]);
      expect(entries['manifest.json'].toString()).toBe('{"version":"1.0.0"}');
      expect(entries['js/app.js'].toString()).toBe(files['dist/js/app.js']);
      expect([...entries['img/ü.png']]).toEqual([0, 1, 2, 3]);
    });
  });

  it('is accepted by an independent zip tool', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'dist/a/b.txt': 'x'.repeat(5000) },
      async (dir) => {
        const out = join(dir, 'ext.zip');
        await zipFolder(join(dir, 'dist'), out);
        const check = spawnSync('unzip', ['-tq', out]);
        if (check.error) {
          return;
        }
        expect(check.status).toBe(0);
      },
    );
  });

  it('never includes the archive itself when it is written inside the folder (issue 89)', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'dist/a.js': '1' },
      async (dir) => {
        const out = join(dir, 'dist', 'asset.zip');
        await zipFolder(join(dir, 'dist'), out);
        await zipFolder(join(dir, 'dist'), out);
        expect(Object.keys(unzip(await readFile(out))).sort()).toEqual([
          'a.js',
          'manifest.json',
        ]);
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
        const out = join(dir, 'asset.zip');
        await zipFolder(join(dir, 'dist'), out);
        expect(unzip(await readFile(out))['big.bin']).toHaveLength(3_000_000);
      },
    );
  });

  it('produces identical bytes for identical input', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'dist/a.js': 'abc' },
      async (dir) => {
        await zipFolder(join(dir, 'dist'), join(dir, '1.zip'));
        await zipFolder(join(dir, 'dist'), join(dir, '2.zip'));
        expect(
          (await readFile(join(dir, '1.zip'))).equals(
            await readFile(join(dir, '2.zip')),
          ),
        ).toBe(true);
      },
    );
  });

  it('follows symlinks to files but not to folders', async () => {
    await withTmp(
      { 'dist/manifest.json': '{}', 'real.txt': 'linked' },
      async (dir) => {
        await symlink(join(dir, 'real.txt'), join(dir, 'dist', 'link.txt'));
        await symlink(join(dir, 'dist'), join(dir, 'dist', 'loop'));
        const out = join(dir, 'asset.zip');
        await zipFolder(join(dir, 'dist'), out);
        const entries = unzip(await readFile(out));
        expect(Object.keys(entries).sort()).toEqual([
          'link.txt',
          'manifest.json',
        ]);
        expect(entries['link.txt'].toString()).toBe('linked');
      },
    );
  });

  it('fails with ENODISTFOLDER when the folder is missing', async () => {
    await withTmp({}, async (dir) => {
      await expect(
        zipFolder(join(dir, 'dist'), join(dir, 'a.zip')),
      ).rejects.toMatchObject({
        code: 'ENODISTFOLDER',
      });
    });
  });

  it('fails with ENODISTFOLDER when the folder is empty', async () => {
    await withTmp({ 'dist/sub/.keep': '' }, async (dir) => {
      await expect(
        zipFolder(join(dir, 'dist'), join(dir, 'dist', 'sub', '.keep')),
      ).rejects.toMatchObject({ code: 'ENODISTFOLDER' });
    });
  });
});
