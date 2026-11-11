import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import SemanticReleaseError from '@semantic-release/error';
import {
  EnvHttpProxyAgent,
  RetryAgent,
  request as send,
  type Dispatcher,
} from 'undici';
import { fromBase64 } from './utils/base64.js';
import { codeOf, messageOf } from './utils/error.js';
import { readEnv } from './utils/env.js';
import { signJwt } from './utils/jwt.js';
import { isPercentage } from './utils/math.js';
import { booleanAt, isRecord, numberAt, stringAt } from './utils/object.js';
import { isOneOf } from './utils/union.js';
import { nowSeconds } from './utils/time.js';

/**
 * What a call to the store came back with, with the body already read.
 */
export interface HttpResult {
  /** The HTTP status. */
  readonly status: number;
  /** Whether the status is in the 2xx range. */
  readonly ok: boolean;
  /** The body: parsed JSON, else the first 500 characters of the text. */
  readonly body: unknown;

  /**
   * Where a redirect points, without its query string, which can hold a
   * secret. A redirect is never followed.
   */
  readonly location?: string;
}

// transport: shared word for word across the plugins

/**
 * Sent with every request so that the service can tell who is calling.
 */
const USER_AGENT = 'semantic-release-crx';

/**
 * The longest a whole call may take, retries and back-off included, unless
 * the call says otherwise.
 */
const DEADLINE_MS = 120_000;

/**
 * The longest a single attempt may wait for the response headers or the body,
 * unless the call says otherwise. An attempt that stalls is abandoned and
 * retried.
 */
const ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * The longest wait between two attempts, which also caps a `Retry-After`
 * header. It is never more than a quarter of the deadline. A wait in progress
 * when the deadline passes is cancelled.
 */
const MAX_BACKOFF_MS = 15_000;

/**
 * Methods that are safe to repeat. A POST is only retried when the call says
 * `retryPost`, because only the caller knows that repeating it is harmless.
 */
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/**
 * The statuses that are worth another attempt: throttling and server errors.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * How many redirects are followed when the call asks for it.
 */
const MAX_REDIRECTIONS = 3;

/**
 * The most of a response body that is read. Undici stops a larger body, which
 * is then reported as a failure and not repeated.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Failures worth another attempt. Naming them replaces undici's own list, so
 * it is repeated here with the resolver and timeout codes added.
 */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The code of the error that stands for a connection lost after the response
 * headers arrived.
 */
const BODY_PHASE_CODE = 'UND_ERR_BODY_PHASE';

/**
 * A connection that failed while the response body was being read. Undici
 * would resume such a response with a `Range` request, which these APIs
 * ignore; this error is not retried by the retrying agent, so that the whole
 * request is sent again instead.
 */
class BodyPhaseError extends Error {
  readonly code = BODY_PHASE_CODE;

  /**
   * @param cause - The error that undici reported.
   */
  constructor(cause: unknown) {
    super('the connection was lost while reading the response', { cause });
  }
}

/**
 * The connections to the service, from the installed `undici` (the runtime's
 * bundled undici cannot be wrapped by `RetryAgent`). They honour the
 * `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` environment variables, which are
 * read when this is called.
 * @param attemptTimeoutMs How long one attempt may wait for the response.
 * @returns A dispatcher with connection and response timeouts and a cap on
 * the size of a response.
 * @throws {SemanticReleaseError} If a proxy variable is not a valid proxy.
 * The message names the variables and never their value, which can hold a
 * password.
 */
function connections(attemptTimeoutMs: number): Dispatcher {
  try {
    return new EnvHttpProxyAgent({
      connect: { timeout: 10_000 },
      headersTimeout: attemptTimeoutMs,
      bodyTimeout: attemptTimeoutMs,
      maxResponseSize: MAX_BODY_BYTES,
      // Measured against a server that advertises a long keep-alive: without
      // this a script that has made one call stays alive for as long as the
      // server's keep-alive (about 3 seconds against Node's own server). A
      // one-shot client has no use for an idle connection.
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    });
  } catch {
    throw new SemanticReleaseError(
      'HTTP_PROXY, HTTPS_PROXY or NO_PROXY is not a valid proxy setting.',
      'EPROXY',
    );
  }
}

/**
 * Describe a failed request that got no response. The message names the host
 * and the reason, and never the URL, which can hold a secret.
 * @param error A caught value.
 * @param host The host that was called.
 * @returns An error with the reason in its message.
 */
