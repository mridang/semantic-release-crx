import { crxError } from './errors.js';
import type { CrxPluginConfig, StepContext } from './plugin-config.js';

const TARGETS = ['default', 'trustedTesters', 'draft', 'local', 'staged'];

const PRERELEASE_MODES = ['convert', 'skip', 'reject'];

/**
 * Pick the item ID for the branch being released. A plain string applies to
 * every branch; a map lets pre-release branches publish to their own item.
 *
 * @param config Plugin configuration.
 * @param context Step context providing the branch.
 * @returns The item ID, or an error describing what is wrong.
 */
export function resolveExtensionId(
  config: CrxPluginConfig,
  context: StepContext,
): { id: string } | { error: Error } {
  const { extensionId } = config;
  if (typeof extensionId === 'string' && extensionId !== '') {
    return { id: extensionId };
  }
  if (typeof extensionId === 'object' && extensionId !== null) {
    const branch = context.branch?.name;
    const id =
      branch !== undefined && Object.hasOwn(extensionId, branch)
        ? extensionId[branch]
        : undefined;
    return id
      ? { id }
      : {
          error: crxError(
            `Option 'extensionId' maps branches to extension IDs, but has no entry for the branch "${branch ?? 'unknown'}". Add one, or use a single extensionId. Check the README.md for config info.`,
            'EEXTENSIONIDBRANCH',
          ),
        };
  }
  return {
    error: crxError(
      "Option 'extensionId' was not included in the config. Check the README.md for config info.",
      'ENOEXTENSIONID',
    ),
  };
}

/**
 * Find the publisher ID, from the option or `CHROME_PUBLISHER_ID`.
 *
 * @param config Plugin configuration.
 * @param context Step context providing the environment.
 * @returns The publisher ID, or an error pointing at the dashboard.
 */
export function resolvePublisherId(
  config: CrxPluginConfig,
  context: StepContext,
): { id: string } | { error: Error } {
  const id =
    config.publisherId?.trim() ||
    (context.env ?? process.env).CHROME_PUBLISHER_ID?.trim();
  return id
    ? { id }
    : {
        error: crxError(
          "Option 'publisherId' was not included in the config. The Chrome Web Store API V2 needs it: open the Chrome Web Store Developer Dashboard (https://chrome.google.com/webstore/devconsole), choose Account, and copy the Publisher ID. You can also set the CHROME_PUBLISHER_ID environment variable.",
          'ENOPUBLISHERID',
        ),
      };
}

/**
 * Validate the options that do not need the network.
 *
 * @param config Plugin configuration.
 * @param context Step context.
 * @param requireAsset Whether `asset` is mandatory for this step.
 * @returns Every problem found, so they can be reported together.
 */
export function validateConfig(
  config: CrxPluginConfig,
  requireAsset: boolean,
): readonly Error[] {
  return [
    ...(requireAsset && !config.asset
      ? [
          crxError(
            "Option 'asset' was not included in the config. Check the README.md for config info.",
            'ENOASSET',
          ),
        ]
      : []),
    ...(config.target !== undefined && !TARGETS.includes(config.target)
      ? [
          crxError(
            `Option 'target' must be one of ${TARGETS.join(', ')}, not "${String(config.target)}".`,
            'EINVALIDTARGET',
          ),
        ]
      : []),
    ...(config.prerelease !== undefined &&
    !PRERELEASE_MODES.includes(config.prerelease)
      ? [
          crxError(
            `Option 'prerelease' must be one of ${PRERELEASE_MODES.join(', ')}, not "${String(config.prerelease)}".`,
            'EINVALIDPRERELEASE',
          ),
        ]
      : []),
    ...(['deployPercentage', 'promoteDeployPercentage'] as const).flatMap(
      (name) => {
        const percentage = config[name];
        return percentage !== undefined &&
          !(
            Number.isInteger(percentage) &&
            percentage >= 0 &&
            percentage <= 100
          )
          ? [
              crxError(
                `Option '${name}' must be a whole number between 0 and 100.`,
                'EINVALIDDEPLOYPERCENTAGE',
              ),
            ]
          : [];
      },
    ),
  ];
}

/**
 * Collect the errors out of several lookup results.
 *
 * @param results Results of `resolveExtensionId` or `resolvePublisherId`.
 * @returns The errors among them, in order.
 */
export function errorsOf(
  ...results: readonly ({ id: string } | { error: Error })[]
): readonly Error[] {
  return results.flatMap((result) => ('error' in result ? [result.error] : []));
}
