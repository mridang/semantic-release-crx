import { crxError } from './errors.js';
import { request, sleep, type HttpResult } from './http.js';

const API = 'https://chromewebstore.googleapis.com';

type UploadState =
  | 'UPLOAD_STATE_UNSPECIFIED'
  | 'SUCCEEDED'
  | 'IN_PROGRESS'
  | 'FAILED'
  | 'NOT_FOUND';

export type ItemState =
  | 'ITEM_STATE_UNSPECIFIED'
  | 'PENDING_REVIEW'
  | 'STAGED'
  | 'PUBLISHED'
  | 'PUBLISHED_TO_TESTERS'
  | 'REJECTED'
  | 'CANCELLED';

export interface UploadResponse {
  uploadState?: UploadState;
  crxVersion?: string;
  itemId?: string;
}

interface ItemRevisionStatus {
  state?: ItemState;
  distributionChannels?: { deployPercentage?: number; crxVersion?: string }[];
}

export interface StatusResponse {
  lastAsyncUploadState?: UploadState;
  submittedItemRevisionStatus?: ItemRevisionStatus;
  publishedItemRevisionStatus?: ItemRevisionStatus;
  takenDown?: boolean;
  warned?: boolean;
}

export interface PublishRequest {
  publishType: 'DEFAULT_PUBLISH' | 'STAGED_PUBLISH';
  deployInfos?: { deployPercentage: number }[];
  skipReview?: boolean;
  blockOnWarnings?: boolean;
}

export interface PublishResponse {
  state?: ItemState;
  warningInfo?: { warnings?: { reason?: string; description?: string }[] };
}

export interface ClientOptions {
  publisherId: string;
  extensionId: string;
  accessToken: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  log: (message: string) => void;
}

const HINTS: Record<number, [string, string]> = {
  400: [
    'EWEBSTOREBADREQUEST',
    'Open the item in the Chrome Web Store Developer Dashboard and fix anything it reports: the Store listing, Privacy and Distribution tabs must be complete, the manifest version must be higher than the published one, and an item with a submission already in review cannot be updated.',
  ],
  401: [
    'EWEBSTOREAUTH',
    'The access token was rejected. It may have expired (they last about an hour): obtain it right before the release, or use a refresh token or service account instead.',
  ],
  403: [
    'EWEBSTOREPERMISSION',
    'The account behind the credentials is not allowed to manage this item. Add the service account or Google account as a member of the publisher, check the publisherId, and make sure the Chrome Web Store API is enabled in the Google Cloud project.',
  ],
  404: [
    'EWEBSTORENOTFOUND',
    'The item was not found. Check publisherId and extensionId. The item must already exist (create a draft in the Developer Dashboard first).',
  ],
};

/**
 * Turn an error response into an error that says what failed and what to
 * check. Only the fields of Google's error envelope are used, never request
 * headers or bodies, so credentials cannot leak into a message.
 *
 * @param action What was being attempted, for example `upload`.
 * @param result The failed response.
 * @returns An error to throw.
 */
function failure(action: string, result: HttpResult): Error {
  const envelope = (
    typeof result.body === 'object' && result.body !== null ? result.body : {}
  ) as {
    error?: {
      message?: string;
      status?: string;
      details?: { reason?: string }[];
    };
  };
  const detail = envelope.error;
  const reasons = (detail?.details ?? [])
    .map((entry) => entry.reason)
    .filter((reason): reason is string => typeof reason === 'string');
  const text =
    detail?.message ??
    (typeof result.body === 'string' ? result.body : 'no error message');
  const [code, hint] = HINTS[result.status] ?? [
    'EWEBSTOREHTTP',
    'Check the Chrome Web Store status and the Developer Dashboard.',
  ];
  return crxError(
    `Chrome Web Store ${action} failed with HTTP ${result.status}${
      detail?.status ? ` ${detail.status}` : ''
    }: ${text}${reasons.length ? ` (${reasons.join(', ')})` : ''}. ${hint}`,
    code,
  );
}