function networkErrorFor(error: unknown, host: string): Error {
  const reason =
    isRecord(error) && error.cause !== undefined
      ? `${messageOf(error)}: ${messageOf(error.cause)}`
      : messageOf(error);
  return new Error(`Network error calling ${host}: ${reason}`);
}

/**
 * Mark a connection that fails after the response headers arrived, so that
 * the retrying agent leaves it alone (see {@link BodyPhaseError}).
 * @param dispatch The dispatch function to wrap.
 * @returns A dispatch function that wraps the handler.
 */
function markBodyFailures(
  dispatch: Dispatcher['dispatch'],
): Dispatcher['dispatch'] {
  return (options, handler) => {
    const started = new AbortController();
    return dispatch(options, {
      onRequestStart: (controller, context) =>
        handler.onRequestStart?.(controller, context),
      onRequestUpgrade: (controller, status, headers, socket) =>
        handler.onRequestUpgrade?.(controller, status, headers, socket),
      onResponseStart: (controller, status, headers, message) => {
        started.abort();
        handler.onResponseStart?.(controller, status, headers, message);
      },
      onResponseData: (controller, chunk) =>
        handler.onResponseData?.(controller, chunk),
      onResponseEnd: (controller, trailers) =>
        handler.onResponseEnd?.(controller, trailers),
      onResponseError: (controller, error) =>
        handler.onResponseError?.(
          controller,
          started.signal.aborted &&
            RETRYABLE_ERROR_CODES.has(codeOf(error) ?? '')
            ? new BodyPhaseError(error)
            : error,
        ),
    });
  };
}

/**
 * Decode a response body.
 * @param text The body as text.
 * @returns The parsed JSON, undefined for an empty body, else the first 500
 * characters of the text.
 */
