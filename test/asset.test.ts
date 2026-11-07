import { describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
// noinspection ES6PreferShortImport
import { resolveAsset } from '../src/asset.js';
import { recordingLogger } from './utils/logger.js';

const context = {
  cwd: '/work',
  logger: recordingLogger().logger,
  branch: { name: 'main' },
  lastRelease: { version: '1.0.0' },
  nextRelease: { version: '1.1.0' },
  commits: [{ hash: 'a' }, { hash: 'b' }],
};

describe('resolveAsset', () => {
  it('expands the lodash ES template variables', () => {
    expect(
      resolveAsset('ext_v${nextRelease.version}_${branch.name}.zip', context),
    ).toBe('/work/ext_v1.1.0_main.zip');
  });

  it('supports the other lodash delimiters and every documented variable', () => {
    expect(
      resolveAsset(
        '<%= lastRelease.version %>-${nextRelease.version}-${commits.length}.zip',
        context,
      ),
    ).toBe('/work/1.0.0-1.1.0-2.zip');
  });

  it('resolves relative names against the working directory', () => {
    expect(resolveAsset('out/ext.zip', context)).toBe(
      resolve('/work', 'out/ext.zip'),
    );
  });

  it('leaves absolute paths alone', () => {
    expect(resolveAsset('/tmp/ext.zip', context)).toBe('/tmp/ext.zip');
  });

  it('reports EINVALIDASSET when the template cannot be evaluated', () => {
    expect(() => resolveAsset('${nope.version}.zip', context)).toThrow(
      expect.objectContaining({ code: 'EINVALIDASSET' }),
    );
  });
});
