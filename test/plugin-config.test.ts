import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  DEFAULT_IGNORED_WARNINGS,
  manifestPathOf,
} from '../src/plugin-config.js';

describe('manifestPathOf', () => {
  it('defaults to dist/manifest.json', () => {
    expect(manifestPathOf({})).toBe('dist/manifest.json');
  });

  it('follows distFolder', () => {
    expect(manifestPathOf({ distFolder: 'build' })).toBe('build/manifest.json');
  });

  it('prefers an explicit manifestPath', () => {
    expect(
      manifestPathOf({ distFolder: 'build', manifestPath: 'x/m.json' }),
    ).toBe('x/m.json');
  });
});

describe('DEFAULT_IGNORED_WARNINGS', () => {
  it('carries over the original whitelist (issue 46)', () => {
    expect(DEFAULT_IGNORED_WARNINGS).toEqual([
      'PUBLISHED_WITH_FRICTION_WARNING',
    ]);
  });
});
