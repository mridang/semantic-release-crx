import { loadFixture } from './utils/fixtures.js';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { toManifestVersion } from '../src/version.js';

const versions = await loadFixture('manifest-versions.json');

describe('toManifestVersion', () => {
  it('keeps a stable version as is and sets no version_name', () => {
    expect(toManifestVersion('1.2.3')).toEqual({
      version: '1.2.3',
      prerelease: false,
    });
  });

  it('ignores build metadata on a stable version', () => {
    expect(toManifestVersion('1.2.3+build.5').version).toBe('1.2.3');
  });

  it('turns a pre-release into four parts and keeps the full semver as version_name (issue 111)', () => {
    expect(toManifestVersion('1.0.0-develop.1')).toEqual({
      version: versions.develop1,
      versionName: '1.0.0-develop.1',
      prerelease: true,
    });
  });

  it('uses the last numeric identifier so successive pre-releases increase (issue 111)', () => {
    const first = toManifestVersion('2.0.0-beta.9').version;
    const second = toManifestVersion('2.0.0-beta.10').version;
    expect(first).toBe(versions.beta9);
    expect(second).toBe(versions.beta10);
  });

  it('drops build metadata from version_name', () => {
    expect(toManifestVersion('1.0.0-rc.2+sha.abc').versionName).toBe(
      '1.0.0-rc.2',
    );
  });

  it('rejects text that is not a semantic version', () => {
    expect(() => toManifestVersion('v1.2')).toThrow(/not a valid semantic/);
  });

  it('rejects a pre-release without a numeric identifier', () => {
    expect(() => toManifestVersion('1.0.0-beta')).toThrow(/no numeric/);
  });

  it('rejects parts above 65535, which Chrome does not accept', () => {
    expect(() => toManifestVersion('1.70000.0')).toThrow(/65535/);
    expect(() => toManifestVersion('1.0.0-alpha.65536')).toThrow(/65535/);
  });

  it('accepts the largest allowed part', () => {
    expect(toManifestVersion('65535.0.1').version).toBe('65535.0.1');
  });

  it('reports EINVALIDVERSION', () => {
    expect(() => toManifestVersion('nope')).toThrow(
      expect.objectContaining({ code: 'EINVALIDVERSION' }),
    );
  });
});