/**
 * Client for the Chrome Web Store API V2 (`chromewebstore.googleapis.com`).
 */
export class WebStoreClient {
  private readonly name: string;

  constructor(private readonly options: ClientOptions) {
    this.name = `publishers/${encodeURIComponent(options.publisherId)}/items/${encodeURIComponent(options.extensionId)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.options.accessToken}`, ...extra };
  }

  private async call(
    action: string,
    url: string,
    init: NonNullable<Parameters<typeof fetch>[1]>,
    options: { retries?: number; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const result = await request(url, init, options).catch((error: unknown) => {
      throw crxError(
        `Chrome Web Store ${action} failed. ${(error as Error).message}`,
        'EWEBSTORENETWORK',
      );
    });
    if (!result.ok) {
      throw failure(action, result);
    }
    return result.body ?? {};
  }

  /**
   * Fetch the status of the item (`items.fetchStatus`). Also the cheapest
   * authenticated call, so it doubles as the credentials check.
   *
   * @returns The decoded status.
   */
  async fetchStatus(): Promise<StatusResponse> {
    return (await this.call(
      'status check',
      `${API}/v2/${this.name}:fetchStatus`,
      { method: 'GET', headers: this.headers() },
      { retries: 3, timeoutMs: 60000 },
    )) as StatusResponse;
  }

  /**
   * Upload a package (`media.upload`) and wait until it has been processed.
   * Large packages are processed asynchronously, in which case the status is
   * polled until it settles or the timeout passes.
   *
   * @param zip The zip file contents.
   * @returns The successful upload response.
   * @throws If the upload fails, is not found, or does not finish in time.
   */
  async upload(zip: Buffer): Promise<UploadResponse> {
    const response = (await this.call(
      'upload',
      `${API}/upload/v2/${this.name}:upload`,
      {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/zip',
          'Content-Length': String(zip.length),
        }),
        body: new Uint8Array(zip),
      },
      { timeoutMs: 600000 },
    )) as UploadResponse;
    if (response.uploadState === 'SUCCEEDED') {
      return response;
    }
    if (response.uploadState === 'IN_PROGRESS') {
      this.options.log(
        'Upload is being processed, waiting for it to finish...',
      );
      await this.waitForUpload();
      return response;
    }
    throw crxError(
      response.uploadState === 'NOT_FOUND'
        ? 'Chrome Web Store reported the item as not found while uploading. Check publisherId and extensionId, and that the item already exists as a draft in the Developer Dashboard.'
        : `Chrome Web Store upload ended in state ${response.uploadState ?? 'unknown'}. Open the item in the Developer Dashboard to see why the package was rejected, for example an invalid manifest or a version that is not higher than the published one.`,
      response.uploadState === 'NOT_FOUND'
        ? 'EWEBSTORENOTFOUND'
        : 'EUPLOADFAILED',
    );
  }

  private async waitForUpload(): Promise<void> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    for (;;) {
      await sleep(this.options.pollIntervalMs);
      const status = await this.fetchStatus();
      const state = status.lastAsyncUploadState;
      if (state === 'SUCCEEDED') {
        return;
      }
      if (state === 'FAILED') {
        throw crxError(
          'Chrome Web Store failed to process the uploaded package. Open the item in the Developer Dashboard to see why, for example an invalid manifest or a version that is not higher than the published one.',
          'EUPLOADFAILED',
        );
      }
      if (Date.now() >= deadline) {
        throw crxError(
          `The upload had not finished after ${this.options.pollTimeoutMs} ms (last state: ${state ?? 'unknown'}). Nothing was published. Raise pollTimeoutMs or check the Developer Dashboard.`,
          'EUPLOADTIMEOUT',
        );
      }
    }
  }

  /**
   * Submit the uploaded package for publishing (`items.publish`).
   *
   * @param body Publish options.
   * @returns The submission state and any warnings.
   */
  async publish(body: PublishRequest): Promise<PublishResponse> {
    return (await this.call('publish', `${API}/v2/${this.name}:publish`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })) as PublishResponse;
  }
}
