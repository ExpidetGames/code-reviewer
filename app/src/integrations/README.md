# Integrations

Everything that depends on a git platform (GitHub, later Bitbucket and others) lives behind the
`IntegrationProvider` interface. Jobs, the runner API, the database and the UI know only the
normalized types below and never see a platform payload. An integration is one connection to a
platform; the MVP has exactly one kind, the GitHub App (`github_app`, `providers/github-app/`).

| File                                   | Role                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                             | `Integration`, `RepoRef`, `ReviewTrigger`, `PullRequestRef`, `IntegrationEvent`, `GitAccess`, the `IntegrationType` set and the other `as const` sets                                                                                                                                       |
| `normalized.ts`                        | Runtime guards (`isRepoRef`, `isReviewTrigger`, `isIntegrationEvent`, ...) with exact key sets, so a raw payload cannot pass as a type; `createGitAccess` and `revealGitAccess`                                                                                                             |
| `provider.ts`                          | The `IntegrationProvider` interface                                                                                                                                                                                                                                                         |
| `config-schema.ts`                     | Field-level validation of an integration's `config` (one error per field) and the secret-key guard                                                                                                                                                                                          |
| `registry.ts`                          | `createIntegrationRegistry`, `integrationRegistry`: maps a type to its provider; the only place that imports a provider                                                                                                                                                                     |
| `errors.ts`                            | `IntegrationError` with stable codes (`INTEGRATION_TYPE_UNKNOWN`, `INTEGRATION_ACCESS_*`, ...), `retryable` and `retryAfterSeconds`                                                                                                                                                         |
| `provider-import-rule.ts`              | The import rule that keeps providers out of the rest of the app (see "The boundary")                                                                                                                                                                                                        |
| `providers/github-app/setup-status.ts` | What the pages may know about the GitHub App settings (`describeGithubAppSetup`: complete, or the names of the missing or unusable variables; the check is remembered for 30 seconds per set of values) and the install address; re-exported by `registry.ts`, used by `src/config-status/` |
| `providers/<type>/`                    | One folder per implementation: `providers/github-app/` (see "The GitHub App provider")                                                                                                                                                                                                      |
| `sync/`                                | `createIntegrationSync`: keeps the `integrations` and `repositories` tables in line with the platform (see "Synchronization")                                                                                                                                                               |

The tables are `integrations` (`src/db/migrations/20261010134000_create_integrations.ts`) and
`repositories` (`src/db/migrations/20261010143000_create_repositories.ts`); the only code that touches
them is `src/db/repositories/integrations-repository.ts` and `repositories-repository.ts`.

## The interface in short

```ts
interface IntegrationProvider {
  type: IntegrationType;
  connect: ConnectFlow; // install redirect, OAuth or token form
  validateConfig(config: unknown): ConfigValidationResult;
  discoverConnections?(): Promise<DiscoveredConnection[]>; // GitHub App: the installations
  findConnection?(externalId: string): Promise<DiscoveredConnection | null>;
  listRepositories(i: Integration): Promise<RepoRef[]>;
  ensureWebhook?(i: Integration, repo: RepoRef): Promise<void>; // only for per-repo webhooks
  verifyWebhook(i: Integration | null, req: Request): Promise<boolean>;
  identifyWebhook(req: Request): Promise<{ externalId: string } | null>;
  parseEvent(i: Integration, req: Request): Promise<IntegrationEvent>;
  canTrigger(i: Integration, t: ReviewTrigger): Promise<boolean>;
  jobAccess(i: Integration, repo: RepoRef): Promise<GitAccess>;
  getPullRequest(
    i: Integration,
    repo: RepoRef,
    n: number,
  ): Promise<PullRequestRef>;
  listOpenPullRequests(
    i: Integration,
    repo: RepoRef,
  ): Promise<PullRequestRef[]>;
}
```

### Receiving a webhook

The route (`POST /api/webhooks/github-app`, see `src/webhooks/README.md`) never looks into a platform payload. For a shared webhook (GitHub App) it does:

