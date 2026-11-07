import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  resolveExtensionId,
  resolvePublisherId,
  validateConfig,
} from '../src/settings.js';
import { recordingLogger } from './utils/logger.js';

const context = (extra: Record<string, unknown> = {}) => ({
  logger: recordingLogger().logger,
  ...extra,
});

const codeOf = (error: Error): string =>
  (error as Error & { code: string }).code;

describe('resolveExtensionId', () => {
  it('uses a plain extensionId for every branch', () => {
    expect(
      resolveExtensionId(
        { extensionId: 'abc' },
        context({ branch: { name: 'x' } }),
      ),
    ).toEqual({ id: 'abc' });
  });

  it('picks the entry for the current branch (issues 24, 111)', () => {
    const config = { extensionId: { main: 'prod', beta: 'staging' } };
    expect(
      resolveExtensionId(config, context({ branch: { name: 'beta' } })),
    ).toEqual({ id: 'staging' });
    expect(
      resolveExtensionId(config, context({ branch: { name: 'main' } })),
    ).toEqual({ id: 'prod' });
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
      expect('error' in result && codeOf(result.error)).toBe('ENOEXTENSIONID');
    }
  });
});

describe('resolvePublisherId', () => {
  it('uses the option', () => {
    expect(resolvePublisherId({ publisherId: ' p-1 ' }, context())).toEqual({
      id: 'p-1',
    });
  });

  it('falls back to CHROME_PUBLISHER_ID', () => {
    expect(
      resolvePublisherId({}, context({ env: { CHROME_PUBLISHER_ID: 'p-2' } })),
    ).toEqual({ id: 'p-2' });
  });

  it('points at the Developer Dashboard when missing', () => {
    const result = resolvePublisherId({}, context({ env: {} }));
    expect('error' in result && codeOf(result.error)).toBe('ENOPUBLISHERID');
    expect('error' in result && result.error.message).toMatch(
      /Developer Dashboard/,
    );
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
    expect(validateConfig({}, true).map(codeOf)).toEqual(['ENOASSET']);
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
    expect(problems.map(codeOf)).toEqual([
      'EINVALIDTARGET',
      'EINVALIDPRERELEASE',
      'EINVALIDDEPLOYPERCENTAGE',
    ]);
  });

  it('rejects a fractional deployPercentage', () => {
    expect(validateConfig({ deployPercentage: 2.5 }, false)).toHaveLength(1);
  });
});
