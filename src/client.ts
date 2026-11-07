import { getAccessToken, resolveCredentials } from './auth.js';
import { crxError } from './errors.js';
import {
  WebStoreClient,
  type RollbackRequest,
  type StatusResponse,
} from './webstore-client.js';

export type { RollbackRequest, StatusResponse };

export interface ConnectionOptions {
  /** Publisher ID from the Developer Dashboard. */
  publisherId: string;
  /** The 32 letter item ID. */
  extensionId: string;
  /**
   * Environment to read credentials from, with the same variables the plugin
   * uses (`CHROME_ACCESS_TOKEN`, the `GOOGLE_*` OAuth triple or a service
   * account key). Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>;
  /** Receives progress messages. Silent by default. */
  log?: (message: string) => void;
}

/**
 * Authenticate and build a client.
 *
 * @param options Item and credentials source.
 * @returns A client with a fresh access token.
 */
async function connect(options: ConnectionOptions): Promise<WebStoreClient> {
  const credentials = await resolveCredentials(options.env ?? process.env);
  return new WebStoreClient({
    publisherId: options.publisherId,
    extensionId: options.extensionId,
    accessToken: await getAccessToken(credentials),
    pollIntervalMs: 5000,
    pollTimeoutMs: 300000,
    log: options.log,
  });
}

/**
 * Fetch the status of an item.
 *
 * @param options Item and credentials source.
 * @returns The store's status for the item.
 */
export async function fetchStatus(
  options: ConnectionOptions,
): Promise<StatusResponse> {
  return (await connect(options)).fetchStatus();
}

/**
 * Cancel the item's active submission, for example one waiting for review.
 *
 * @param options Item and credentials source.
 */
export async function cancelSubmission(
  options: ConnectionOptions,
): Promise<void> {
  await (await connect(options)).cancelSubmission();
}

/**
 * Raise the rollout of the published revision without a new review. The
 * value must be larger than the current target, and the store only allows this
 * for items with over 10,000 seven-day active users.
 *
 * @param options Item and credentials source, and the new percentage (a whole
 * number between 0 and 100).
 * @throws With code `EINVALIDDEPLOYPERCENTAGE` for an invalid percentage.
 */
export async function setPublishedDeployPercentage(
  options: ConnectionOptions & { deployPercentage: number },
): Promise<void> {
  const { deployPercentage } = options;
  if (
    !(
      Number.isInteger(deployPercentage) &&
      deployPercentage >= 0 &&
      deployPercentage <= 100
    )
  ) {
    throw crxError(
      'deployPercentage must be a whole number between 0 and 100.',
      'EINVALIDDEPLOYPERCENTAGE',
    );
  }
  await (await connect(options)).setPublishedDeployPercentage(deployPercentage);
}

/**
 * Roll the published package back to a previously published one and publish
 * it to all users. This is never done by the plugin itself: call it on
 * purpose. Use `validateOnly` for a dry run.
 *
 * @param options Item and credentials source, plus `rollbackReason` and
 * `newVersion` (both required; the version must be higher than the currently
 * published one), and optionally `targetCrxVersion` and `validateOnly`.
 * @throws With code `EINVALIDROLLBACK` when a required field is missing.
 */
export async function rollback(
  options: ConnectionOptions & RollbackRequest,
): Promise<void> {
  const { rollbackReason, newVersion, targetCrxVersion, validateOnly } =
    options;
  if (!rollbackReason?.trim() || !newVersion?.trim()) {
    throw crxError(
      'A rollback needs both rollbackReason and newVersion; newVersion must be higher than the currently published version.',
      'EINVALIDROLLBACK',
    );
  }
  await (
    await connect(options)
  ).rollback({
    rollbackReason,
    newVersion,
    ...(targetCrxVersion === undefined ? {} : { targetCrxVersion }),
    ...(validateOnly === undefined ? {} : { validateOnly }),
  });
}
