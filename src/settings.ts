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
): Error[] {
  const problems: Error[] = [];
  if (requireAsset && !config.asset) {
    problems.push(
      crxError(
        "Option 'asset' was not included in the config. Check the README.md for config info.",
        'ENOASSET',
      ),
    );
  }
  if (config.target !== undefined && !TARGETS.includes(config.target)) {
    problems.push(
      crxError(
        `Option 'target' must be one of ${TARGETS.join(', ')}, not "${String(config.target)}".`,
        'EINVALIDTARGET',
      ),
    );
  }
  if (
    config.prerelease !== undefined &&
    !PRERELEASE_MODES.includes(config.prerelease)
  ) {
    problems.push(
      crxError(
        `Option 'prerelease' must be one of ${PRERELEASE_MODES.join(', ')}, not "${String(config.prerelease)}".`,
        'EINVALIDPRERELEASE',
      ),
    );
  }
  (['deployPercentage', 'promoteDeployPercentage'] as const).forEach((name) => {
    const percentage = config[name];
    if (
      percentage !== undefined &&
      !(Number.isInteger(percentage) && percentage >= 0 && percentage <= 100)
    ) {
      problems.push(
        crxError(
          `Option '${name}' must be a whole number between 0 and 100.`,
          'EINVALIDDEPLOYPERCENTAGE',
        ),
      );
    }
  });
  return problems;
}