1. `verifyWebhook(null, request)`: is the delivery genuine? (HMAC of the body with the shared secret.)
2. `identifyWebhook(request)`: which connection is it? Returns `{ externalId }` (the GitHub
   installation id); the route finds the row with `findByExternalId(type, externalId)`.
   A delivery about an installation that has no row yet (`installation` `created`, normally) cannot
   be found this way: the route then calls `sync.handleInstallationChange` with the identified id
   instead of `parseEvent`, and the sync creates the row after GitHub confirmed the installation (see
   "Synchronization").
3. `parseEvent(integration, request)`: what does it mean? An `IntegrationEvent`:
   - `review_trigger` with a `ReviewTrigger` (opened, updated or a comment command); an opened or
     updated trigger also says whether the pull request is a `draft` and its `state` (`open` or
     `closed`), a command trigger does not,
   - `pull_request_closed` with the repository, the pull request number and whether it was merged:
     it starts nothing, the app drops the pull request's waiting jobs,
   - `pull_request_drafted` with the repository and the number: a pull request was turned into a draft,
     the app drops its waiting automatic jobs,
   - `invalid_payload` with a `reason` (field names only) for an event the app uses whose payload lacks
     fields it reads; the route answers 400,
   - `installation_changed` with the connection's `externalId` and an action (`created`, `deleted`,
     `suspended`, `unsuspended`, `repositories_changed`) for the repository sync,
   - `ignored` with a `reason` for the logs, for everything else that is genuine but not relevant.
4. `canTrigger(integration, trigger)` for a trigger.

For webhooks per integration (`POST /api/webhooks/i/:integrationId`) the URL names the row, so the
route calls `verifyWebhook(integration, request)` and `identifyWebhook` returns `null`.

### Pull requests

`ReviewTrigger.prUrl` and `PullRequestRef.url` are built by the provider, because `/pull/7` versus
`/pull-requests/7` is platform specific; the runner's `claim` response takes `prUrl` from there.
`getPullRequest` (head SHA, draft flag, state) and `listOpenPullRequests` serve starting a review by
hand (`src/manual-reviews/README.md`). An unknown pull request fails with `INTEGRATION_PULL_REQUEST_NOT_FOUND`.
`listOpenPullRequests` and `getPullRequest` report a failure as an `IntegrationError` with the provider neutral access codes
(`INTEGRATION_ACCESS_CONNECTION_GONE`, `..._SUSPENDED`, `..._APP_AUTH_FAILED`, `..._RATE_LIMITED`,
`..._UNAVAILABLE`, `..._FAILED`), the same mapping as `jobAccess` except that a refused request of
another kind (422) is `..._FAILED`, not a refused scope. `getPullRequest` keeps `INTEGRATION_PULL_REQUEST_NOT_FOUND` for a
404 of the call itself; a 404 of the token request (`GithubAppError.duringTokenRequest`) is a removed
installation (`..._CONNECTION_GONE`). A page never has to know a platform's own codes.

### Rules for implementations

- `canTrigger` is about the trigger: may this event start a job (for example, does the comment author
  have write access)? It is not about the app's own permissions on the platform.
- `discoverConnections` and `findConnection` are optional and only for platforms that can list the
  connections of the app. Both reject when the platform cannot be asked: a failure must never look
  like "no connections".
- `listRepositories` returns every repository or rejects. A partial list would make the sync think
  the missing repositories are gone.
- `verifyWebhook`, `identifyWebhook` and `parseEvent` read a clone of the request (`req.clone()`), so
  the caller can read the body again. They have no side effects.
