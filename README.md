# Semantic Release - Chrome Web Store

A [semantic-release](https://github.com/semantic-release/semantic-release)
plugin that versions, zips and publishes a Chrome extension to the
[Chrome Web Store](https://chromewebstore.google.com) using the current
**Chrome Web Store API V2**.

It is a drop-in replacement for
[`semantic-release-chrome`](https://github.com/GabrielDuarteM/semantic-release-chrome),
which is unmaintained and talks to the V1.1 API that Google has shut down.
The step names, option names, environment variable names and error codes are
the same wherever the V2 API allows it. The few deliberate differences are
listed under [Differences from semantic-release-chrome](#differences-from-semantic-release-chrome).

## Why?

Releasing a Chrome extension by hand means editing `manifest.json`, zipping the
build, uploading it in the Developer Dashboard and pressing publish. The
existing semantic-release plugin automates that, but it:

- uses the V1.1 API, which no longer works,
- needs a long lived OAuth refresh token that is awkward to create, expires
  when the consent screen is in "Testing" mode, and has to live in CI secrets,
- fails when `manifest.json` contains comments, which Chrome allows,
- cannot release pre-release versions, and
- can produce a corrupt zip (`PKG_INVALID_ZIP`) because it does not wait for
  the archive to be written.

This plugin fixes those, and can authenticate without any stored secret by
using workload identity federation.

## Installation

```sh
npm install --save-dev @mridang/semantic-release-crx
```

Node.js 22 or newer is required. The only runtime dependencies are
`@semantic-release/error` and `lodash` (for the `asset` template); HTTP uses
the built in `fetch` and the zip file is written with `node:zlib`, so there are
no native binaries.

## Usage

Add the plugin to your semantic-release configuration. It implements the
`verifyConditions`, `prepare` and `publish` steps. Place it **before**
`@semantic-release/git` and `@semantic-release/github`, so that the version it
writes into your manifests is committed and the zip it builds is available to
attach to the GitHub release.

```js
// release.config.mjs
export default {
  branches: ['master'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@mridang/semantic-release-crx',
      {
        publisherId: '00000000-0000-0000-0000-000000000000',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        distFolder: 'dist',
        asset: 'my-extension-${nextRelease.version}.zip',
        additionalManifests: ['src/manifest.json'],
      },
    ],
    [
      '@semantic-release/github',
      { assets: [{ path: 'my-extension-*.zip', label: 'Extension' }] },
    ],
    [
      '@semantic-release/git',
      { assets: ['src/manifest.json', 'package.json', 'package-lock.json'] },
    ],
  ],
};
```

Before the first automated release the item must already exist in the
Developer Dashboard with every required field filled in (a draft is enough).
The Chrome Web Store API can update an item but cannot create one.

### What each step does

- **`verifyConditions`** checks the options, finds credentials and proves they
  work by asking the store for the item's status, so a bad token fails the
  release before anything is versioned or tagged.
- **`prepare`** writes the next version into `manifestPath` (and
  `additionalManifests`) and zips `distFolder` to `asset`.
- **`publish`** uploads the zip, waits until the store has finished processing
  it, and then submits it for review. It never submits unless the upload
  reported `SUCCEEDED`. It returns
  `{ name: 'Chrome Web Store', url: 'https://chromewebstore.google.com/detail/<id>' }`,
  which semantic-release links to from the issues and pull requests it
  comments on.

## Configuration

| Option                | Default                               | Description                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publisherId`         | `CHROME_PUBLISHER_ID` env             | **Required.** Your publisher ID: Chrome Web Store Developer Dashboard → Account → Publisher ID. **New**: V2 addresses items as `publishers/{publisherId}/items/{extensionId}`.                                                                                                   |
| `extensionId`         |                                       | **Required.** The 32 letter item ID (the last part of the store URL, or "Item ID" in the dashboard). May also be an object mapping a branch name to an item ID, so a pre-release branch can publish to a separate staging item. A branch with no entry is an error.              |
| `asset`               |                                       | **Required** in `prepare` and `publish`. Path of the zip file. A [lodash template](https://lodash.com/docs/#template) with `branch`, `lastRelease`, `nextRelease` and `commits` available, for example `my-ext-v${nextRelease.version}.zip`. Relative paths are inside the cwd.  |
| `distFolder`          | `dist`                                | Folder whose contents are zipped.                                                                                                                                                                                                                                                |
| `manifestPath`        | `<distFolder>/manifest.json`          | Manifest that receives the new version.                                                                                                                                                                                                                                          |
| `additionalManifests` | `[]`                                  | **New.** More manifests that receive the same version, for example the `src/manifest.json` that is committed to git.                                                                                                                                                             |
| `target`              | `default`                             | `default` submits for review and publishes once approved. `staged` publishes to the staging area once approved, so you release it from the dashboard. `draft` uploads without submitting. `local` neither needs nor contacts the store. `trustedTesters` is accepted, see below. |
| `prerelease`          | `convert`                             | **New.** What to do for versions like `1.2.0-beta.3`: `convert`, `skip` (build the zip but do not contact the store) or `reject` (fail).                                                                                                                                         |
| `deployPercentage`    | the dashboard value                   | **New.** Initial rollout percentage, 0 to 100.                                                                                                                                                                                                                                   |
| `skipReview`          | `false`                               | **New.** Ask the store to skip review when the item qualifies. The API refuses when review is required.                                                                                                                                                                          |
| `failOnWarnings`      | `false`                               | **New.** Fail the release when the store returns a warning that is not in `ignoredWarnings`. Warnings are always logged.                                                                                                                                                         |
| `ignoredWarnings`     | `['PUBLISHED_WITH_FRICTION_WARNING']` | **New.** Warning reasons that never fail the release (the original plugin's whitelist).                                                                                                                                                                                          |
| `pollIntervalMs`      | `5000`                                | **New.** Time between upload status checks.                                                                                                                                                                                                                                      |
| `pollTimeoutMs`       | `300000`                              | **New.** Longest wait for an asynchronous upload. The release fails, without publishing, when it is exceeded.                                                                                                                                                                    |

The `target` values behave like this:

- `default` → `publishType: DEFAULT_PUBLISH`.
- `staged` → `publishType: STAGED_PUBLISH`.
- `draft` and `local` skip the submission, `local` also skips the upload and the credentials check.
- `trustedTesters` is accepted so existing configuration keeps loading, but V2
  has no per-request tester audience: who can install is set by the item's
  **Distribution** settings in the Developer Dashboard. A warning is logged and
  the item is submitted as `default`.

## Authentication

The plugin finds credentials in this order, using the first complete set:

1. `CHROME_ACCESS_TOKEN`: a ready made OAuth access token.
2. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`: the
   OAuth client and refresh token that `semantic-release-chrome` used.
3. `GOOGLE_SERVICE_ACCOUNT_KEY` (the key JSON, optionally base64 encoded) or
   `GOOGLE_APPLICATION_CREDENTIALS` (the path of a service account key file).

The OAuth scope is `https://www.googleapis.com/auth/chromewebstore`. Secrets
are never logged and never appear in an error message.

### Recommended: workload identity federation (no stored secret)

With GitHub Actions you can authenticate as a service account without a
long lived key or refresh token, using
[`google-github-actions/auth`](https://github.com/google-github-actions/auth).
That action produces a short lived access token that this plugin uses directly.

One time setup:

1. In a Google Cloud project, enable the **Chrome Web Store API**
   (`chromewebstore.googleapis.com`) and the **IAM Service Account Credentials
   API**.
2. Create a service account, a workload identity pool and a GitHub provider,
   and let your repository impersonate the service account
   (`roles/iam.workloadIdentityUser`). If the access token step reports a
   permission error, also grant `roles/iam.serviceAccountTokenCreator`. The
   `google-github-actions/auth` README walks through this.
3. In the Chrome Web Store Developer Dashboard, add the service account's
   email address to your publisher account so that it is allowed to manage your
   items.

Then in the workflow:

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write # required for workload identity federation
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: '.nvmrc'
      - run: npm ci
      - run: npm run build

      - id: auth
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
          service_account: chrome-publisher@my-project.iam.gserviceaccount.com
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/chromewebstore

      - run: npx semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CHROME_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}
```

The access token lives for about an hour, so run the auth step in the same job,
right before semantic-release. If `GOOGLE_APPLICATION_CREDENTIALS` is also set
(the action sets it to a federation file when it creates a credentials file),
it is ignored as long as `CHROME_ACCESS_TOKEN` is present.

### OAuth client and refresh token

This works exactly like `semantic-release-chrome`; the original
[guide](https://github.com/GabrielDuarteM/semantic-release-chrome/blob/master/Authentication.md)
still applies for creating the client. Two things go wrong often:

- **Refresh tokens expire.** While the OAuth consent screen is in _Testing_
  mode Google expires refresh tokens after **7 days**. Set the publishing
  status to _In production_ before you create the token. A token also stops
  working after six months without use, if it is revoked, or when the account
  password changes. The plugin recognises Google's `invalid_grant` answer and
  says so. Nothing in CI can renew a refresh token, so to avoid rotating a
  secret altogether use workload identity federation above.
- **Getting the token.** The browser console snippet in the original guide is
  blocked by some browsers' content security policy. The same exchange works
  from a terminal: open the consent URL from the guide in your browser, copy
  the `code` parameter from the address bar of the page that fails to load on
  `localhost:8818`, then run:

  ```sh
  curl "https://oauth2.googleapis.com/token" \
    --data-urlencode "client_id=$GOOGLE_CLIENT_ID" \
    --data-urlencode "client_secret=$GOOGLE_CLIENT_SECRET" \
    --data-urlencode "code=$AUTH_CODE" \
    --data-urlencode "grant_type=authorization_code" \
    --data-urlencode "redirect_uri=http://localhost:8818"
  ```

  Set `GOOGLE_REFRESH_TOKEN` to the value of the `refresh_token` field only.
  Pasting the whole JSON response is rejected with `EREFRESHTOKENFORMAT`.

### Service account key

Create a key for a service account that is a member of your publisher account
and put its JSON in `GOOGLE_SERVICE_ACCOUNT_KEY`, or point
`GOOGLE_APPLICATION_CREDENTIALS` at the file. Prefer workload identity
federation where you can, because a key is a long lived secret.

## Pre-releases and staging items

semantic-release can publish versions such as `1.2.0-beta.3`, which Chrome does
not accept as a `version`. With `prerelease: 'convert'` (the default) the plugin
writes:

```json
{ "version": "1.2.0.3", "version_name": "1.2.0-beta.3" }
```

The last numeric identifier of the pre-release becomes the fourth version part,
so successive pre-releases keep increasing, and `version_name` shows the full
semantic version to people. Each part must be between 0 and 65535. Stable
releases write only `version` (and refresh `version_name` if your manifest has
one).

The store does not have release channels, so publish pre-releases to a
**separate** item, as people already do with `semantic-release-chrome`:

```js
{
  extensionId: { master: 'prodprodprodprodprodprodprodprod', beta: 'stagestagestagestagestagestagesta' },
  publisherId: '...',
  asset: 'ext-${nextRelease.version}.zip',
}
```

Use one item per branch, because Chrome compares versions as numbers and
`1.2.0` (= `1.2.0.0`) is lower than `1.2.0.3`; releasing both to the same item
would be rejected. Use `prerelease: 'skip'` to build the zip for pre-releases
without contacting the store, or `'reject'` to forbid them.

## Known limitations

- **Warnings and a half finished release.** The store only returns warnings
  and the final state in the publish response, after the submission exists.
  With `failOnWarnings: true` and `ignoredWarnings: []` the plugin sends
  `blockOnWarnings`, so the store refuses to submit and nothing is half done.
  When some warnings are ignored (including the default whitelist) the
  warnings are judged after the submission: the step then fails although the
  item is already in review, and a `REJECTED` or `CANCELLED` state is reported
  the same way. Check the Developer Dashboard before re-running.
- **Upload state.** The store documents `lastAsyncUploadState` as the state of
  the last asynchronous upload in the past 24 hours. The plugin trusts it and
  publishes only after it reports `SUCCEEDED`, treating `NOT_FOUND` as "keep
  waiting" until `pollTimeoutMs`. This has not been verified against the live
  store.

## Differences from semantic-release-chrome

- **API.** V2 (`chromewebstore.googleapis.com`) instead of V1.1.
- **`publisherId` is required**, because V2 addresses items by publisher. It is
  the one option you must add when migrating.
- **Credentials.** The `GOOGLE_*` variables work as before. `CHROME_ACCESS_TOKEN`
  and a service account key are new. With no credentials at all the error code
  is `ENOCREDENTIALS`; with only some of the three OAuth variables you get the
  original `EGOOGLECLIENTID`, `EGOOGLECLIENTSECRET` and `EGOOGLEREFRESHTOKEN`.
- **`extensionId`** may be a branch map. `ENOEXTENSIONID` and `ENOASSET` are
  unchanged.
- **`target: 'trustedTesters'`** is accepted but behaves like `default`; the
  audience is configured in the dashboard (see above). `staged` is new.
- **Warnings.** V1.1 reported status codes that the plugin turned into errors,
  except the whitelisted `PUBLISHED_WITH_FRICTION_WARNING`. V2 returns warnings
  as non-blocking, so they are logged by default. `failOnWarnings` restores
  the strict behaviour and `ignoredWarnings` is the whitelist.
- **Upload failures** no longer list `itemError` details, because V2 does not
  return them; the error points you to the Developer Dashboard.
- **Upload processing is awaited.** Large packages are processed
  asynchronously; the plugin polls until the upload succeeds, fails or
  `pollTimeoutMs` passes, and only publishes after `SUCCEEDED`.
- **Manifest editing.** Only the version members are edited, in place.
  `semantic-release-chrome` re-serialised the file, which failed on comments
  and lost formatting. Key order, comments and indentation are now preserved.
- **Zip.** Written with `node:zlib` instead of `archiver`. The file is complete
  on disk when `prepare` finishes, the archive is never added to itself, and
  the output is deterministic (sorted entries, fixed timestamps).
- **Release link** is `https://chromewebstore.google.com/detail/<id>`.
- **Node.js 22 or newer**, and ESM only.
- **Template engine** is still lodash's `template`, from the maintained
  `lodash` package rather than the unpatched `lodash.template`.

## Issues and pull requests of semantic-release-chrome

Every issue and pull request in the original repository was reviewed. "Test"
points at the test that fails without the fix.

| #                                                                                                                                                                                                                               | Topic                                         | Status                                | What this plugin does                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [1](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/1)                                                                                                                                                         | The project's own failing release (npm token) | Not applicable                        | Concerned that repository's CI, not the plugin.                                                                                                              |
| [7](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/7)                                                                                                                                                         | HTTP 400 when publishing                      | Fixed                                 | Pasting the whole token JSON is detected (`EREFRESHTOKENFORMAT`); the privacy tab cause is in the 400 hint. Test: `auth.test.ts`, `webstore-client.test.ts`. |
| [24](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/24)                                                                                                                                                       | Multiple release branches / channels          | Fixed                                 | `extensionId` may map branches to items. Test: `settings.test.ts`, `publish.test.ts`.                                                                        |
| [41](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/41)                                                                                                                                                       | `Cannot read property '0' of undefined`       | Fixed                                 | Responses are read defensively; a response without a state fails with `EPUBLISHSTATE`. Test: `publish.test.ts`.                                              |
| [46](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/46)                                                                                                                                                       | `PUBLISHED_WITH_FRICTION_WARNING` fails       | Fixed                                 | Whitelisted, logged, never fatal. Test: `publish.test.ts`.                                                                                                   |
| [60](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/60)                                                                                                                                                       | `draft` target                                | Ported                                | `target: 'draft'`. Test: `publish.test.ts`.                                                                                                                  |
| [69](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/69)                                                                                                                                                       | Better message on 400                         | Fixed                                 | Google's message, status and reason, plus a checklist, for 400, 401, 403 and 404. Test: `webstore-client.test.ts`.                                           |
| [81](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/81)                                                                                                                                                       | Cannot update the non-dist manifest           | Fixed                                 | `additionalManifests`. Test: `prepare.test.ts`.                                                                                                              |
| [82](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/82)                                                                                                                                                       | Common templates for asset naming             | Ported                                | The lodash `asset` template with every variable; examples above. Test: `asset.test.ts`.                                                                      |
| [89](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/89)                                                                                                                                                       | `PKG_INVALID_ZIP`                             | Fixed                                 | The zip is complete before `prepare` returns, never contains itself, and is verified in tests by an independent reader. Test: `zip.test.ts`.                 |
| [90](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/90)                                                                                                                                                       | Skip publish                                  | Ported                                | Duplicate of 60: `draft` and `local`. Test: `publish.test.ts`.                                                                                               |
| [92](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/92)                                                                                                                                                       | Dependency dashboard                          | Not applicable                        | Renovate bookkeeping. Dependabot is configured here.                                                                                                         |
| [94](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/94)                                                                                                                                                       | Vulnerable `got` dependency                   | Fixed by design                       | No `got`, `chrome-webstore-upload` or `archiver`; the built in `fetch` is used.                                                                              |
| [103](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/103)                                                                                                                                                     | Versioning without publishing                 | Not applicable                        | A semantic-release configuration question; `target: 'local'` versions and zips without contacting the store. Test: `publish.test.ts`.                        |
| [105](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/105)                                                                                                                                                     | Cannot obtain a refresh token                 | Fixed (documented, plus alternatives) | A terminal based exchange replaces the console snippet, and workload identity or a service account avoids refresh tokens. Test: `auth.test.ts`.              |
| [111](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/111)                                                                                                                                                     | Publish pre-releases                          | Fixed                                 | `prerelease` modes, four part versions, `version_name`, branch to item map. Test: `version.test.ts`, `manifest.test.ts`, `publish.test.ts`.                  |
| [114](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/114)                                                                                                                                                     | Do refresh tokens expire?                     | Fixed (guidance)                      | `invalid_grant` gets an explanatory error, the README explains expiry and the alternative. Test: `auth.test.ts`.                                             |
| [115](https://github.com/GabrielDuarteM/semantic-release-chrome/issues/115)                                                                                                                                                     | `manifest.json` with comments                 | Fixed                                 | Comments and trailing commas are accepted and preserved. Test: `jsonc.test.ts`, `manifest.test.ts`.                                                          |
| PRs [2](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/2), [70](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/70)                                                                              | Return release info, URL not linkified        | Ported                                | `publish` returns `{ name, url }`. Test: `publish.test.ts`.                                                                                                  |
| PRs [25](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/25) (closed)                                                                                                                                            | Channels as a map                             | Ported                                | The branch map above.                                                                                                                                        |
| PRs [44](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/44), [47](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/47)                                                                            | `statusDetail`, ignore warnings               | Ported / replaced                     | V2 has no status list; warnings are handled as described.                                                                                                    |
| PRs [95](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/95), [96](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/96), [106](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/106) | Error messages, templating, `local` target    | Ported                                | As above.                                                                                                                                                    |
| PRs [112](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/112), [113](https://github.com/GabrielDuarteM/semantic-release-chrome/pull/113) (closed)                                                               | Pre-release support                           | Replaced                              | Uses the `version` plus `version_name` approach of 113 with the safeguards suggested in the 111 discussion.                                                  |
| PRs 3 to 10, 20 to 23, 26 to 43, 45, 48 to 68, 71 to 80, 83 to 88, 91, 93, 97 to 102, 104, 107 to 110                                                                                                                           | Renovate and Dependabot bumps, docs, CI       | Out of scope                          | Dependency maintenance of the old project, and authentication documentation that is superseded by this README.                                               |

## Error codes

Every failure is a semantic-release error with a stable code:

| Code                                                                                                                               | Meaning                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ENOASSET`, `ENOEXTENSIONID`, `ENOPUBLISHERID`, `EEXTENSIONIDBRANCH`                                                               | Missing or unusable option.                                                          |
| `EINVALIDTARGET`, `EINVALIDPRERELEASE`, `EINVALIDDEPLOYPERCENTAGE`, `EINVALIDASSET`                                                | Invalid option value or template.                                                    |
| `EGOOGLECLIENTID`, `EGOOGLECLIENTSECRET`, `EGOOGLEREFRESHTOKEN`, `ENOCREDENTIALS`, `EREFRESHTOKENFORMAT`, `ESERVICEACCOUNT`        | Missing or unusable credentials.                                                     |
| `EREFRESHTOKEN`, `EGOOGLECLIENT`, `EAUTH`                                                                                          | Google refused to issue an access token.                                             |
| `EWEBSTOREAUTH`, `EWEBSTOREPERMISSION`, `EWEBSTORENOTFOUND`, `EWEBSTOREBADREQUEST`, `EWEBSTOREHTTP`, `EWEBSTORENETWORK`            | The store API returned an error (HTTP 401, 403, 404, 400, other) or was unreachable. |
| `EUPLOADFAILED`, `EUPLOADTIMEOUT`, `EPUBLISHSTATE`                                                                                 | The upload failed or did not finish in time; the submission was not accepted.        |
| `ENOMANIFEST`, `EINVALIDMANIFEST`, `EINVALIDVERSION`, `ENOVERSION`, `ENODISTFOLDER`, `EZIPTOOLARGE`, `ENOASSETFILE`, `EPRERELEASE` | Problems with the build output or version.                                           |

## Development

```sh
devbox run -- npm ci
devbox run -- npm run build
devbox run -- npm run lint
devbox run -- npm run format:check
devbox run -- npm test
```

The tests never use the network: `fetch` is replaced with a recorded router.

## License

Apache-2.0. Parts of the behaviour are modelled on
[`semantic-release-chrome`](https://github.com/GabrielDuarteM/semantic-release-chrome)
(MIT, Gabriel Duarte).
