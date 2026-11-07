import { crxError } from './errors.js';

export interface ManifestVersion {
  /**
   * Value for the manifest `version` field: one to four dot separated
   * integers, each between 0 and 65535.
   */
  version: string;

  /**
   * Value for `version_name`, only set for pre-releases so the full semver is
   * still visible to people.
   */
  versionName?: string;

  prerelease: boolean;
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

const MAX_PART = 65535;

/**
 * Translate a semantic-release version into what Chrome accepts. Chrome only
 * allows one to four dot separated integers, so `1.2.3-beta.4` becomes
 * version `1.2.3.4` with `version_name` `1.2.3-beta.4`. The last numeric
 * identifier of the pre-release is used as the fourth part, which keeps
 * successive pre-releases strictly increasing.
 *
 * @param semver Version from `nextRelease.version`.
 * @returns The manifest fields to write.
 * @throws If the version is not semver, has no numeric pre-release identifier
 * or a part exceeds 65535.
 */
export function toManifestVersion(semver: string): ManifestVersion {
  const match = SEMVER.exec(semver);
  if (!match) {
    throw crxError(
      `Cannot use "${semver}" as a Chrome extension version: it is not a valid semantic version.`,
      'EINVALIDVERSION',
    );
  }
  const [, major, minor, patch, pre] = match;
  const core = [major, minor, patch].map(Number);
  const counter = pre
    ?.split('.')
    .filter((id) => /^\d+$/.test(id))
    .map(Number)
    .at(-1);
  if (pre !== undefined && counter === undefined) {
    throw crxError(
      `Cannot use "${semver}" as a Chrome extension version: the pre-release has no numeric identifier to use as the fourth version part.`,
      'EINVALIDVERSION',
    );
  }
  const parts = counter === undefined ? core : [...core, counter];
  if (parts.some((part) => part > MAX_PART)) {
    throw crxError(
      `Cannot use "${semver}" as a Chrome extension version: every part must be between 0 and ${MAX_PART}.`,
      'EINVALIDVERSION',
    );
  }
  const withoutBuild = semver.split('+')[0];
  return {
    version: parts.join('.'),
    versionName: pre === undefined ? undefined : withoutBuild,
    prerelease: pre !== undefined,
  };
}
