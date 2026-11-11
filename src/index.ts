import { readFile } from 'node:fs/promises';
import path from 'node:path';
import template from 'lodash/template.js';
import SemanticReleaseError from '@semantic-release/error';
import type {
  AddChannelContext,
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import { Extension } from './extension.js';
import {
  DEFAULT_DIST_FOLDER,
  DEFAULT_IGNORED_WARNINGS,
  errorsOf,
  manifestPathOf,
  resolveExtensionId,
  resolvePublisherId,
  validateConfig,
  type CrxPluginConfig,
} from './plugin-config.js';
import { codeOf, messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';
import { toManifestVersion } from './version.js';
import { resolveCredentials, WebStoreClient } from './webstore.js';

export type {
  CrxPluginConfig,
  PrereleaseMode,
  PublishTarget,
} from './plugin-config.js';

/**
 * The errors inside whatever was thrown: the members of an aggregate error,
 * or the error itself. Recognised by shape, like `messageOf`, because an error
 * can come from another realm.
 * @param error - A caught value.
 * @returns One or more errors.
 */
function errorsFrom(error: unknown): readonly Error[] {
  const members =
    isRecord(error) && Array.isArray(error.errors) ? error.errors : [error];
  return members.map((member: unknown) =>
    member instanceof Error
      ? member
      : new SemanticReleaseError(messageOf(member), codeOf(member)),
  );
}

/**
 * Semantic-release `verifyConditions` step. Checks the configuration, finds
 * credentials, and proves they work by asking the store for the item's status,
 * so a bad token fails the release before anything is versioned or tagged.
 * Nothing is skipped silently: with `target: 'local'` the store is not
 * contacted at all, and with `prerelease: 'skip'` on a pre-release branch the
 * store is not needed either..
 * @param config - Plugin configuration from the semantic-release config.
 * @param context - Semantic-release context.
 * @throws An aggregate error listing every problem that was found.
 */
export async function verifyConditions(
  config: CrxPluginConfig,
  context: VerifyConditionsContext,
): Promise<void> {
  const { logger, branch, env } = context;
  if (config.target === 'local') {
    logger.log(
      'Target option is set to "local". Skipping verification of Chrome store credentials.',
    );
    return;
  }
  const onPrereleaseBranch = Boolean(branch.prerelease);
  if (onPrereleaseBranch && config.prerelease === 'skip') {
    logger.log(
      'Pre-releases are skipped (prerelease: "skip"). Skipping verification of Chrome store credentials.',
    );
    return;
  }
  const extension = resolveExtensionId(config, context);
  const publisher = resolvePublisherId(config, context);
  const found = await resolveCredentials(env ?? process.env)
    .then((credentials) => ({ credentials, errors: [] }))
    .catch((error: unknown) => ({
      credentials: null,
      errors: errorsFrom(error),
    }));
  const { credentials, errors } = found;
  const problems = [
    ...validateConfig(config, false),
    ...errorsOf(extension, publisher),
    ...(onPrereleaseBranch && config.prerelease === 'reject'
      ? [
          new SemanticReleaseError(
            `The branch "${branch.name}" is a pre-release branch and the prerelease option is "reject". Use "convert" or "skip", or release from a stable branch.`,
            'EPRERELEASE',
          ),
        ]
      : []),
    ...errors,
  ];
  if (problems.length > 0 || !credentials || !extension.ok || !publisher.ok) {
    throw new AggregateError(
      problems,
      'The Chrome Web Store plugin cannot run. See the errors it lists.',
    );
  }
  logger.log('Verifying Chrome Web Store credentials...');
  const client = await WebStoreClient.connect({
    publisherId: publisher.id,
    extensionId: extension.id,
    credentials,
    pollIntervalMs: config.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs,
    log: logger.log.bind(logger),
  });
  const status = await client.fetchStatus();
  logger.log('Chrome Web Store credentials are valid.');
  if (status.takenDown || status.warned) {
    logger.warn(
      status.takenDown
        ? 'The item has been taken down for a policy violation. Check the Developer Dashboard.'
        : 'The item has a policy warning and will be taken down if not resolved. Check the Developer Dashboard.',
    );
  }
}

/**
 * Semantic-release `prepare` step. Writes the next version into the manifest
 * (and any `additionalManifests`), then zips the dist folder to `asset` so
 * that `@semantic-release/github` can attach it to the release. Comments in
 * the manifest are preserved, and pre-releases are converted to a four part
 * Chrome version with the full semver in `version_name`..
 * @param config - Plugin configuration from the semantic-release config.
 * @param context - Semantic-release context.
 * @throws If configuration or the build output is wrong.
 */
export async function prepare(
  config: CrxPluginConfig,
  context: PrepareContext,
): Promise<void> {
  const { asset, additionalManifests, prerelease } = config;
  const problems = validateConfig(config, true);
  if (problems.length > 0 || !asset) {
    throw new AggregateError(
      problems,
      'The Chrome Web Store plugin cannot run. See the errors it lists.',
    );
  }
  const semver = context.nextRelease?.version;
  if (!semver) {
    throw new SemanticReleaseError(
      'Could not determine the version from semantic release.',
      'ENOVERSION',
    );
  }
  const next = toManifestVersion(semver);
  if (next.prerelease && prerelease === 'reject') {
    throw new SemanticReleaseError(
      `Version ${semver} is a pre-release and the prerelease option is "reject".`,
      'EPRERELEASE',
    );
  }
  const cwd = context.cwd ?? process.cwd();
  const distFolder = config.distFolder ?? DEFAULT_DIST_FOLDER;
  const manifests = [manifestPathOf(config), ...(additionalManifests ?? [])];
  const log = (message: string): void => context.logger.log(message);
  const extension = Extension.at(
    path.resolve(cwd, distFolder),
    manifests.map((manifest) => path.resolve(cwd, manifest)),
  );
  await extension.setVersion(semver, log);
  const assetName = (() => {
    try {
      return template(asset)({
        branch: context.branch,
        lastRelease: context.lastRelease,
        nextRelease: context.nextRelease,
        commits: context.commits,
      });
    } catch (error) {
      throw new SemanticReleaseError(
        `The asset template "${asset}" could not be evaluated: ${messageOf(error)}`,
        'EINVALIDASSET',
      );
    }
  })();
  const zipPath = path.resolve(cwd, assetName);
  const count = await extension.zip(zipPath);
  log(`Wrote zipped file with ${count} files to ${zipPath}`);
}

interface ReleaseLink {
  readonly name: string;
  readonly url: string;
}

type Logger = PublishContext['logger'];

/**
 * Look for a submission that is still waiting for review. With
 * `cancelPendingSubmission` it is cancelled, otherwise a warning is logged,
 * because the store may refuse a new upload or submission. Without the option
 * a failed status check is only logged, so the default flow never depends on
 * it.
 * @param config - Plugin configuration.
 * @param client - Store client.
 * @param logger - Step logger.
 * @returns True when a pending submission was found and left in place.
 */
async function handlePendingSubmission(
  config: CrxPluginConfig,
  client: WebStoreClient,
  logger: Logger,
): Promise<boolean> {
  const pending = await client
    .hasPendingSubmission()
    .catch((error: unknown) => {
      if (config.cancelPendingSubmission) {
        throw error;
      }
      logger.warn(
        `Could not check for a pending submission: ${messageOf(error)}`,
      );
      return false;
    });
  if (!pending) {
    return false;
  }
  if (!config.cancelPendingSubmission) {
    logger.warn(
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
 * @param error - The error raised by the store call.
 * @param config - Plugin configuration.
 * @returns The error to throw: the original, or a copy whose message carries
 * the hint.
 */
function withPendingHint(error: unknown, config: CrxPluginConfig): unknown {
  if (
    config.cancelPendingSubmission ||
    !(error instanceof Error) ||
    error instanceof AggregateError
  ) {
    return error;
  }
  return new SemanticReleaseError(
    `${error.message} A submission was pending review: set cancelPendingSubmission to true to cancel it before publishing.`,
    codeOf(error) ?? 'EWEBSTORE',
  );
}

/**
 * Semantic-release `publish` step. Uploads the zip built by `prepare`, waits
 * for the store to finish processing it, and only then submits it. The
 * submission is never made unless the upload reported `SUCCEEDED`..
 * @param config - Plugin configuration from the semantic-release config.
 * @param context - Semantic-release context.
 * @returns The release link semantic-release shows in its comments, or
 * undefined when nothing was published.
 * @throws If configuration, credentials, the upload or the submission fail.
 */
export async function publish(
  config: CrxPluginConfig,
  context: PublishContext,
): Promise<ReleaseLink | undefined> {
  const { logger, branch, lastRelease, nextRelease, commits, cwd, env } =
    context;
  const {
    asset,
    deployPercentage,
    failOnWarnings,
    ignoredWarnings,
    pollIntervalMs,
    pollTimeoutMs,
    prerelease,
    skipReview,
    target,
  } = config;
  if (target === 'local') {
    logger.log('Target option is set to "local", skipping the publish step.');
    return undefined;
  }
  const semver = nextRelease?.version;
  if (semver && prerelease === 'skip' && toManifestVersion(semver).prerelease) {
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
  if (problems.length > 0 || !asset || !extension.ok || !publisher.ok) {
    throw new AggregateError(
      problems,
      'The Chrome Web Store plugin cannot run. See the errors it lists.',
    );
  }
  const extensionId = extension.id;
  const assetName = (() => {
    try {
      return template(asset)({
        branch,
        lastRelease,
        nextRelease,
        commits,
      });
    } catch (error) {
      throw new SemanticReleaseError(
        `The asset template "${asset}" could not be evaluated: ${messageOf(error)}`,
        'EINVALIDASSET',
      );
    }
  })();
  const assetPath = path.resolve(cwd ?? process.cwd(), assetName);
  const zip = await readFile(assetPath).catch(() => {
    throw new SemanticReleaseError(
      `The asset "${assetPath}" does not exist. The prepare step of this plugin creates it, so make sure the plugin is configured for prepare and runs before publish.`,
      'ENOASSETFILE',
    );
  });
  const credentials = await resolveCredentials(env ?? process.env);
  const client = await WebStoreClient.connect({
    publisherId: publisher.id,
    extensionId,
    credentials,
    pollIntervalMs,
    pollTimeoutMs,
    log: logger.log.bind(logger),
  });
  const pending = await handlePendingSubmission(config, client, logger);
  logger.log('Uploading zip file to the Chrome Web Store...');
  const uploaded = await client.upload(zip).catch((error: unknown) => {
    throw pending ? withPendingHint(error, config) : error;
  });
  logger.log(
    `Successfully uploaded extension to the Chrome Web Store${
      uploaded.crxVersion ? ` (version ${uploaded.crxVersion})` : ''
    }`,
  );
  const link: ReleaseLink = {
    name: 'Chrome Web Store',
    url: `https://chromewebstore.google.com/detail/${extensionId}`,
  };
  if (target === 'draft') {
    logger.log('Target option is set to "draft", skipping publish step');
    return link;
  }
  if (target === 'trustedTesters') {
    logger.warn(
      'Target "trustedTesters" is no longer an API option: the audience is set by the item\'s Distribution settings in the Developer Dashboard. Publishing as "default".',
    );
  }
  logger.log('Publishing extension to the Chrome Web Store...');
  const state = await client
    .submit(
      {
        publishType: target === 'staged' ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH',
        ...(deployPercentage === undefined
          ? {}
          : { deployInfos: [{ deployPercentage }] }),
        ...(skipReview ? { skipReview: true } : {}),
        ...(failOnWarnings && ignoredWarnings?.length === 0
          ? { blockOnWarnings: true }
          : {}),
      },
      {
        ignoredWarnings: ignoredWarnings ?? DEFAULT_IGNORED_WARNINGS,
        failOnWarnings: Boolean(failOnWarnings),
      },
    )
    .catch((error: unknown) => {
      throw pending ? withPendingHint(error, config) : error;
    });
  logger.log(
    `Successfully published extension to the Chrome Web Store (state ${state})`,
  );
  return link;
}

/**
 * Semantic-release `addChannel` step, run when an existing release is
 * promoted to another channel. When `promoteDeployPercentage` is set the
 * published revision's rollout is raised to that percentage without a new
 * review. The store refuses a value that is not larger than the current target
 * and items with 10,000 or fewer seven-day active users; the refusal is
 * reported as is. Without the option the step does nothing..
 * @param config - Plugin configuration from the semantic-release config.
 * @param context - Semantic-release context.
 * @returns The release link, or undefined when nothing was done.
 * @throws If configuration, credentials or the store call fail.
 */
export async function addChannel(
  config: CrxPluginConfig,
  context: AddChannelContext,
): Promise<ReleaseLink | undefined> {
  const { logger, env } = context;
  if (
    config.promoteDeployPercentage === undefined ||
    config.target === 'local'
  ) {
    return undefined;
  }
  const extension = resolveExtensionId(config, context);
  const publisher = resolvePublisherId(config, context);
  const problems = [
    ...validateConfig(config, false),
    ...errorsOf(extension, publisher),
  ];
  if (problems.length > 0 || !extension.ok || !publisher.ok) {
    throw new AggregateError(
      problems,
      'The Chrome Web Store plugin cannot run. See the errors it lists.',
    );
  }
  const extensionId = extension.id;
  const credentials = await resolveCredentials(env ?? process.env);
  const client = await WebStoreClient.connect({
    publisherId: publisher.id,
    extensionId,
    credentials,
    pollIntervalMs: config.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs,
    log: logger.log.bind(logger),
  });
  logger.log(
    `Raising the published rollout to ${config.promoteDeployPercentage}%...`,
  );
  await client.setPublishedDeployPercentage(config.promoteDeployPercentage);
  logger.log(
    `Published rollout is now targeting ${config.promoteDeployPercentage}%`,
  );
  return {
    name: 'Chrome Web Store',
    url: `https://chromewebstore.google.com/detail/${extensionId}`,
  };
}

export default { verifyConditions, prepare, publish, addChannel } as const;
