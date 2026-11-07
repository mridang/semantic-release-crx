import { recordingLogger } from './logger.js';

const BASE = 'https://chromewebstore.googleapis.com';
const ITEM = 'publishers/pub-1/items/ext-1';
export const UPLOAD = `POST ${BASE}/upload/v2/${ITEM}:upload`;
export const STATUS = `GET ${BASE}/v2/${ITEM}:fetchStatus`;
export const PUBLISH = `POST ${BASE}/v2/${ITEM}:publish`;
export const TOKEN = 'POST https://oauth2.googleapis.com/token';

export const CONFIG = {
  extensionId: 'ext-1',
  publisherId: 'pub-1',
  asset: 'ext-v${nextRelease.version}.zip',
  pollIntervalMs: 1,
  pollTimeoutMs: 100,
};

/**
 * Build a semantic-release context for a step.
 *
 * @param extra Properties to add or override.
 * @returns The context and the lines logged through it.
 */
export function stepContext(extra: Record<string, unknown> = {}): {
  context: Record<string, unknown> & {
    logger: ReturnType<typeof recordingLogger>['logger'];
  };
  lines: string[];
} {
  const { logger, lines } = recordingLogger();
  return {
    lines,
    context: {
      logger,
      env: { CHROME_ACCESS_TOKEN: 'SECRET-TOKEN' },
      branch: { name: 'main' },
      lastRelease: {},
      nextRelease: { version: '1.1.0' },
      commits: [],
      ...extra,
    },
  };
}
