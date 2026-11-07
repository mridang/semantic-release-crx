import { readFile, writeFile } from 'node:fs/promises';
import { crxError } from './errors.js';
import { hasTopLevel, parseJsonc, setTopLevelString } from './jsonc.js';
import type { ManifestVersion } from './version.js';

/**
 * Write the release version into a manifest. Chrome accepts comments in
 * `manifest.json`, so the file is edited in place rather than parsed and
 * re-serialised: only the version members change and everything else, including
 * comments and formatting, is preserved. `version_name` is written for
 * pre-releases and refreshed when the manifest already has one.
 *
 * @param path Manifest file to update.
 * @param next Version fields from `toManifestVersion`.
 * @param semver The full semantic-release version.
 * @param log Receives one line describing the change.
 * @throws If the file is missing, unreadable or not a JSON object.
 */
export async function writeManifestVersion(
  path: string,
  next: ManifestVersion,
  semver: string,
  log: (message: string) => void,
): Promise<void> {
  const original = await readFile(path, 'utf8').catch((error: unknown) => {
    throw crxError(
      `Could not read the manifest at "${path}": ${(error as Error).message}. Set manifestPath or distFolder so it points at your manifest.json.`,
      'ENOMANIFEST',
    );
  });
  const parsed = (() => {
    try {
      return parseJsonc(original);
    } catch (error) {
      throw crxError(
        `The manifest at "${path}" is not valid JSON: ${(error as Error).message}`,
        'EINVALIDMANIFEST',
      );
    }
  })();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw crxError(
      `The manifest at "${path}" must be a JSON object.`,
      'EINVALIDMANIFEST',
    );
  }
  const withVersion = setTopLevelString(original, 'version', next.version);
  const versionName =
    next.versionName ??
    (hasTopLevel(withVersion, 'version_name') ? semver : undefined);
  const updated =
    versionName === undefined
      ? withVersion
      : setTopLevelString(withVersion, 'version_name', versionName);
  await writeFile(path, updated);
  log(
    versionName === undefined
      ? `Wrote version ${next.version} to ${path}`
      : `Wrote version ${next.version} (version_name ${versionName}) to ${path}`,
  );
}