function decodeBody(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

/**
 * Where a redirect points, without the query (which can hold a secret), the
 * fragment or any user info.
 * @param location The `Location` header.
 * @param base The URL that was called, for a relative `Location`.
 * @returns A URL that is safe to show, or undefined without a usable header.
 */
function placeOf(location: unknown, base: URL): string | undefined {
  if (typeof location !== 'string' || !URL.canParse(location, base.href)) {
    return undefined;
  }
  const target = new URL(location, base.href);
  return `${target.origin}${target.pathname}`;
}

/**
 * Where a redirect may be followed to. Only a GET or HEAD request is
 * followed, and only to the same origin, which rules out a change from https
 * to http and keeps the credentials from leaving for another host.
 * @param from The URL that was called.
 * @param method The method of the request.
 * @param status The status of the response.
 * @param location The `Location` header.
 * @returns The URL to call next, or undefined when the redirect is not to be
 * followed.
 */
function sameOriginRedirect(
  from: URL,
  method: string,
  status: number,
  location: unknown,
): URL | undefined {
  if (
    !['GET', 'HEAD'].includes(method) ||
    ![301, 302, 303, 307, 308].includes(status) ||
    typeof location !== 'string' ||
    !URL.canParse(location, from.href)
  ) {
    return undefined;
  }
  const next = new URL(location, from.href);
  return next.origin === from.origin ? next : undefined;
}

/**
 * Whether a failed attempt is worth another one.
 * @param error The error undici reports for the failed attempt.
 * @param method The method of the request.
 * @param methods The methods that may be repeated.
 * @param attempt Which retry this would be, starting at 1.
 * @param retries How many retries are allowed.
 * @returns True to try again.
 */
function isRetryable(
  error: unknown,
  method: string,
  methods: readonly string[],
  attempt: number,
  retries: number,
): boolean {
  if (attempt > retries || !methods.includes(method)) {
    return false;
  }
  const code = codeOf(error);
  if (
    code !== undefined &&
    code !== 'UND_ERR_REQ_RETRY' &&
    !RETRYABLE_ERROR_CODES.has(code)
  ) {
    return false;
  }
  const status = isRecord(error) ? numberAt(error, 'statusCode') : undefined;
  return status === undefined || RETRYABLE_STATUSES.has(status);
}

/**
 * How long to wait before the next attempt: what `Retry-After` asks for, else
 * exponential back-off, never more than `capMs`.
 * @param error - The error undici reports for the failed attempt.
 * @param attempt - Which retry this is, starting at 1.
 * @param minTimeoutMs The first back-off.
 * @param capMs The longest wait.
 * @returns The wait in milliseconds.
 */
function waitBeforeRetry(
  error: unknown,
  attempt: number,
  minTimeoutMs: number,
  capMs: number,
): number {
  const backoffMs = minTimeoutMs * 2 ** (attempt - 1);
  const header =
    isRecord(error) && isRecord(error.headers)
      ? stringAt(error.headers, 'retry-after')
      : undefined;
  if (header === undefined) {
    return Math.min(backoffMs, capMs);
  }
  const seconds = Number(header);
  const advisedMs = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  if (advisedMs > 0) {
    return Math.min(advisedMs, capMs);
  }
  return Math.min(backoffMs, capMs);
}

/**
 * What the caller of {@link request} can ask for.
 */
export interface HttpRequest {
  /** The HTTP method. Defaults to `GET`. */
  readonly method?: 'GET' | 'HEAD' | 'OPTIONS' | 'PUT' | 'DELETE' | 'POST';
  /** Extra headers, which replace the defaults of the same name in any case. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A text or binary body, which can be sent again if the call is retried. */
  readonly body?: string | Uint8Array;
}

/**
 * How {@link request} treats time and failure.
 */
export interface RequestOptions {
  /** The connections to use; tests pass undici's `MockAgent`. */
  readonly agent?: Dispatcher;
  /** How long one attempt may wait for the headers, then the body. */
  readonly attemptTimeoutMs?: number;
  /** How long the whole call may take, retries and back-off included. */
  readonly deadlineMs?: number;
  /** How many more attempts a retryable request gets. Zero by default. */
  readonly retries?: number;
  /** The first back-off in milliseconds, doubled for each retry. */
  readonly minTimeout?: number;

  /**
   * Allow a POST to be retried. Only for a POST that is safe to repeat, such
   * as the token exchange; an upload or a publish never sets it, and without
   * it a POST gets no retries whatever `retries` says.
   */
  readonly retryPost?: boolean;

  /**
   * Follow the redirects of a GET or HEAD request, up to three, but only to
   * the same origin. Off by default. A redirect that is not followed is
   * returned with its `location`.
   */
  readonly followRedirects?: boolean;
}

/**
 * Perform a request and decode a JSON (or fall back to text) response.
 *
 * When the request may be retried (`retries` above zero, and for a POST only
 * with `retryPost`) it goes through undici's `RetryAgent`, which retries
 * throttling (429), server errors and connection failures with exponential
 * back-off, honouring `Retry-After`; once the attempts run out the last
 * response is returned. If the connection drops while the body is being read,
 * the whole request is sent again, and each such replay gets the retries that
 * are left. Redirects are only followed when `followRedirects` is set, and
 * `Content-Encoding` is not decoded: the endpoints used here do not use it.
 *
 * The call is bounded by `deadlineMs`. When it passes, a wait for the next
 * attempt is cancelled and the connections this call created are destroyed,
 * which also stops a proxy tunnel that is still being set up.
 *
 * Undici's `request` is used rather than `fetch` because `fetch` turns a body
 * into a one-shot stream, which undici cannot send a second time..
 * @param url - Absolute URL to call.
 * @param init Method, headers and body.
 * @param options Timeouts, retries and, for tests, the connections.
 * @returns The status and decoded body.
 * @throws If the network call fails after the allowed attempts. The message
 * names the host and never contains the URL, headers or body.
 */
export async function request(
  url: string,
  init: HttpRequest,
  options: RequestOptions = {},
): Promise<HttpResult> {
  const {
    attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
    deadlineMs = DEADLINE_MS,
    minTimeout = 500,
    retryPost = false,
    followRedirects = false,
  } = options;
  const target = new URL(url);
  const method = init.method ?? 'GET';
  const retries =
    method === 'POST' && !retryPost ? 0 : Math.max(0, options.retries ?? 0);
  const methods = retryPost
    ? [...IDEMPOTENT_METHODS, 'POST']
    : IDEMPOTENT_METHODS;
  const capMs = Math.min(MAX_BACKOFF_MS, Math.floor(deadlineMs / 4));
  const own =
    options.agent === undefined ? connections(attemptTimeoutMs) : undefined;
  const base = options.agent ?? own;
  const deadline = AbortSignal.timeout(deadlineMs);
  const finished = new AbortController();
  const headers = Object.fromEntries(
    [
      ['accept', 'application/json'],
      ['user-agent', USER_AGENT],
      ...Object.entries(init.headers ?? {}),
    ].map(([name, value]) => [name.toLowerCase(), value]),
  );
  const exchange = async (
    left: number,
    where: URL,
    hops: number,
  ): Promise<HttpResult> => {
    const dispatcher =
      left > 0 && base !== undefined
        ? new RetryAgent(base.compose(markBodyFailures), {
            maxRetries: left,
            throwOnError: false,
            // Cancel the wait when the deadline passes, so that it cannot
            // hold the process after the call has given up.
            retry: (error, { state, opts }, callback) => {
              if (
                !isRetryable(error, opts.method, methods, state.counter, left)
              ) {
                callback(error);
                return;
              }
              const timer = setTimeout(
                callback,
                waitBeforeRetry(error, state.counter, minTimeout, capMs),
                null,
              );
              deadline.addEventListener('abort', () => clearTimeout(timer), {
                once: true,
                signal: finished.signal,
              });
            },
          })
        : base;
    const response = await send(where, {
      dispatcher,
      method,
      headers,
      body: init.body,
      signal: deadline,
    });
    const text = await response.body.text().catch((error: unknown) => {
      if (codeOf(error) === BODY_PHASE_CODE && left > 0) {
        return undefined;
      }
      throw error;
    });
    if (text === undefined) {
      return exchange(left - 1, where, hops);
    }
    const next = followRedirects
      ? sameOriginRedirect(
          where,
          method,
          response.statusCode,
          response.headers.location,
        )
      : undefined;
    if (next !== undefined && hops > 0) {
      return exchange(left, next, hops - 1);
    }
    const location = placeOf(response.headers.location, where);
    return {
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      body: decodeBody(text),
      ...(location === undefined ? {} : { location }),
    };
  };
  const expired = new Promise<never>((_resolve, reject) =>
    deadline.addEventListener(
      'abort',
      () => {
        // undici does not honour the signal while a proxy tunnel is being
        // set up, so the connections are torn down as well.
        void own?.destroy();
        reject(deadline.reason);
      },
      { once: true, signal: finished.signal },
    ),
  );
  const attempt = exchange(retries, target, MAX_REDIRECTIONS);
  attempt.catch(() => undefined);
  try {
    return await Promise.race([attempt, expired]);
  } catch (error) {
    throw networkErrorFor(error, target.host);
  } finally {
    finished.abort();
    await own?.destroy().catch(() => undefined);
  }
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
 * Read the fields of a service account key out of untrusted JSON.
 * @param value - Parsed JSON.
 * @returns The fields that are strings; the rest are left undefined.
 */
function parseServiceAccountKey(value: unknown): ServiceAccountKey {
  const record = isRecord(value) ? value : {};
  return {
    type: stringAt(record, 'type'),
    client_email: stringAt(record, 'client_email'),
    private_key: stringAt(record, 'private_key'),
    token_uri: stringAt(record, 'token_uri'),
  };
}

/**
 * Read a service account key from the environment. `GOOGLE_SERVICE_ACCOUNT_KEY`
 * holds the key JSON, optionally base64 encoded so it survives CI secret
 * stores, and `GOOGLE_APPLICATION_CREDENTIALS` holds the path of a key file.
 * @param env - Environment variables.
 * @returns The parsed key, or undefined when none is configured.
 * @throws If a key is configured but unusable.
 */
async function readServiceAccount(
  env: Env,
): Promise<Extract<Credentials, { kind: 'serviceAccount' }> | undefined> {
  const inline = readEnv(env, 'GOOGLE_SERVICE_ACCOUNT_KEY');
  const path = readEnv(env, 'GOOGLE_APPLICATION_CREDENTIALS');
  const source =
    inline === undefined
      ? 'GOOGLE_APPLICATION_CREDENTIALS'
      : 'GOOGLE_SERVICE_ACCOUNT_KEY';
  let raw: string | undefined;
  if (inline !== undefined) {
    raw = inline.startsWith('{') ? inline : fromBase64(inline);
  } else if (path !== undefined) {
    raw = await readFile(path, 'utf8').catch(() => {
      throw new SemanticReleaseError(
        `GOOGLE_APPLICATION_CREDENTIALS points at a file that cannot be read.`,
        'ESERVICEACCOUNT',
      );
    });
  }
  if (raw === undefined) {
    return undefined;
  }
  const key = ((): ServiceAccountKey => {
    try {
      return parseServiceAccountKey(JSON.parse(raw));
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
 * @param env - Environment variables, normally `context.env`.
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
 * @param status - HTTP status of the token endpoint.
 * @param body - Decoded response body.
 * @param credentials The credentials that were exchanged.
 * @returns An error with guidance for the common causes.
 */
function tokenError(
  status: number,
  body: unknown,
  credentials: Credentials,
): Error {
  const fields: Readonly<Record<string, unknown>> = isRecord(body) ? body : {};
  const error = stringAt(fields, 'error');
  const description = stringAt(fields, 'error_description');
  const reason = `${error ?? status}${description ? `: ${description}` : ''}`;
  if (error === 'invalid_grant' && credentials.kind === 'oauth') {
    return new SemanticReleaseError(
      `Google rejected GOOGLE_REFRESH_TOKEN (${reason}). The token was revoked or has expired. Refresh tokens issued while the OAuth consent screen is in "Testing" mode expire after 7 days, and tokens also expire after six months without use or when the Google account password changes. Set the consent screen to "In production" and generate a new refresh token, or avoid refresh tokens entirely with workload identity federation (see the README).`,
      'EREFRESHTOKEN',
    );
  }
  if (error === 'invalid_client') {
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
 * @param account - Service account details.
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
 * @param credentials - Credentials from `resolveCredentials`.
 * @param agent - The connections to use; tests pass a mock. Defaults to new ones.
 * @returns A short lived OAuth access token.
 * @throws If Google refuses the exchange.
 */
export async function getAccessToken(
  credentials: Credentials,
  agent?: Dispatcher,
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
      body: new URLSearchParams(form).toString(),
    },
    {
      agent,
      retries: 2,
      retryPost: true,
      attemptTimeoutMs: 60_000,
      deadlineMs: 180_000,
    },
  ).catch((error: unknown) => {
    throw new SemanticReleaseError(
      `Could not reach Google to obtain an access token. ${messageOf(error)}`,
      'EAUTH',
    );
  });
  const token = isRecord(response.body)
    ? stringAt(response.body, 'access_token')
    : undefined;
  if (!response.ok || token === undefined || token === '') {
    throw tokenError(response.status, response.body, credentials);
  }
  return token;
}

const API = 'https://chromewebstore.googleapis.com';

const UPLOAD_STATES = [
  'UPLOAD_STATE_UNSPECIFIED',
  'SUCCEEDED',
  'IN_PROGRESS',
  'FAILED',
  'NOT_FOUND',
] as const;

type UploadState = (typeof UPLOAD_STATES)[number];

const ITEM_STATES = [
  'ITEM_STATE_UNSPECIFIED',
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
  'REJECTED',
  'CANCELLED',
] as const;

export type ItemState = (typeof ITEM_STATES)[number];

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

/**
 * Read a field that must be one of a fixed list of strings.
 * @param values - The allowed values.
 * @param record - The object to read from.
 * @param key Property name.
 * @returns The value when it is allowed, otherwise undefined.
 */
function enumAt<const T extends readonly string[]>(
  values: T,
  record: Readonly<Record<string, unknown>>,
  key: string,
): T[number] | undefined {
  const value = record[key];
  return isOneOf(values, value) ? value : undefined;
}

/**
 * Read an upload response, keeping only the fields the plugin understands.
 * @param body - Decoded response body.
 * @returns The typed response; unknown or malformed fields are undefined.
 */
function parseUpload(body: unknown): UploadResponse {
  const record = isRecord(body) ? body : {};
  return {
    uploadState: enumAt(UPLOAD_STATES, record, 'uploadState'),
    crxVersion: stringAt(record, 'crxVersion'),
    itemId: stringAt(record, 'itemId'),
  };
}

/**
 * Read the status of one item revision.
 * @param value - Decoded property of the status response.
 * @returns The typed revision status, or undefined when absent.
 */
function parseRevision(value: unknown): ItemRevisionStatus | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    state: enumAt(ITEM_STATES, value, 'state'),
    distributionChannels: Array.isArray(value.distributionChannels)
      ? value.distributionChannels.flatMap((channel: unknown) =>
          isRecord(channel)
            ? [
                {
                  deployPercentage: numberAt(channel, 'deployPercentage'),
                  crxVersion: stringAt(channel, 'crxVersion'),
                },
              ]
            : [],
        )
      : undefined,
  };
}

/**
 * Read an item status response.
 * @param body - Decoded response body.
 * @returns The typed status; unknown or malformed fields are undefined.
 */
function parseStatus(body: unknown): StatusResponse {
  const record = isRecord(body) ? body : {};
  return {
    lastAsyncUploadState: enumAt(UPLOAD_STATES, record, 'lastAsyncUploadState'),
    submittedItemRevisionStatus: parseRevision(
      record.submittedItemRevisionStatus,
    ),
    publishedItemRevisionStatus: parseRevision(
      record.publishedItemRevisionStatus,
    ),
    takenDown: booleanAt(record, 'takenDown'),
    warned: booleanAt(record, 'warned'),
  };
}

/**
 * Read a publish response.
 * @param body - Decoded response body.
 * @returns The typed response; unknown or malformed fields are undefined.
 */
function parsePublish(body: unknown): PublishResponse {
  const record = isRecord(body) ? body : {};
  const info = isRecord(record.warningInfo) ? record.warningInfo : {};
  return {
    state: enumAt(ITEM_STATES, record, 'state'),
    warningInfo: {
      warnings: (Array.isArray(info.warnings) ? info.warnings : []).flatMap(
        (warning: unknown) =>
          isRecord(warning)
            ? [
                {
                  reason: stringAt(warning, 'reason'),
                  description: stringAt(warning, 'description'),
                },
              ]
            : [],
      ),
    },
  };
}

const DEFAULT_POLL_INTERVAL_MS = 5000;

const DEFAULT_POLL_TIMEOUT_MS = 300_000;

export interface ClientOptions {
  readonly publisherId: string;
  readonly extensionId: string;
  readonly accessToken: string;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly log?: (message: string) => void;
  /** The connections to use; tests pass undici's `MockAgent`. */
  readonly agent?: Dispatcher;
}

const ACCEPTED_STATES = [
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
] as const satisfies readonly ItemState[];

type Action =
  | 'status check'
  | 'upload'
  | 'publish'
  | 'cancel submission'
  | 'deploy percentage update'
  | 'rollback';

const HINTS: Readonly<Record<number, readonly [string, string]>> = {
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

const ACTION_HINTS: Readonly<Partial<Record<Action, string>>> = {
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
 * @param action - What was being attempted, for example `upload`.
 * @param result - The failed response.
 * @returns An error to throw.
 */
function failure(action: Action, result: HttpResult): SemanticReleaseError {
  const detail: Readonly<Record<string, unknown>> =
    isRecord(result.body) && isRecord(result.body.error)
      ? result.body.error
      : {};
  const status = stringAt(detail, 'status');
  const reasons = (Array.isArray(detail.details) ? detail.details : []).flatMap(
    (entry: unknown) => {
      const reason = isRecord(entry) ? stringAt(entry, 'reason') : undefined;
      return reason === undefined ? [] : [reason];
    },
  );
  const text =
    stringAt(detail, 'message') ??
    (typeof result.body === 'string' ? result.body : 'no error message');
  if (result.status >= 300 && result.status < 400) {
    return new SemanticReleaseError(
      `Chrome Web Store ${action} failed with HTTP ${result.status}: the request was redirected to ${result.location ?? 'no location'}. Redirects are never followed, because they could turn a state-changing call into a different request.`,
      'EWEBSTOREHTTP',
    );
  }
  const [code, hint] = HINTS[result.status] ?? [
    'EWEBSTOREHTTP',
    'Check the Chrome Web Store status and the Developer Dashboard.',
  ];
  return new SemanticReleaseError(
    `Chrome Web Store ${action} failed with HTTP ${result.status}${
      status ? ` ${status}` : ''
    }: ${text}${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}. ${hint}${
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

  /**
   * Exchange credentials for an access token and build a client with the
   * default polling settings unless overridden.
   * @param options - Item, credentials and optional polling and logging settings.
   * @returns A client holding a fresh access token.
   */
  static async connect(options: {
    readonly publisherId: string;
    readonly extensionId: string;
    readonly credentials: Credentials;
    readonly pollIntervalMs?: number;
    readonly pollTimeoutMs?: number;
    readonly log?: (message: string) => void;
    readonly agent?: Dispatcher;
  }): Promise<WebStoreClient> {
    return new WebStoreClient({
      agent: options.agent,
      publisherId: options.publisherId,
      extensionId: options.extensionId,
      accessToken: await getAccessToken(options.credentials, options.agent),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      log: options.log,
    });
  }

  private headers(
    extra: Readonly<Record<string, string>> = {},
  ): Readonly<Record<string, string>> {
    return { Authorization: `Bearer ${this.options.accessToken}`, ...extra };
  }

  private async call<T>(
    action: Action,
    url: string,
    init: HttpRequest,
    parse: (body: unknown) => T,
    options: Omit<RequestOptions, 'agent'> = {},
  ): Promise<T> {
    const result = await request(url, init, {
      agent: this.options.agent,
      attemptTimeoutMs: 60_000,
      deadlineMs: 60_000,
      ...options,
    }).catch((error: unknown) => {
      throw new SemanticReleaseError(
        `Chrome Web Store ${action} failed. ${messageOf(error)}`,
        'EWEBSTORENETWORK',
      );
    });
    if (!result.ok) {
      throw failure(action, result);
    }
    return parse(result.body);
  }

  /**
   * Fetch the status of the item (`items.fetchStatus`). Also the cheapest
   * authenticated call, so it doubles as the credentials check.
   * @returns The decoded status.
   */
  async fetchStatus(): Promise<StatusResponse> {
    return this.call(
      'status check',
      `${API}/v2/${this.name}:fetchStatus`,
      { method: 'GET', headers: this.headers() },
      parseStatus,
      { retries: 3, attemptTimeoutMs: 60_000, deadlineMs: 240_000 },
    );
  }

  /**
   * Upload a package (`media.upload`) and wait until it has been processed.
   * Large packages are processed asynchronously, in which case the status is
   * polled until it settles or the timeout passes.
   * @param zip - The zip file contents.
   * @returns The successful upload response.
   * @throws If the upload fails, is not found, or does not finish in time.
   */
  async upload(zip: Buffer): Promise<UploadResponse> {
    const response = await this.call(
      'upload',
      `${API}/upload/v2/${this.name}:upload`,
      {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/zip',
          'Content-Length': String(zip.length),
        }),
        body: zip,
      },
      parseUpload,
      { attemptTimeoutMs: 600_000, deadlineMs: 600_000 },
    );
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
   * @param body - Publish options.
   * @returns The submission state and any warnings.
   */
  async publish(body: PublishRequest): Promise<PublishResponse> {
    return this.call(
      'publish',
      `${API}/v2/${this.name}:publish`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      },
      parsePublish,
    );
  }

  /**
   * Whether an earlier submission is still waiting for review, which can make
   * the store refuse a new upload or submission.
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
   * @param body - Publish options.
   * @param policy - Which warnings are ignored and whether others are fatal.
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
    if (!isOneOf(ACCEPTED_STATES, result.state)) {
      throw new SemanticReleaseError(
        `Chrome Web Store did not accept the submission (state ${result.state ?? 'unknown'}). Open the item in the Developer Dashboard to see why.`,
        'EPUBLISHSTATE',
      );
    }
    return result.state;
  }

  private async postJson(
    action: Action,
    operation: string,
    body: object,
  ): Promise<void> {
    await this.call(
      action,
      `${API}/v2/${this.name}:${operation}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      },
      () => undefined,
    );
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
   * @param deployPercentage - Whole number between 0 and 100.
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
   * @param body - Rollback request.
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
 * @param options - Item and credentials source.
 * @returns A client with a fresh access token.
 */
async function connect(options: ConnectionOptions): Promise<WebStoreClient> {
  return WebStoreClient.connect({
    publisherId: options.publisherId,
    extensionId: options.extensionId,
    credentials: await resolveCredentials(options.env ?? process.env),
    log: options.log,
  });
}

/**
 * Fetch the status of an item.
 * @param options - Item and credentials source.
 * @returns The store's status for the item.
 */
export async function fetchStatus(
  options: ConnectionOptions,
): Promise<StatusResponse> {
  return (await connect(options)).fetchStatus();
}

/**
 * Cancel the item's active submission, for example one waiting for review.
 * @param options - Item and credentials source.
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
 * @param options - Item and credentials source, and the new percentage (a whole
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
 * @param options - Item and credentials source, plus `rollbackReason` and
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
