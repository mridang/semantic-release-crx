import { getAccessToken, resolveCredentials } from './auth.js';
import { aggregate } from './errors.js';
import {
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
import { WebStoreClient } from './webstore.js';

/**
 * semantic-release `addChannel` step, run when an existing release is
 * promoted to another channel. When `promoteDeployPercentage` is set the
 * published revision's rollout is raised to that percentage without a new
 * review. The store refuses a value that is not larger than the current target
 * and items with 10,000 or fewer seven-day active users; the refusal is
 * reported as is. Without the option the step does nothing.
 *
 * @param config Plugin configuration from the semantic-release config.
 * @param context semantic-release context.
 * @returns The release link, or undefined when nothing was done.
 * @throws If configuration, credentials or the store call fail.
 */
export async function addChannel(
  config: CrxPluginConfig,
  context: StepContext,
): Promise<{ readonly name: string; readonly url: string } | undefined> {
  const { logger } = context;
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
  if (problems.length > 0) {
    throw aggregate(problems);
  }
  const extensionId = (extension as { id: string }).id;
  const credentials = await resolveCredentials(context.env ?? process.env);
  const client = new WebStoreClient({
    publisherId: (publisher as { id: string }).id,
    extensionId,
    accessToken: await getAccessToken(credentials),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs: config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
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
