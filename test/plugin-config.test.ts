import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_IGNORED_WARNINGS,
  manifestPathOf,
  resolveExtensionId,
  resolvePublisherId,
  validateConfig,
} from '../src/plugin-config.js';
import type { VerifyConditionsContext } from 'semantic-release';

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

describe('settings', () => {
  const context = (
    extra: Partial<Pick<VerifyConditionsContext, 'branch' | 'env'>> = {},
  ): Partial<Pick<VerifyConditionsContext, 'branch' | 'env'>> => extra;

  const codeOf = (error: Error): string =>
    (error as Error & { code: string }).code;

  describe('resolveExtensionId', () => {
    it('uses a plain extensionId for every branch', () => {
      expect(
        resolveExtensionId(
          { extensionId: 'abc' },
          context({ branch: { name: 'x' } }),
        ),
      ).toEqual({ ok: true, id: 'abc' });
    });

    it('picks the entry for the current branch (issues 24, 111)', () => {
      const config = { extensionId: { main: 'prod', beta: 'staging' } };
      expect(
        resolveExtensionId(config, context({ branch: { name: 'beta' } })),
      ).toEqual({ ok: true, id: 'staging' });
      expect(
        resolveExtensionId(config, context({ branch: { name: 'main' } })),
      ).toEqual({ ok: true, id: 'prod' });
    });

    it('refuses a branch that has no entry rather than guessing', () => {
      const result = resolveExtensionId(
        { extensionId: { main: 'prod' } },
        context({ branch: { name: 'develop' } }),
      );
      expect('error' in result && codeOf(result.error)).toBe(
        'EEXTENSIONIDBRANCH',
      );
      expect('error' in result && result.error.message).toContain('develop');
    });

    it('refuses a map when the branch is unknown', () => {
      const result = resolveExtensionId(
        { extensionId: { main: 'prod' } },
        context(),
      );
      expect('error' in result && codeOf(result.error)).toBe(
        'EEXTENSIONIDBRANCH',
      );
    });

    it('requires extensionId', () => {
      for (const extensionId of [undefined, '']) {
        const result = resolveExtensionId({ extensionId }, context());
        expect('error' in result && codeOf(result.error)).toBe(
          'ENOEXTENSIONID',
        );
      }
    });
  });

  describe('resolvePublisherId', () => {
    it('uses the option', () => {
      expect(resolvePublisherId({ publisherId: ' p-1 ' }, context())).toEqual({
        ok: true,
        id: 'p-1',
      });
    });

    it('falls back to CHROME_PUBLISHER_ID', () => {
      expect(
        resolvePublisherId(
          {},
          context({ env: { CHROME_PUBLISHER_ID: 'p-2' } }),
        ),
      ).toEqual({ ok: true, id: 'p-2' });
    });

    it('points at the Developer Dashboard when missing', () => {
      const result = resolvePublisherId({}, context({ env: {} }));
      expect('error' in result && codeOf(result.error)).toBe('ENOPUBLISHERID');
      expect('error' in result && result.error.message).toMatch(
        /Developer Dashboard/,
      );
    });
  });

  describe('validateConfig polling options', () => {
    it.each([Number.NaN, 0, -5, Infinity, '300000', null])(
      'rejects pollTimeoutMs %s so the wait stays bounded',
      (value) => {
        expect(
          validateConfig({ pollTimeoutMs: value as never }, false).map(
            (error) => codeOf(error),
          ),
        ).toEqual(['EINVALIDPOLL']);
      },
    );

    it.each([Number.NaN, 0, -1, '5000'])(
      'rejects pollIntervalMs %s',
      (value) => {
        expect(
          validateConfig({ pollIntervalMs: value as never }, false).map(
            (error) => codeOf(error),
          ),
        ).toEqual(['EINVALIDPOLL']);
      },
    );

    it('accepts positive numbers and leaving them unset', () => {
      expect(
        validateConfig({ pollIntervalMs: 1, pollTimeoutMs: 100 }, false),
      ).toEqual([]);
      expect(validateConfig({}, false)).toEqual([]);
    });
  });

  describe('validateConfig', () => {
    it('accepts a valid configuration', () => {
      expect(
        validateConfig(
          {
            asset: 'a.zip',
            target: 'staged',
            prerelease: 'skip',
            deployPercentage: 10,
          },
          true,
        ),
      ).toEqual([]);
    });

    it('requires asset when asked to', () => {
      expect(validateConfig({}, true).map((error) => codeOf(error))).toEqual([
        'ENOASSET',
      ]);
      expect(validateConfig({}, false)).toEqual([]);
    });

    it('rejects unknown values and reports all problems together', () => {
      const problems = validateConfig(
        {
          target: 'public' as never,
          prerelease: 'maybe' as never,
          deployPercentage: 101,
        },
        false,
      );
      expect(problems.map((error) => codeOf(error))).toEqual([
        'EINVALIDTARGET',
        'EINVALIDPRERELEASE',
        'EINVALIDDEPLOYPERCENTAGE',
      ]);
    });

    it('rejects a fractional deployPercentage', () => {
      expect(validateConfig({ deployPercentage: 2.5 }, false)).toHaveLength(1);
    });
  });

  describe('resolveExtensionId inherited keys', () => {
    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      'does not treat the branch "%s" as an entry',
      (name) => {
        const result = resolveExtensionId(
          { extensionId: { main: 'prod' } },
          context({ branch: { name } }),
        );
        expect('error' in result && codeOf(result.error)).toBe(
          'EEXTENSIONIDBRANCH',
        );
      },
    );

    it('still matches an own entry with such a name', () => {
      expect(
        resolveExtensionId(
          { extensionId: { constructor: 'x' } },
          context({ branch: { name: 'constructor' } }),
        ),
      ).toEqual({ ok: true, id: 'x' });
    });
  });
});
