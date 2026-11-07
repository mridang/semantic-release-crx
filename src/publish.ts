import { readFile } from 'node:fs/promises';
import { getAccessToken, resolveCredentials } from './auth.js';
import { resolveAsset } from './asset.js';
import { aggregate, crxError } from './errors.js';
import {
  DEFAULT_IGNORED_WARNINGS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  type CrxPluginConfig,
  type StepContext,
} from './plugin-config.js';
import {
  resolveExtensionId,
  resolvePublisherId,
  validateConfig,
} from './settings.js';
import { toManifestVersion } from './version.js';
import { WebStoreClient, type ItemState } from './webstore-client.js';

const ACCEPTED_STATES: ItemState[] = [
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
];

interface ReleaseLink {
  name: string;
  url: string;
}

/**
 * semantic-release `publish` step. Uploads the zip built by `prepare`, waits
 * for the store to finish processing it, and only then submits it. The
 * submission is never made unless the upload reported `SUCCEEDED`.
 *
 * @param config Plugin configuration from the semantic-release config.
 * @param context semantic-release context.
 * @returns The release link semantic-release shows in its comments, or
 * undefined when nothing was published.
 * @throws If configuration, credentials, the upload or the submission fail.
 */
export async function publish(
  config: CrxPluginConfig,
  context: StepContext,
): Promise<ReleaseLink | undefined> {
  const { logger } = context;
  if (config.target === 'local') {
    logger.log('Target option is set to "local", skipping the publish step.');
    return undefined;
  }
  const semver = context.nextRelease?.version;
  if (
    semver &&
    config.prerelease === 'skip' &&
    toManifestVersion(semver).prerelease
  ) {
    logger.log(
      `Version ${semver} is a pre-release and prerelease is "skip", skipping the publish step.`,
    );
    return undefined;
  }
  const problems = validateConfig(config, true);
  const extension = resolveExtensionId(config, context);
  const publisher = resolvePublisherId(config, context);
  if ('error' in extension) {
    problems.push(extension.error);
  }
  if ('error' in publisher) {
    problems.push(publisher.error);
  }
  if (problems.length > 0) {
    throw aggregate(problems);
  }
  const extensionId = (extension as { id: string }).id;
  const assetPath = resolveAsset(config.asset as string, context);
  const zip = await readFile(assetPath).catch(() => {
    throw crxError(
      `The asset "${assetPath}" does not exist. The prepare step of this plugin creates it, so make sure the plugin is configured for prepare and runs before publish.`,
      'ENOASSETFILE',
    );
  });
  const credentials = await resolveCredentials(context.env ?? process.env);
  const client = new WebStoreClient({
    publisherId: (publisher as { id: string }).id,
    extensionId,
    accessToken: await getAccessToken(credentials),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs: config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    log: (message) => logger.log(message),
  });
  logger.log('Uploading zip file to the Chrome Web Store...');
  const uploaded = await client.upload(zip);
  logger.log(
    `Successfully uploaded extension to the Chrome Web Store${
      uploaded.crxVersion ? ` (version ${uploaded.crxVersion})` : ''
    }`,
  );
  const link: ReleaseLink = {
    name: 'Chrome Web Store',
    url: `https://chromewebstore.google.com/detail/${extensionId}`,
  };
  if (config.target === 'draft') {
    logger.log('Target option is set to "draft", skipping publish step');
    return link;
  }
  if (config.target === 'trustedTesters') {
    (logger.warn ?? logger.log)(
      'Target "trustedTesters" is no longer an API option: the audience is set by the item\'s Distribution settings in the Developer Dashboard. Publishing as "default".',
    );
  }
  logger.log('Publishing extension to the Chrome Web Store...');
  const result = await client.publish({
    publishType:
      config.target === 'staged' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH',
    ...(config.deployPercentage === undefined
      ? {}
      : { deployInfos: [{ deployPercentage: config.deployPercentage }] }),
    ...(config.skipReview ? { skipReview: true } : {}),
  });
  const ignored = config.ignoredWarnings ?? DEFAULT_IGNORED_WARNINGS;
  const warnings = result.warningInfo?.warnings ?? [];
  const blocking = warnings.filter(
    (warning) => !ignored.includes(warning.reason ?? ''),
  );
  warnings.forEach((warning) =>
    logger.log(`${warning.reason ?? 'WARNING'}: ${warning.description ?? ''}`),
  );
  if (config.failOnWarnings && blocking.length > 0) {
    throw aggregate(
      blocking.map((warning) =>
        crxError(
          warning.description ?? 'Warning',
          warning.reason ?? 'EWARNING',
        ),
      ),
    );
  }
  if (!result.state || !ACCEPTED_STATES.includes(result.state)) {
    throw crxError(
      `Chrome Web Store did not accept the submission (state ${result.state ?? 'unknown'}). Open the item in the Developer Dashboard to see why.`,
      'EPUBLISHSTATE',
    );
  }
  logger.log(
    `Successfully published extension to the Chrome Web Store (state ${result.state})`,
  );
  return link;
}
