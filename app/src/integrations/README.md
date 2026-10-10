# Integrations

Everything that depends on a git platform (GitHub, later Bitbucket and others) lives behind the
`IntegrationProvider` interface. Jobs, the runner API, the database and the UI know only the
normalized types below and never see a platform payload. An integration is one connection to a
platform; the MVP has exactly one kind, the GitHub App (`github_app`), implemented by its own tickets.

| File                      | Role                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                | `Integration`, `RepoRef`, `ReviewTrigger`, `PullRequestRef`, `IntegrationEvent`, `GitAccess`, the `IntegrationType` set and the other `as const` sets                           |
| `normalized.ts`           | Runtime guards (`isRepoRef`, `isReviewTrigger`, `isIntegrationEvent`, ...) with exact key sets, so a raw payload cannot pass as a type; `createGitAccess` and `revealGitAccess` |
| `provider.ts`             | The `IntegrationProvider` interface                                                                                                                                             |
| `config-schema.ts`        | Field-level validation of an integration's `config` (one error per field) and the secret-key guard                                                                              |
| `registry.ts`             | `createIntegrationRegistry`, `integrationRegistry`: maps a type to its provider; the only place that imports a provider                                                         |
| `errors.ts`               | `IntegrationError` with stable codes (`INTEGRATION_TYPE_UNKNOWN`, `INTEGRATION_PROVIDER_NOT_IMPLEMENTED`, ...)                                                                  |
| `provider-import-rule.ts` | The import rule that keeps providers out of the rest of the app (see "The boundary")                                                                                            |
| `providers/<type>/`       | One folder per implementation (none yet; the GitHub App arrives with the GitHub integration tickets)                                                                            |

The table is `integrations` (`src/db/migrations/20261010120000_create_integrations.ts`), the only code that
touches it is `src/db/repositories/integrations-repository.ts`.

## The interface in short

```ts
interface IntegrationProvider {
  type: IntegrationType;
  connect: ConnectFlow; // install redirect, OAuth or token form
  validateConfig(config: unknown): ConfigValidationResult;
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

The route never looks into a platform payload. For a shared webhook (GitHub App) it does:

1. `verifyWebhook(null, request)`: is the delivery genuine? (HMAC of the body with the shared secret.)
2. `identifyWebhook(request)`: which connection is it? Returns `{ externalId }` (the GitHub
   installation id); the route finds the row with `findByExternalId(type, externalId)`.
3. `parseEvent(integration, request)`: what does it mean? An `IntegrationEvent`:
   - `review_trigger` with a `ReviewTrigger` (opened, updated or a comment command),
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
hand. An unknown pull request fails with `INTEGRATION_PULL_REQUEST_NOT_FOUND`.

### Rules for implementations

- `canTrigger` is about the trigger: may this event start a job (for example, does the comment author
  have write access)? It is not about the app's own permissions on the platform.
- `verifyWebhook`, `identifyWebhook` and `parseEvent` read a clone of the request (`req.clone()`), so
  the caller can read the body again. They have no side effects.
- `jobAccess` returns a `GitAccess` for one repository, built with `createGitAccess`. It carries
  `expiresAt`; jobs have a hard timeout well below the token lifetime, so there is no refresh.
- The token of a `GitAccess` is readable as `access.token` but not enumerable: `JSON.stringify`,
  spreading, `Object.entries` and `console.log` leave it out. Only `revealGitAccess(access)` returns a
  plain copy with the token, for the runner API's `claim` response. Never log its result. A provider
  that returns a plain object with a visible token fails the conformance suite.
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
