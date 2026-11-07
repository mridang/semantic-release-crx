import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';
import { fromBase64 } from './utils/base64.js';
import { readEnv } from './utils/env.js';
import { signJwt } from './utils/jwt.js';
import { isPercentage } from './utils/math.js';
import { isRecord } from './utils/object.js';
import { nowSeconds } from './utils/time.js';

export interface HttpResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Perform a request and decode a JSON (or fall back to text) response. The
 * request is aborted after `timeoutMs`. Read requests are retried a few times
 * on throttling, server errors and network failures; requests that change
 * state are never retried, so an upload or a publish cannot run twice.
 *
 * @param url Absolute URL to call.
 * @param init Request options passed to `fetch`.
 * @param options Timeout in milliseconds, and the number of retries for
 * idempotent requests.
 * @returns The status and decoded body.
 * @throws If the network call fails after the allowed attempts. The message
 * never contains request headers or bodies.
 */
export async function request(
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<HttpResult> {
  const { timeoutMs = 60000, retries = 0 } = options;
  const attempt = async (left: number): Promise<HttpResult> => {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const body = (() => {
        try {
          return text === '' ? undefined : (JSON.parse(text) as unknown);
        } catch {
          return text.slice(0, 500);
        }
      })();
      if (RETRYABLE.has(response.status) && left > 0) {
        await sleep(500 * 2 ** (retries - left));
        return attempt(left - 1);
      }
      return { status: response.status, ok: response.ok, body };
    } catch (error) {
      if (left > 0) {
        await sleep(500 * 2 ** (retries - left));
        return attempt(left - 1);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Network error calling ${new URL(url).host}: ${reason}`);
    }
  };
  return attempt(retries);
}

const CHROME_WEBSTORE_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type Credentials =
  | { readonly kind: 'accessToken'; readonly accessToken: string }
  | {
      readonly kind: 'oauth';
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
    }
  | {
      readonly kind: 'serviceAccount';
      readonly clientEmail: string;
      readonly privateKey: string;
      readonly tokenUri: string;
    };

type Env = Readonly<Record<string, string | undefined>>;

interface ServiceAccountKey {
  readonly type?: string;
  readonly client_email?: string;
  readonly private_key?: string;
  readonly token_uri?: string;
}

/**
 * Read a service account key from the environment. `GOOGLE_SERVICE_ACCOUNT_KEY`
 * holds the key JSON, optionally base64 encoded so it survives CI secret
 * stores, and `GOOGLE_APPLICATION_CREDENTIALS` holds the path of a key file.
 *
 * @param env Environment variables.
 * @returns The parsed key, or undefined when none is configured.
 * @throws If a key is configured but unusable.
 */
async function readServiceAccount(
  env: Env,
): Promise<Extract<Credentials, { kind: 'serviceAccount' }> | undefined> {
  const inline = readEnv(env, 'GOOGLE_SERVICE_ACCOUNT_KEY');
  const path = readEnv(env, 'GOOGLE_APPLICATION_CREDENTIALS');
  if (!inline && !path) {
    return undefined;
  }
  const source = inline
    ? 'GOOGLE_SERVICE_ACCOUNT_KEY'
    : 'GOOGLE_APPLICATION_CREDENTIALS';
  const raw = inline
    ? inline.startsWith('{')
      ? inline
      : fromBase64(inline)
    : await readFile(path as string, 'utf8').catch(() => {
        throw new SemanticReleaseError(
          `GOOGLE_APPLICATION_CREDENTIALS points at a file that cannot be read.`,
          'ESERVICEACCOUNT',
        );
      });
  const key = (() => {
    try {
      return JSON.parse(raw) as ServiceAccountKey;
    } catch {
      throw new SemanticReleaseError(
        `${source} does not contain valid JSON for a service account key.`,
        'ESERVICEACCOUNT',
      );
    }
  })();
  if (key.type === 'external_account') {
    throw new SemanticReleaseError(
      `${source} is a workload identity federation credential file, which this plugin cannot exchange itself. Add "token_format: access_token" and "access_token_scopes: ${CHROME_WEBSTORE_SCOPE}" to google-github-actions/auth and export its access_token output as CHROME_ACCESS_TOKEN.`,
      'ESERVICEACCOUNT',
    );
  }
  if (!key.client_email || !key.private_key) {
    throw new SemanticReleaseError(
      `${source} is missing client_email or private_key; it must be a service account key.`,
      'ESERVICEACCOUNT',
    );
  }
  return {
    kind: 'serviceAccount',
    clientEmail: key.client_email,
    privateKey: key.private_key,
    tokenUri: key.token_uri ?? TOKEN_URL,
  };
}

/**
 * Work out which credentials to use. In order of preference: a ready made
 * access token (`CHROME_ACCESS_TOKEN`, for example from
 * `google-github-actions/auth` with workload identity federation), the OAuth
 * client triple the original plugin used (`GOOGLE_CLIENT_ID`,
 * `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`), then a service account key.
 *
 * @param env Environment variables, normally `context.env`.
 * @returns The credentials to authenticate with.
 * @throws An aggregate error naming everything that is missing.
 */
export async function resolveCredentials(env: Env): Promise<Credentials> {
  const accessToken = readEnv(env, 'CHROME_ACCESS_TOKEN');
  if (accessToken) {
    return { kind: 'accessToken', accessToken };
  }
  const clientId = readEnv(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = readEnv(env, 'GOOGLE_CLIENT_SECRET');
  const refreshToken = readEnv(env, 'GOOGLE_REFRESH_TOKEN');
  if (refreshToken?.startsWith('{')) {
    throw new SemanticReleaseError(
      'GOOGLE_REFRESH_TOKEN contains a JSON object. Set it to the value of the "refresh_token" field only, not the whole token response.',
      'EREFRESHTOKENFORMAT',
    );
  }
  if (clientId && clientSecret && refreshToken) {
    return { kind: 'oauth', clientId, clientSecret, refreshToken };
  }
  const serviceAccount = await readServiceAccount(env);
  if (serviceAccount) {
    return serviceAccount;
  }
  const missing = [
    [clientId, 'GOOGLE_CLIENT_ID', 'EGOOGLECLIENTID'],
    [clientSecret, 'GOOGLE_CLIENT_SECRET', 'EGOOGLECLIENTSECRET'],
    [refreshToken, 'GOOGLE_REFRESH_TOKEN', 'EGOOGLEREFRESHTOKEN'],
  ] as const;
  if (clientId || clientSecret || refreshToken) {
    throw new AggregateError(
      missing
        .filter(([value]) => !value)
        .map(
          ([, name, code]) =>
            new SemanticReleaseError(
              `Environment variable not found: ${name}. Check the README.md for config info.`,
              code,
            ),
        ),
    );
  }
  throw new SemanticReleaseError(
    'No Chrome Web Store credentials found. Set CHROME_ACCESS_TOKEN, or GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN, or GOOGLE_SERVICE_ACCOUNT_KEY. Check the README.md for config info.',
    'ENOCREDENTIALS',
  );
}

/**
 * Describe a failed token exchange without echoing any secret. Google answers
 * with `error` and `error_description`; only those are used.
 *
 * @param status HTTP status of the token endpoint.
 * @param body Decoded response body.
 * @param credentials The credentials that were exchanged.
 * @returns An error with guidance for the common causes.
 */
function tokenError(
  status: number,
  body: unknown,
  credentials: Credentials,
): Error {
  const fields = (isRecord(body) ? body : {}) as {
    error?: unknown;
    error_description?: unknown;
  };
  const reason = `${String(fields.error ?? status)}${
    fields.error_description ? `: ${String(fields.error_description)}` : ''
  }`;
  if (fields.error === 'invalid_grant' && credentials.kind === 'oauth') {
    return new SemanticReleaseError(
      `Google rejected GOOGLE_REFRESH_TOKEN (${reason}). The token was revoked or has expired. Refresh tokens issued while the OAuth consent screen is in "Testing" mode expire after 7 days, and tokens also expire after six months without use or when the Google account password changes. Set the consent screen to "In production" and generate a new refresh token, or avoid refresh tokens entirely with workload identity federation (see the README).`,
      'EREFRESHTOKEN',
    );
  }
  if (fields.error === 'invalid_client') {
    return new SemanticReleaseError(
      `Google rejected the OAuth client (${reason}). Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.`,
      'EGOOGLECLIENT',
    );
  }
  return new SemanticReleaseError(
    `Could not obtain a Chrome Web Store access token (${reason}). Check the credentials, and that the Chrome Web Store API is enabled for the project.`,
    'EAUTH',
  );
}

/**
 * Build the signed assertion Google exchanges for a service account token.
 *
 * @param account Service account details.
 * @returns A compact RS256 JWT.
 */
function signAssertion(
  account: Extract<Credentials, { kind: 'serviceAccount' }>,
): string {
  const iat = nowSeconds();
  return signJwt(
    {
      iss: account.clientEmail,
      scope: CHROME_WEBSTORE_SCOPE,
      aud: account.tokenUri,
      iat,
      exp: iat + 3600,
    },
    account.privateKey,
  );
}

/**
 * Turn credentials into a bearer token for the Chrome Web Store API. An access
 * token is returned as is; the other kinds are exchanged with Google. Nothing
 * here is ever logged.
 *
 * @param credentials Credentials from `resolveCredentials`.
 * @returns A short lived OAuth access token.
 * @throws If Google refuses the exchange.
 */
export async function getAccessToken(
  credentials: Credentials,
): Promise<string> {
  if (credentials.kind === 'accessToken') {
    return credentials.accessToken;
  }
  const [url, form] =
    credentials.kind === 'oauth'
      ? [
          TOKEN_URL,
          {
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            refresh_token: credentials.refreshToken,
            grant_type: 'refresh_token',
          },
        ]
      : [
          credentials.tokenUri,
          {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: signAssertion(credentials),
          },
        ];
  const response = await request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    },
    { retries: 2 },
  ).catch((error: unknown) => {
    throw new SemanticReleaseError(
      `Could not reach Google to obtain an access token. ${(error as Error).message}`,
      'EAUTH',
    );
  });
  const token = (response.body as { access_token?: unknown } | undefined)
    ?.access_token;
  if (!response.ok || typeof token !== 'string' || token === '') {
    throw tokenError(response.status, response.body, credentials);
  }
  return token;
}

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
  readonly uploadState?: UploadState;
  readonly crxVersion?: string;
  readonly itemId?: string;
}

interface ItemRevisionStatus {
  readonly state?: ItemState;
  readonly distributionChannels?: readonly {
    readonly deployPercentage?: number;
    readonly crxVersion?: string;
  }[];
}

export interface StatusResponse {
  readonly lastAsyncUploadState?: UploadState;
  readonly submittedItemRevisionStatus?: ItemRevisionStatus;
  readonly publishedItemRevisionStatus?: ItemRevisionStatus;
  readonly takenDown?: boolean;
  readonly warned?: boolean;
}

export interface PublishRequest {
  readonly publishType: 'DEFAULT_PUBLISH' | 'STAGED_PUBLISH';
  readonly deployInfos?: readonly { readonly deployPercentage: number }[];
  readonly skipReview?: boolean;
  readonly blockOnWarnings?: boolean;
}

export interface PublishResponse {
  readonly state?: ItemState;
  readonly warningInfo?: {
    readonly warnings?: readonly {
      readonly reason?: string;
      readonly description?: string;
    }[];
  };
}

export interface RollbackRequest {
  /** Why the rollback is made; shown in the Developer Dashboard. */
  readonly rollbackReason: string;
  /** The version to assign to the package being rolled back to. */
  readonly newVersion: string;
  /** The previously published version to roll back to. */
  readonly targetCrxVersion?: string;
  /** Validate only, without starting the rollback. */
  readonly validateOnly?: boolean;
}

export interface ClientOptions {
  readonly publisherId: string;
  readonly extensionId: string;
  readonly accessToken: string;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly log?: (message: string) => void;
}

const ACCEPTED_STATES: readonly ItemState[] = [
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
];

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

const ACTION_HINTS: Readonly<Record<string, string>> = {
  'cancel submission':
    'Only an item with an active submission can be cancelled.',
  'deploy percentage update':
    'The percentage must be larger than the current target percentage, and the store only allows this for items with over 10,000 seven-day active users.',
  rollback:
    'newVersion must be higher than the currently published version, rollbackReason is required, and targetCrxVersion must be a previously published version.',
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
  const envelope = (isRecord(result.body) ? result.body : {}) as {
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
  return new SemanticReleaseError(
    `Chrome Web Store ${action} failed with HTTP ${result.status}${
      detail?.status ? ` ${detail.status}` : ''
    }: ${text}${reasons.length ? ` (${reasons.join(', ')})` : ''}. ${hint}${
      result.status === 400 || result.status === 403
        ? ` ${ACTION_HINTS[action] ?? ''}`.trimEnd()
        : ''
    }`,
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

  private headers(
    extra: Readonly<Record<string, string>> = {},
  ): Readonly<Record<string, string>> {
    return { Authorization: `Bearer ${this.options.accessToken}`, ...extra };
  }

  private async call(
    action: string,
    url: string,
    init: NonNullable<Parameters<typeof fetch>[1]>,
    options: { retries?: number; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const result = await request(url, init, options).catch((error: unknown) => {
      throw new SemanticReleaseError(
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
      this.options.log?.(
        'Upload is being processed, waiting for it to finish...',
      );
      await this.waitForUpload();
      return response;
    }
    throw new SemanticReleaseError(
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
    const poll = async (): Promise<void> => {
      await sleep(this.options.pollIntervalMs);
      const state = (await this.fetchStatus()).lastAsyncUploadState;
      if (state === 'SUCCEEDED') {
        return;
      }
      if (state === 'FAILED') {
        throw new SemanticReleaseError(
          'Chrome Web Store failed to process the uploaded package. Open the item in the Developer Dashboard to see why, for example an invalid manifest or a version that is not higher than the published one.',
          'EUPLOADFAILED',
        );
      }
      if (Date.now() >= deadline) {
        throw new SemanticReleaseError(
          `The upload had not finished after ${this.options.pollTimeoutMs} ms (last state: ${state ?? 'unknown'}). Nothing was published. Raise pollTimeoutMs or check the Developer Dashboard.`,
          'EUPLOADTIMEOUT',
        );
      }
      return poll();
    };
    return poll();
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

  /**
   * Whether an earlier submission is still waiting for review, which can make
   * the store refuse a new upload or submission.
   *
   * @returns True when the item's submitted revision is `PENDING_REVIEW`.
   */
  async hasPendingSubmission(): Promise<boolean> {
    return (
      (await this.fetchStatus()).submittedItemRevisionStatus?.state ===
      'PENDING_REVIEW'
    );
  }

  /**
   * Submit the uploaded package and judge the answer. Every warning is logged.
   * A warning that is not in `ignoredWarnings` fails the call when
   * `failOnWarnings` is set, and so does a state other than pending review,
   * staged or published. Both checks happen after the store has accepted the
   * request, so a failure here can leave a submission in place.
   *
   * @param body Publish options.
   * @param policy Which warnings are ignored and whether others are fatal.
   * @returns The state of the submission.
   * @throws With `EPUBLISHSTATE` for an unacceptable state, or one error per
   * blocking warning.
   */
  async submit(
    body: PublishRequest,
    policy: {
      readonly ignoredWarnings: readonly string[];
      readonly failOnWarnings: boolean;
    },
  ): Promise<ItemState> {
    const result = await this.publish(body);
    const warnings = result.warningInfo?.warnings ?? [];
    warnings.forEach((warning) =>
      this.options.log?.(
        `${warning.reason ?? 'WARNING'}: ${warning.description ?? ''}`,
      ),
    );
    const blocking = warnings.filter(
      (warning) => !policy.ignoredWarnings.includes(warning.reason ?? ''),
    );
    if (policy.failOnWarnings && blocking.length > 0) {
      throw new AggregateError(
        blocking.map(
          (warning) =>
            new SemanticReleaseError(
              warning.description ?? 'Warning',
              warning.reason ?? 'EWARNING',
            ),
        ),
      );
    }
    if (!result.state || !ACCEPTED_STATES.includes(result.state)) {
      throw new SemanticReleaseError(
        `Chrome Web Store did not accept the submission (state ${result.state ?? 'unknown'}). Open the item in the Developer Dashboard to see why.`,
        'EPUBLISHSTATE',
      );
    }
    return result.state;
  }

  private async postJson(
    action: string,
    operation: string,
    body: unknown,
  ): Promise<unknown> {
    return this.call(action, `${API}/v2/${this.name}:${operation}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
  }

  /**
   * Cancel the item's active submission (`items.cancelSubmission`), for
   * example one that is still waiting for review.
   */
  async cancelSubmission(): Promise<void> {
    await this.postJson('cancel submission', 'cancelSubmission', {});
  }

  /**
   * Raise the rollout of the published revision
   * (`items.setPublishedDeployPercentage`) without a new review. The store
   * requires the value to be larger than the current target and only allows
   * it for items with over 10,000 seven-day active users.
   *
   * @param deployPercentage Whole number between 0 and 100.
   */
  async setPublishedDeployPercentage(deployPercentage: number): Promise<void> {
    await this.postJson(
      'deploy percentage update',
      'setPublishedDeployPercentage',
      {
        deployPercentage,
      },
    );
  }

  /**
   * Roll the published package back to an earlier one (`items.rollback`).
   *
   * @param body Rollback request.
   */
  async rollback(body: RollbackRequest): Promise<void> {
    await this.postJson('rollback', 'rollback', body);
  }
}

export interface ConnectionOptions {
  /** Publisher ID from the Developer Dashboard. */
  readonly publisherId: string;
  /** The 32 letter item ID. */
  readonly extensionId: string;
  /**
   * Environment to read credentials from, with the same variables the plugin
   * uses (`CHROME_ACCESS_TOKEN`, the `GOOGLE_*` OAuth triple or a service
   * account key). Defaults to `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives progress messages. Silent by default. */
  readonly log?: (message: string) => void;
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
  if (!isPercentage(deployPercentage)) {
    throw new SemanticReleaseError(
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
    throw new SemanticReleaseError(
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
