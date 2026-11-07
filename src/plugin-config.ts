// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';
import { readEnv } from './utils/env.js';
import { isPercentage } from './utils/math.js';
import { isRecord } from './utils/object.js';

/**
 * The audience a submission is published to. `default` and `trustedTesters`
 * are the original plugin's values; `staged` is new in the V2 API.
 */
export type PublishTarget =
  | 'default'
  | 'trustedTesters'
  | 'draft'
  | 'local'
  | 'staged';

/**
 * What to do when the version being released is a semver pre-release such as
 * `1.2.3-beta.4`.
 */
export type PrereleaseMode = 'convert' | 'skip' | 'reject';

export interface CrxPluginConfig {
  /**
   * Chrome Web Store item ID (32 letters), or a map from semantic-release
   * branch name to item ID so that pre-release branches can publish to a
   * separate staging item. A branch missing from the map is an error.
   */
  readonly extensionId?: string | Readonly<Record<string, string>>;

  /**
   * Publisher ID from the Developer Dashboard (Account → Publisher ID). Can
   * also be supplied through the `CHROME_PUBLISHER_ID` environment variable.
   */
  readonly publisherId?: string;

  /**
   * Path of the zip file to create in `prepare` and upload in `publish`.
   * Parsed as a lodash template with `branch`, `lastRelease`, `nextRelease`
   * and `commits` available.
   */
  readonly asset?: string;

  /**
   * Folder that is zipped. Defaults to `dist`.
   */
  readonly distFolder?: string;

  /**
   * Manifest that receives the new version. Defaults to
   * `<distFolder>/manifest.json`.
   */
  readonly manifestPath?: string;

  /**
   * Further manifests, for example the source manifest that is committed to
   * git, that receive the same version as `manifestPath`.
   */
  readonly additionalManifests?: readonly string[];

  /**
   * `default` publishes after review, `staged` publishes to the staging area
   * once approved, `draft` uploads without submitting, `local` neither
   * contacts nor needs the store. `trustedTesters` is accepted for
   * compatibility and behaves like `default`.
   */
  readonly target?: PublishTarget;

  /**
   * How pre-release versions are handled. Defaults to `convert`.
   */
  readonly prerelease?: PrereleaseMode;

  /**
   * Initial rollout percentage (0 to 100) for the published revision.
   */
  readonly deployPercentage?: number;

  /**
   * Cancel a submission that is still waiting for review before uploading, so
   * a new release is not refused because of it. Off by default.
   */
  readonly cancelPendingSubmission?: boolean;

  /**
   * Rollout percentage (0 to 100) to raise the published revision to when
   * semantic-release promotes a release to another channel (`addChannel`).
   * Nothing happens when unset.
   */
  readonly promoteDeployPercentage?: number;

  /**
   * Ask the store to skip review when the item qualifies.
   */
  readonly skipReview?: boolean;

  /**
   * Fail the release when the store returns a warning that is not in
   * `ignoredWarnings`. Warnings are only logged by default.
   */
  readonly failOnWarnings?: boolean;

  /**
   * Warning reasons that never fail the release. Defaults to
   * `['PUBLISHED_WITH_FRICTION_WARNING']`.
   */
  readonly ignoredWarnings?: readonly string[];

  /**
   * Time between upload status checks, in milliseconds. Defaults to 5000.
   */
  readonly pollIntervalMs?: number;

  /**
   * Longest wait for an asynchronous upload, in milliseconds. Defaults to
   * 300000.
   */
  readonly pollTimeoutMs?: number;
}

/**
 * The parts of the semantic-release step context this plugin reads.
 */
export interface StepContext {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger: {
    readonly log: (...args: unknown[]) => void;
    readonly warn?: (...args: unknown[]) => void;
  };
  readonly branch?: {
    readonly name?: string;
    readonly prerelease?: string | boolean;
    readonly [k: string]: unknown;
  };
  readonly lastRelease?: Record<string, unknown>;
  readonly nextRelease?: { version?: string; readonly [k: string]: unknown };
  readonly commits?: readonly unknown[];
}

/**
 * Warning reasons ignored unless configured otherwise. This is the whitelist
 * carried over from the original plugin.
 */
export const DEFAULT_IGNORED_WARNINGS = ['PUBLISHED_WITH_FRICTION_WARNING'];

export const DEFAULT_DIST_FOLDER = 'dist';

export const DEFAULT_POLL_INTERVAL_MS = 5000;

export const DEFAULT_POLL_TIMEOUT_MS = 300000;

/**
 * The manifest path to use when none is configured.
 *
 * @param config Plugin configuration.
 * @returns The configured manifest path or `<distFolder>/manifest.json`.
 */
export function manifestPathOf(config: CrxPluginConfig): string {
  return (
    config.manifestPath ??
    `${config.distFolder ?? DEFAULT_DIST_FOLDER}/manifest.json`
  );
}

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
  if (isRecord(extensionId)) {
    const branch = context.branch?.name;
    const id =
      branch !== undefined && Object.hasOwn(extensionId, branch)
        ? extensionId[branch]
        : undefined;
    return id
      ? { id }
      : {
          error: new SemanticReleaseError(
            `Option 'extensionId' maps branches to extension IDs, but has no entry for the branch "${branch ?? 'unknown'}". Add one, or use a single extensionId. Check the README.md for config info.`,
            'EEXTENSIONIDBRANCH',
          ),
        };
  }
  return {
    error: new SemanticReleaseError(
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
    readEnv(context.env ?? process.env, 'CHROME_PUBLISHER_ID');
  return id
    ? { id }
    : {
        error: new SemanticReleaseError(
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
          new SemanticReleaseError(
            "Option 'asset' was not included in the config. Check the README.md for config info.",
            'ENOASSET',
          ),
        ]
      : []),
    ...(config.target !== undefined && !TARGETS.includes(config.target)
      ? [
          new SemanticReleaseError(
            `Option 'target' must be one of ${TARGETS.join(', ')}, not "${String(config.target)}".`,
            'EINVALIDTARGET',
          ),
        ]
      : []),
    ...(config.prerelease !== undefined &&
    !PRERELEASE_MODES.includes(config.prerelease)
      ? [
          new SemanticReleaseError(
            `Option 'prerelease' must be one of ${PRERELEASE_MODES.join(', ')}, not "${String(config.prerelease)}".`,
            'EINVALIDPRERELEASE',
          ),
        ]
      : []),
    ...(['deployPercentage', 'promoteDeployPercentage'] as const).flatMap(
      (name) => {
        const percentage = config[name];
        return percentage !== undefined && !isPercentage(percentage)
          ? [
              new SemanticReleaseError(
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
