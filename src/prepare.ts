import { resolve } from 'node:path';
import { resolveAsset } from './asset.js';
import { aggregate, crxError } from './errors.js';
import { Extension } from './extension.js';
import {
  DEFAULT_DIST_FOLDER,
  manifestPathOf,
  type CrxPluginConfig,
  type StepContext,
} from './plugin-config.js';
import { validateConfig } from './settings.js';
import { toManifestVersion } from './version.js';

/**
 * semantic-release `prepare` step. Writes the next version into the manifest
 * (and any `additionalManifests`), then zips the dist folder to `asset` so
 * that `@semantic-release/github` can attach it to the release. Comments in
 * the manifest are preserved, and pre-releases are converted to a four part
 * Chrome version with the full semver in `version_name`.
 *
 * @param config Plugin configuration from the semantic-release config.
 * @param context semantic-release context.
 * @throws If configuration or the build output is wrong.
 */
export async function prepare(
  config: CrxPluginConfig,
  context: StepContext,
): Promise<void> {
  const problems = validateConfig(config, true);
  if (problems.length > 0) {
    throw aggregate(problems);
  }
  const semver = context.nextRelease?.version;
  if (!semver) {
    throw crxError(
      'Could not determine the version from semantic release.',
      'ENOVERSION',
    );
  }
  const next = toManifestVersion(semver);
  if (next.prerelease && config.prerelease === 'reject') {
    throw crxError(
      `Version ${semver} is a pre-release and the prerelease option is "reject".`,
      'EPRERELEASE',
    );
  }
  const cwd = context.cwd ?? process.cwd();
  const distFolder = config.distFolder ?? DEFAULT_DIST_FOLDER;
  const manifests = [
    manifestPathOf(config),
    ...(config.additionalManifests ?? []),
  ];
  const log = (message: string): void => context.logger.log(message);
  const extension = Extension.at(
    resolve(cwd, distFolder),
    manifests.map((manifest) => resolve(cwd, manifest)),
  );
  await extension.setVersion(semver, log);
  const zipPath = resolveAsset(config.asset as string, context);
  const count = await extension.zip(zipPath);
  log(`Wrote zipped file with ${count} files to ${zipPath}`);
}
