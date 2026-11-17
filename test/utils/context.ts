import { recordingLogger } from './logger.js';
import type { VerifyReleaseContext } from 'semantic-release';

export const BASE = 'https://chromewebstore.googleapis.com';
export const ITEM = 'publishers/pub-1/items/ext-1';
export const UPLOAD = `POST ${BASE}/upload/v2/${ITEM}:upload`;
export const STATUS = `GET ${BASE}/v2/${ITEM}:fetchStatus`;
export const PUBLISH = `POST ${BASE}/v2/${ITEM}:publish`;
export const TOKEN = 'POST https://oauth2.googleapis.com/token';

export const CONFIG = {
  extensionId: 'ext-1',
  publisherId: 'pub-1',
  // eslint-disable-next-line no-template-curly-in-string -- the plugin expands this template itself
  asset: 'ext-v${nextRelease.version}.zip',
  pollIntervalMs: 1,
  pollTimeoutMs: 100,
};

/**
 * Build a semantic-release context for a step.
 * @param extra - Properties to add or override.
 * @returns The context and the lines logged through it.
 */
export function stepContext(extra: Record<string, unknown> = {}) {
  const { logger, lines } = recordingLogger();
  return {
    lines,

    context: {
      logger,
      env: { CHROME_ACCESS_TOKEN: 'SECRET-TOKEN' },
      branch: { name: 'main' },
      lastRelease: {
        version: '1.0.0',
        gitTag: 'v1.0.0',
        channels: [],
        gitHead: 'abc122',
        name: 'v1.0.0',
      },
      nextRelease: {
        version: '1.1.0',
        type: 'minor',
        channel: 'latest',
        gitTag: 'v1.1.0',
        gitHead: 'abc123',
        name: 'v1.1.0',
      },
      commits: [],
      releases: [],
      branches: [],
      envCi: { isCi: false, commit: 'abc123', branch: 'main' },
      options: {},
      stdout: process.stdout,
      stderr: process.stderr,
      ...extra,
    } as VerifyReleaseContext,
  };
}
