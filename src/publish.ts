import { readFile } from 'node:fs/promises';
import { getAccessToken, resolveCredentials } from './auth.js';
import template from 'lodash/template.js';
import { resolve } from 'node:path';
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
  errorsOf,
  resolvePublisherId,
  validateConfig,
} from './settings.js';
import { toManifestVersion } from './version.js';
import { WebStoreClient } from './webstore.js';

interface ReleaseLink {
  readonly name: string;
  readonly url: string;
}

type Logger = StepContext['logger'];

/**
 * Look for a submission that is still waiting for review. With
 * `cancelPendingSubmission` it is cancelled, otherwise a warning is logged,
 * because the store may refuse a new upload or submission. Without the option
 * a failed status check is only logged, so the default flow never depends on
 * it.
 *
 * @param config Plugin configuration.
 * @param client Store client.
 * @param logger Step logger.
 * @returns True when a pending submission was found and left in place.
 */
async function handlePendingSubmission(
  config: CrxPluginConfig,
  client: WebStoreClient,
  logger: Logger,
): Promise<boolean> {
  const warn = logger.warn ?? logger.log;
  const pending = await client
    .hasPendingSubmission()
    .catch((error: unknown) => {
      if (config.cancelPendingSubmission) {
        throw error;
      }
      warn(
        `Could not check for a pending submission: ${(error as Error).message}`,
      );
      return false;
    });
  if (!pending) {
    return false;
  }
  if (!config.cancelPendingSubmission) {
    warn(
      'A previous submission is still pending review, so the store may refuse this release. Set cancelPendingSubmission to true to cancel it first.',
    );
    return true;
  }
  logger.log('Cancelling the submission that is pending review...');
  await client.cancelSubmission();
  return false;
}

/**
 * Point at `cancelPendingSubmission` when a refusal may be caused by a
 * pending submission that was left in place.
 *
 * @param error The error raised by the store call.
 * @param pending Whether a pending submission was found and kept.
 * @param config Plugin configuration.
 * @returns Never; rethrows the error, with a hint appended when relevant.
 */
function addPendingHint(
  error: unknown,
  pending: boolean,
  config: CrxPluginConfig,
): never {
  if (pending && !config.cancelPendingSubmission && error instanceof Error) {
    throw crxError(
      `${error.message} A submission was pending review: set cancelPendingSubmission to true to cancel it before publishing.`,
      (error as Error & { code?: string }).code ?? 'EWEBSTORE',
    );
  }
  throw error;
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
  const extension = resolveExtensionId(config, context);
  const publisher = resolvePublisherId(config, context);
  const problems = [
    ...validateConfig(config, true),
    ...errorsOf(extension, publisher),
  ];
  if (problems.length > 0) {
    throw aggregate(problems);
  }
  const extensionId = (extension as { id: string }).id;
  const assetName = (() => {
    try {
      return template(config.asset as string)({
        branch: context.branch,
        lastRelease: context.lastRelease,
        nextRelease: context.nextRelease,
        commits: context.commits,
      });
    } catch (error) {
      throw crxError(
        `The asset template "${config.asset}" could not be evaluated: ${(error as Error).message}`,
        'EINVALIDASSET',
      );
    }
  })();
  const assetPath = resolve(context.cwd ?? process.cwd(), assetName);
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
  const pending = await handlePendingSubmission(config, client, logger);
  logger.log('Uploading zip file to the Chrome Web Store...');
  const uploaded = await client
    .upload(zip)
    .catch((error: unknown) => addPendingHint(error, pending, config));
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
  const state = await client
    .submit(
      {
        publishType:
          config.target === 'staged' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH',
        ...(config.deployPercentage === undefined
          ? {}
          : { deployInfos: [{ deployPercentage: config.deployPercentage }] }),
        ...(config.skipReview ? { skipReview: true } : {}),
        ...(config.failOnWarnings && config.ignoredWarnings?.length === 0
          ? { blockOnWarnings: true }
          : {}),
      },
      {
        ignoredWarnings: config.ignoredWarnings ?? DEFAULT_IGNORED_WARNINGS,
        failOnWarnings: Boolean(config.failOnWarnings),
      },
    )
    .catch((error: unknown) => addPendingHint(error, pending, config));
  logger.log(
    `Successfully published extension to the Chrome Web Store (state ${state})`,
  );
  return link;
}
