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
  extensionId?: string | Record<string, string>;

  /**
   * Publisher ID from the Developer Dashboard (Account → Publisher ID). Can
   * also be supplied through the `CHROME_PUBLISHER_ID` environment variable.
   */
  publisherId?: string;

  /**
   * Path of the zip file to create in `prepare` and upload in `publish`.
   * Parsed as a lodash template with `branch`, `lastRelease`, `nextRelease`
   * and `commits` available.
   */
  asset?: string;

  /**
   * Folder that is zipped. Defaults to `dist`.
   */
  distFolder?: string;

  /**
   * Manifest that receives the new version. Defaults to
   * `<distFolder>/manifest.json`.
   */
  manifestPath?: string;

  /**
   * Further manifests, for example the source manifest that is committed to
   * git, that receive the same version as `manifestPath`.
   */
  additionalManifests?: string[];

  /**
   * `default` publishes after review, `staged` publishes to the staging area
   * once approved, `draft` uploads without submitting, `local` neither
   * contacts nor needs the store. `trustedTesters` is accepted for
   * compatibility and behaves like `default`.
   */
  target?: PublishTarget;

  /**
   * How pre-release versions are handled. Defaults to `convert`.
   */
  prerelease?: PrereleaseMode;

  /**
   * Initial rollout percentage (0 to 100) for the published revision.
   */
  deployPercentage?: number;

  /**
   * Cancel a submission that is still waiting for review before uploading, so
   * a new release is not refused because of it. Off by default.
   */
  cancelPendingSubmission?: boolean;

  /**
   * Rollout percentage (0 to 100) to raise the published revision to when
   * semantic-release promotes a release to another channel (`addChannel`).
   * Nothing happens when unset.
   */
  promoteDeployPercentage?: number;

  /**
   * Ask the store to skip review when the item qualifies.
   */
  skipReview?: boolean;

  /**
   * Fail the release when the store returns a warning that is not in
   * `ignoredWarnings`. Warnings are only logged by default.
   */
  failOnWarnings?: boolean;

  /**
   * Warning reasons that never fail the release. Defaults to
   * `['PUBLISHED_WITH_FRICTION_WARNING']`.
   */
  ignoredWarnings?: string[];

  /**
   * Time between upload status checks, in milliseconds. Defaults to 5000.
   */
  pollIntervalMs?: number;

  /**
   * Longest wait for an asynchronous upload, in milliseconds. Defaults to
   * 300000.
   */
  pollTimeoutMs?: number;
}

/**
 * The parts of the semantic-release step context this plugin reads.
 */
export interface StepContext {
  cwd?: string;
  env?: Record<string, string | undefined>;
  logger: {
    log: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
  branch?: {
    name?: string;
    prerelease?: string | boolean;
    [k: string]: unknown;
  };
  lastRelease?: Record<string, unknown>;
  nextRelease?: { version?: string; [k: string]: unknown };
  commits?: unknown[];
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
