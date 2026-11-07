import { getAccessToken, resolveCredentials } from './auth.js';
import { aggregate, crxError } from './errors.js';
import type { CrxPluginConfig, StepContext } from './plugin-config.js';
import {
  resolveExtensionId,
  resolvePublisherId,
  validateConfig,
} from './settings.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
} from './plugin-config.js';
import { WebStoreClient } from './webstore-client.js';

/**
 * semantic-release `verifyConditions` step. Checks the configuration, finds
 * credentials, and proves they work by asking the store for the item's status,
 * so a bad token fails the release before anything is versioned or tagged.
 * Nothing is skipped silently: with `target: 'local'` the store is not
 * contacted at all, and with `prerelease: 'skip'` on a pre-release branch the
 * store is not needed either.
 *
 * @param config Plugin configuration from the semantic-release config.
 * @param context semantic-release context.
 * @throws An aggregate error listing every problem that was found.
 */
export async function verifyConditions(
  config: CrxPluginConfig,
  context: StepContext,
): Promise<void> {
  const { logger } = context;
  if (config.target === 'local') {
    logger.log(
      'Target option is set to "local". Skipping verification of Chrome store credentials.',
    );
    return;
  }
  const onPrereleaseBranch = Boolean(context.branch?.prerelease);
  if (onPrereleaseBranch && config.prerelease === 'skip') {
    logger.log(
      'Pre-releases are skipped (prerelease: "skip"). Skipping verification of Chrome store credentials.',
    );
    return;
  }
  const problems = validateConfig(config, false);
  const extension = resolveExtensionId(config, context);
  const publisher = resolvePublisherId(config, context);
  if ('error' in extension) {
    problems.push(extension.error);
  }
  if ('error' in publisher) {
    problems.push(publisher.error);
  }
  if (onPrereleaseBranch && config.prerelease === 'reject') {
    problems.push(
      crxError(
        `The branch "${context.branch?.name ?? ''}" is a pre-release branch and the prerelease option is "reject". Use "convert" or "skip", or release from a stable branch.`,
        'EPRERELEASE',
      ),
    );
  }
  const credentials = await resolveCredentials(context.env ?? process.env).then(
    (found) => found,
    (error: unknown) => {
      problems.push(
        ...(error instanceof AggregateError
          ? (error.errors as Error[])
          : [error as Error]),
      );
      return undefined;
    },
  );
  if (problems.length > 0 || !credentials) {
    throw aggregate(problems);
  }
  logger.log('Verifying Chrome Web Store credentials...');
  const client = new WebStoreClient({
    publisherId: (publisher as { id: string }).id,
    extensionId: (extension as { id: string }).id,
    accessToken: await getAccessToken(credentials),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs: config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    log: (message) => logger.log(message),
  });
  const status = await client.fetchStatus();
  logger.log('Chrome Web Store credentials are valid.');
  if (status.takenDown || status.warned) {
    (logger.warn ?? logger.log)(
      status.takenDown
        ? 'The item has been taken down for a policy violation. Check the Developer Dashboard.'
        : 'The item has a policy warning and will be taken down if not resolved. Check the Developer Dashboard.',
    );
  }
}
