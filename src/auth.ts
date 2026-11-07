import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { aggregate, crxError } from './errors.js';
import { request } from './http.js';

const CHROME_WEBSTORE_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type Credentials =
  | { kind: 'accessToken'; accessToken: string }
  | {
      kind: 'oauth';
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    }
  | {
      kind: 'serviceAccount';
      clientEmail: string;
      privateKey: string;
      tokenUri: string;
    };

type Env = Record<string, string | undefined>;

interface ServiceAccountKey {
  type?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
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
  const inline = env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  const path = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!inline && !path) {
    return undefined;
  }
  const source = inline
    ? 'GOOGLE_SERVICE_ACCOUNT_KEY'
    : 'GOOGLE_APPLICATION_CREDENTIALS';
  const raw = inline
    ? inline.startsWith('{')
      ? inline
      : Buffer.from(inline, 'base64').toString('utf8')
    : await readFile(path as string, 'utf8').catch(() => {
        throw crxError(
          `GOOGLE_APPLICATION_CREDENTIALS points at a file that cannot be read.`,
          'ESERVICEACCOUNT',
        );
      });
  const key = (() => {
    try {
      return JSON.parse(raw) as ServiceAccountKey;
    } catch {
      throw crxError(
        `${source} does not contain valid JSON for a service account key.`,
        'ESERVICEACCOUNT',
      );
    }
  })();
  if (key.type === 'external_account') {
    throw crxError(
      `${source} is a workload identity federation credential file, which this plugin cannot exchange itself. Add "token_format: access_token" and "access_token_scopes: ${CHROME_WEBSTORE_SCOPE}" to google-github-actions/auth and export its access_token output as CHROME_ACCESS_TOKEN.`,
      'ESERVICEACCOUNT',
    );
  }
  if (!key.client_email || !key.private_key) {
    throw crxError(
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
  const accessToken = env.CHROME_ACCESS_TOKEN?.trim();
  if (accessToken) {
    return { kind: 'accessToken', accessToken };
  }
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();
  if (refreshToken?.startsWith('{')) {
    throw crxError(
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
    throw aggregate(
      missing
        .filter(([value]) => !value)
        .map(([, name, code]) =>
          crxError(
            `Environment variable not found: ${name}. Check the README.md for config info.`,
            code,
          ),
        ),
    );
  }
  throw crxError(
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
  const fields = (typeof body === 'object' && body !== null ? body : {}) as {
    error?: unknown;
    error_description?: unknown;
  };
  const reason = `${String(fields.error ?? status)}${
    fields.error_description ? `: ${String(fields.error_description)}` : ''
  }`;
  if (fields.error === 'invalid_grant' && credentials.kind === 'oauth') {
    return crxError(
      `Google rejected GOOGLE_REFRESH_TOKEN (${reason}). The token was revoked or has expired. Refresh tokens issued while the OAuth consent screen is in "Testing" mode expire after 7 days, and tokens also expire after six months without use or when the Google account password changes. Set the consent screen to "In production" and generate a new refresh token, or avoid refresh tokens entirely with workload identity federation (see the README).`,
      'EREFRESHTOKEN',
    );
  }
  if (fields.error === 'invalid_client') {
    return crxError(
      `Google rejected the OAuth client (${reason}). Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.`,
      'EGOOGLECLIENT',
    );
  }
  return crxError(
    `Could not obtain a Chrome Web Store access token (${reason}). Check the credentials, and that the Chrome Web Store API is enabled for the project.`,
    'EAUTH',
  );
}

/**
 * Base64url encode.
 *
 * @param input Text or bytes.
 * @returns The URL safe base64 form without padding.
 */
function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build the signed assertion Google exchanges for a service account token.
 *
 * @param account Service account details.
 * @param nowSeconds Current time in seconds since the epoch.
 * @returns A compact RS256 JWT.
 */
function signAssertion(
  account: Extract<Credentials, { kind: 'serviceAccount' }>,
  nowSeconds: number,
): string {
  const unsigned = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(
      JSON.stringify({
        iss: account.clientEmail,
        scope: CHROME_WEBSTORE_SCOPE,
        aud: account.tokenUri,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      }),
    ),
  ].join('.');
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(account.privateKey);
  return `${unsigned}.${base64url(signature)}`;
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
            assertion: signAssertion(
              credentials,
              Math.floor(Date.now() / 1000),
            ),
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
    throw crxError(
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