- `jobAccess` returns a `GitAccess` for one repository, built with `createGitAccess`. It carries
  `expiresAt`; jobs have a hard timeout well below the token lifetime, so there is no refresh. Every
  call creates new credentials limited to that repository and the least permissions; nothing is cached
  between calls or jobs. A failure is an `IntegrationError` with a stable code (see "Job access
  failures"); a provider never falls back to broader credentials.
- The token of a `GitAccess` is readable as `access.token` but not enumerable: `JSON.stringify`,
  spreading, `Object.entries` and `console.log` leave it out. Only `revealGitAccess(access)` returns a
  plain copy with the token, for the runner API's `claim` response. It throws
  `INTEGRATION_ACCESS_TOKEN_MISSING` when the token is missing or empty. Never log its result. A
  provider that returns a plain object with a visible token fails the conformance suite.
- **Never spread, clone, cache (`"use cache"`) or return a `GitAccess` from a Server Action.** A cache
  or a Server Action result would store the token or send it to the browser, and a copy made by
  spreading or cloning silently loses the hidden token. Only the runner API's claim (CR-28) reveals
  it, once, in its response. For CR-28 specifically:
  - The copy that `revealGitAccess` returns is a plain object with an enumerable `token`. Never give
    it to a logger, an error, a cache or the database; build it as late as possible and drop it after
    the response.
  - The claim response carries `Cache-Control: no-store`.
  - `retryAfterSeconds` of an access failure is `null` when the platform did not say; the 503 mapping
    needs its own default `Retry-After` for that case (for example 30 seconds).
- `credentials` and `webhook_secret` in the table are reserved for token integrations. A GitHub App
  keeps neither there: its private key and webhook secret live in the environment of the app (the
  self-hosted wizard will need its own app-level home for them). `INTEGRATION_SECRET_STORAGE` in
  `types.ts` says what a type may store, and the repository refuses the rest. **A type may only be
  set to store credentials once they are encrypted** (planned with the first token integration).
- A `config` holds settings only. The per-type schema (known fields only, `unknown_field` for the
  rest) is the real protection against a secret ending up there. As a second, best-effort line the
  repository also refuses keys that look like a secret (`privateKey`, `api_key`, `client_secret`,
  `token`, `password`, `authorization`, `jwt`, `pem` and similar; names ending in `_url`, `_count` or
  `_id` are fine). It does not look at values.
- An explicit `null` in a config counts as not given. `NaN` and `Infinity` are refused.
- `external_id` (the platform's id for the connection) is required; the table holds one integration
  per `(type, external_id)`.

## The GitHub App provider

`providers/github-app/` implements the interface for our own GitHub App; one installation is one
integration (`external_id` is the installation id).

| File                                                     | Role                                                                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                                              | `loadGithubAppConfig(env)`: reads `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_WEBHOOK_SECRET`, optional `GITHUB_API_BASE_URL` |
| `jwt.ts`                                                 | The App JWT (RS256)                                                                                                                                                                          |
| `client.ts`, `mappers.ts`                                | The GitHub client: installations, installation repositories, pull requests, collaborator permission, installation tokens. Returns normalized shapes                                          |
| `provider.ts`                                            | `createGithubAppProvider`                                                                                                                                                                    |
| `events.ts`, `webhook-fields.ts`, `webhook-signature.ts` | Webhook signature, the list of payload fields that are read, and their translation into `IntegrationEvent`s                                                                                  |
| `errors.ts`                                              | `GithubAppError` and its stable codes (`GITHUB_APP_CONFIG_INVALID`, `_AUTH_FAILED`, `_FORBIDDEN`, `_NOT_FOUND`, `_RATE_LIMITED`, `_UNAVAILABLE`, `_REQUEST_FAILED`)                          |
| `fake-client.ts`                                         | In-memory client for the provider's unit tests                                                                                                                                               |

Settings come from the environment (see `.env.example`). Missing or invalid values fail with
`GITHUB_APP_CONFIG_INVALID` and an error that names the variables, never their values. The provider is
created when the app loads but reads the settings on first use, so a missing variable breaks only the
calls that need GitHub. The private key and the webhook secret are not enumerable properties of the
configuration, like the token of a `GitAccess`. The webhook secret is used exactly as given (not
trimmed). `GITHUB_API_BASE_URL` other than `https://api.github.com` is refused unless
`ALLOW_TEST_GITHUB_ENDPOINTS=true`, because the App JWT and the tokens are sent to that address; the
tests set both to reach the fake GitHub.

How the interface is met:

- `verifyWebhook`: HMAC-SHA256 of the raw body with the app's webhook secret against
  `X-Hub-Signature-256`, compared in constant time. `identifyWebhook`: `installation.id` of the payload
  (null for a `ping`).
- `parseEvent` reads only the fields listed in `webhook-fields.ts`, and the contract test
  (`webhook-payloads.integration.test.ts`) checks the recorded payloads in
  `fakes/fixtures/github-webhooks/` against that list.
  - `installation` `created`, `deleted`, `suspend`, `unsuspend` and every `installation_repositories`
    delivery become `installation_changed` (the repository lists in the payload are not used: the sync
    reads GitHub's current state).
  - `pull_request` `opened`, `reopened` and `ready_for_review` become a `review_trigger` of kind
    `opened`, `synchronize` one of kind `updated`; `closed` becomes `pull_request_closed`; everything
    else is ignored. The repository is the one the pull request targets, so a pull request from a fork
    is reviewed like any other. Drafts are not filtered here: the trigger carries the draft flag and
    the state of the pull request, and the trigger policy (`src/webhooks/automatic-review-policy.ts`)
    decides. A payload without a field of `webhook-fields.ts` (for example the head commit) is
    `invalid_payload`.
  - `issue_comment` `created` on an open pull request becomes a `command` trigger when the text starts
    with `/review`, `/improve`, `/describe` or `/ask` (leading whitespace and any case allowed; the
    word must end there, so `/reviewer` is nothing). `comment-command.ts` is the one parser: only
    `/ask` takes text (the rest of the comment, trimmed, markdown images and links to images replaced by
    `[image link removed]`, at most 2000 UTF-16 units; a longer question
    is cut and ends with a note, and `/ask` without a question is no command); text after any other
    command is dropped, because PR-Agent would read it as options. The trigger carries the id of the
    comment (`commentId`), and the head commit, which a comment delivery does not carry, is read
    from GitHub. Comments of bots (the app's own included), edited and deleted comments, comments on
    issues and on closed or merged pull requests are ignored.
    To cost a commenter without write access as few calls as possible, the order is: the payload's
    `author_association` (only `OWNER`, `MEMBER` and `COLLABORATOR` can have write access; others
    are ignored with no call), then the permission (one call), and only then the pull request for its
    head commit. A commenter without write access is ignored with a reason, so no trigger exists.
- `canTrigger`: `opened` and `updated` triggers are always allowed; a command is allowed when the
  author's repository permission is `admin` or `write` (read with the installation token). The comment's
  `author_association` only serves as the free first filter above: it cannot tell a member with read
  access from one with write access, and the trigger does not carry it.
- `jobAccess` mints a fresh installation token for every call (`client.mintInstallationToken`, the
  one place that mints a job token; `job-access.ts` holds the scope). The request names exactly one
  repository by its numeric id (`repository_ids`, so a rename or transfer cannot redirect it) and
  exactly the permissions `pull_requests: write`, `issues: write`, `contents: read` and
  `metadata: read` (`JOB_TOKEN_PERMISSIONS`); the app must be registered with at least these. The
  client refuses a scope without a repository or permissions before any request, and discards a token
  GitHub reports as broader than asked for (the check fails closed: the answer must say `selected`,
  list the repositories and the permissions, with known levels). Such a token is switched off at once
  with a best-effort `DELETE /installation/token`, whose failure is ignored. A mint that times out
  after GitHub created the token cannot be undone: that unused token stays valid until it expires
  (about one hour) and nobody has seen it. The result is a `GitAccess` with `expiresAt` (about one
  hour; jobs end long before, so there is no refresh), the configured API base URL and
  `botLogin` `<GITHUB_APP_SLUG>[bot]`. Nothing is logged or stored; the private key only signs the
  App JWT inside the app.
- Rate limits and failures become `GithubAppError`s with a code and, for a rate limit,
  `retryAfterSeconds`. There is no retry loop. Requests time out after 15 seconds. Messages name the
  call and the status only, never a credential or a response body; `GithubAppError` and
  `IntegrationError` carry `safeMessage: true` (`hasSafeMessage` in `errors.ts`), the marker that
  allows a message to be logged as it is.
- Names that go into a request path (repository owner and name, login, installation id) are checked
  first: `.` and `..` segments and anything but a plain name are refused, as is a pull request number
  that is not a positive whole number.
- A listing of repositories is compared with GitHub's own `total_count`; a shorter list (a page
  boundary skipped one while the list changed) fails with `GITHUB_APP_UNAVAILABLE` instead of being
  taken for complete. One App JWT is reused for about five minutes. An installation record whose
  account has no login is skipped with a warning, so one odd record cannot block the others.
- Read calls use an installation token that is cached per client until a minute before it expires, and
  asked for again once if GitHub refuses the cached one.

### Job access failures

`jobAccess` rejects with an `IntegrationError`; callers (the runner API's claim) branch on `code` and
`retryable`, never on GitHub's codes. The original `GithubAppError` is its `cause`.

| Code                                      | GitHub said                                                                                                                 | `retryable` |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `INTEGRATION_ACCESS_CONNECTION_GONE`      | 404 on the token call: installation deleted                                                                                 | no          |
| `INTEGRATION_ACCESS_CONNECTION_SUSPENDED` | 403 (not a rate limit): installation suspended                                                                              | no          |
| `INTEGRATION_ACCESS_SCOPE_REFUSED`        | 422, or a repository reference that is not usable: the repository is not in the installation, or the app lacks a permission | no          |
| `INTEGRATION_ACCESS_APP_AUTH_FAILED`      | 401: the App JWT was refused (key or app id)                                                                                | no          |
| `INTEGRATION_ACCESS_RATE_LIMITED`         | 429, or 403 with a rate limit header; `retryAfterSeconds` when given                                                        | yes         |
| `INTEGRATION_ACCESS_UNAVAILABLE`          | 5xx, a network failure or a timeout                                                                                         | yes         |
| `INTEGRATION_ACCESS_FAILED`               | anything else (settings missing, an unexpected answer, a token broader than asked for)                                      | no          |

`retryAfterSeconds` is never negative and is `null` when the platform did not say (always for a network
failure or timeout): the caller then uses its own default. Messages name the call and the status only,
never a token, JWT, key or response body.

## Synchronization

`sync/service.ts` (`createIntegrationSync`) keeps the tables in line with the platform. A repository row
is `active` while the platform lists it for its integration and becomes inactive when it does not;
nothing is deleted, so projects and past reviews keep their reference. A repository that comes back
gets its old row back. New repositories are active in this table; whether a project reviews them is
decided when a project is activated for the repository, not here.

| Entry point                          | When                                                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runStartupSync` (`sync/startup.ts`) | When the server starts (`instrumentation.ts`), not awaited | `syncAll`; logs the result; never stops the start                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `syncAll()`                          | Start, and later the button in the UI                      | Creates, updates and disables integrations from `discoverConnections`, then reads every active integration's repositories                                                                                                                                                                                                                                                                                                                                          |
| `handleInstallationChange(change)`   | The webhook route, for an `installation_changed` event     | `deleted`: disable and deactivate all repositories without a call to GitHub. `created`/`suspended`/`unsuspended`: the delivery may be a retry or arrive out of order, so `findConnection` is asked first and the row follows GitHub's answer (suspended or not); an active row has its repositories read again. `repositories_changed`: read the repositories again. A connection without a row is confirmed with `findConnection` (App JWT) and only then created |
| `syncIntegration(id)`                | Single integration                                         | Reads its repositories                                                                                                                                                                                                                                                                                                                                                                                                                                             |

All of them return a summary and never reject because of the platform (`errors` lists each failure by
stage and stable code). The rule: the tables change to "gone" only after GitHub answered completely. A
5xx, a timeout, a refused JWT, a failing later page or missing settings are reported and change
nothing. A failure for one installation (even an unexpected one, such as a database error) is
reported with its integration id and does not stop the others.

Overlapping triggers: work on the same installation runs one after the other, and each run reads
GitHub's current state inside the lock, so repeating or overlapping triggers end in the same state.
The lock (`keyed-lock.ts`, `sharedKeyedLock`) is one per process, kept on `globalThis` because Next.js
may load `instrumentation.ts` and the route handlers as separate module graphs. The webhook route and
the button use `getIntegrationSync()` (`sync/shared.ts`), the process-wide service, never their own
`createIntegrationSync`. A full sync works from a list that can be older than a delivery, so it never
decides from the list alone: before it disables a row the list does not mention, and before it
suspends or resumes one, it asks GitHub about that one installation inside the lock.

The button is `POST /api/integrations/sync` (`sync/http.ts`, the route file in `src/app/api/integrations/sync`):
`requireUser()` first, a same-site check, then `getIntegrationSync().syncAll()`. The answer is
`{ added, errors }` (`summary.repositories.added` and `summary.errors`, stage and stable code, never a
credential). Overlapping full syncs share one run: `getIntegrationSync()` wraps the service with
`coalesceSyncAll` (`sync/coalesce.ts`), so several tabs or the start-up sync meeting the button read GitHub once. The Projects page shows it as "Sync from GitHub".

`disabled` always means "suspended or gone on GitHub": a full sync resumes any disabled row GitHub
lists as active. There is no way to keep an integration disabled by hand.

## Types and reserved values

`INTEGRATION_TYPES` is `["github_app"]`. Values are stored in the database, so they are never renamed
or reused. `github_token` and `bitbucket_cloud` are reserved (`RESERVED_INTEGRATION_TYPES`): the
registry answers them with `INTEGRATION_PROVIDER_NOT_IMPLEMENTED`, anything else it does not know with
`INTEGRATION_TYPE_UNKNOWN`.

## Adding a new integration

1. **Implementation.** Create `providers/<type>/` with a factory that returns an
   `IntegrationProvider`, returning access through `createGitAccess`. Add the type to `INTEGRATION_TYPES` in `types.ts` (and to
   `INTEGRATION_SECRET_STORAGE`, saying whether it stores credentials and a webhook secret) and remove
   it from `RESERVED_INTEGRATION_TYPES`. If the platform is new, add it to `GIT_PLATFORMS` (and an auth
   type to `GIT_AUTH_TYPES` if needed).
2. **Registry entry.** Add the provider to `integrationRegistry` in `registry.ts`. That file is the
   only one outside the provider's folder that may import it.
3. **Runner mapping entry.** The runner knows platforms, not integrations: add the new `GitAccess.provider`
   to the runner's table that turns `git` from the job into PR-Agent settings (`runner/`).
4. **Tests.** Run the conformance suite
   (`describeIntegrationProviderConformance` in `src/test-support/integration-provider-conformance.ts`)
   against the new provider, plus the tests of its own logic against the platform's fake.

Jobs, the runner API, the database schema and the UI stay unchanged.

## The boundary

Only `registry.ts` and the files inside `providers/` may import from `providers/`. Everything else
imports the types, the interface or the registry. `provider-import-rule.ts` checks this with the
TypeScript parser on every `.ts/.tsx/.js/.mjs` file of the app (everything except `node_modules`,
`.next` and similar output folders) and names every violating file. It sees `import`/`export from`,
`import()`, `require()`, `import type`, and `vi.mock`-style calls. `provider-import-rule.test.ts` runs
it in the unit tests; folding the same function into `verify:structure` is planned together with that
script (see `TESTING.md`). A module specifier built entirely at run time is invisible to it.

## Testing without a platform

`src/test-support/fake-integration-provider.ts` has `fakeIntegrationProvider(options)`, a provider
that speaks a small made-up webhook format (`fakeWebhookRequest`, signed with a real HMAC-SHA256 of
the body) and translates it like a real one would. Options: the repositories it lists, who may
trigger, the access it hands out, the pull requests it knows, a failure for `jobAccess`. It records every call in `calls`. `fakeIntegration()` builds an `Integration` value.
Use it in jobs, runner API and UI tests; pass it to `createIntegrationRegistry({ github_app: fake })`
when the code under test resolves through a registry.

The real GitHub App provider is tested against the fake GitHub (`fakes/github`, the same one the sign
in tests use), a fake GitHub REST API over real HTTP (see `fakes/github/README.md`), and against
recorded webhook payloads. For tests outside the
provider folder, `createDefaultIntegrationRegistry({ env })` builds the real provider from an
environment, and `src/test-support/integration-sync-harness.ts` gives a database, the fake GitHub, a
sync service and `deliver(fixture)`, which does what the webhook route does with a delivery.
