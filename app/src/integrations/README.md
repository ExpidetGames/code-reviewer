# Integrations

Everything that depends on a git platform (GitHub, later Bitbucket and others) lives behind the
`IntegrationProvider` interface. Jobs, the runner API, the database and the UI know only the
normalized types below and never see a platform payload. An integration is one connection to a
platform; the MVP has exactly one kind, the GitHub App (`github_app`), implemented by its own tickets.

| File                      | Role                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                | `Integration`, `RepoRef`, `ReviewTrigger`, `GitAccess`, the `IntegrationType` set and the other `as const` sets            |
| `normalized.ts`           | Runtime guards (`isRepoRef`, `isReviewTrigger`, `isGitAccess`) with exact key sets, so a raw payload cannot pass as a type |
| `provider.ts`             | The `IntegrationProvider` interface                                                                                        |
| `config-schema.ts`        | Field-level validation of an integration's `config` (one error per field) and the secret-key guard                         |
| `registry.ts`             | `createIntegrationRegistry`, `integrationRegistry`: maps a type to its provider; the only place that imports a provider    |
| `errors.ts`               | `IntegrationError` with stable codes (`INTEGRATION_TYPE_UNKNOWN`, `INTEGRATION_PROVIDER_NOT_IMPLEMENTED`, ...)             |
| `provider-import-rule.ts` | The import rule that keeps providers out of the rest of the app (see "The boundary")                                       |
| `providers/<type>/`       | One folder per implementation (none yet; the GitHub App arrives with the GitHub integration tickets)                       |

The table is `integrations` (`src/db/migrations/0002_create_integrations.ts`), the only code that
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
  parseEvent(i: Integration, req: Request): Promise<ReviewTrigger | null>;
  canTrigger(i: Integration, t: ReviewTrigger): Promise<boolean>;
  jobAccess(i: Integration, repo: RepoRef): Promise<GitAccess>;
}
```

- `canTrigger` is about the trigger: may this event start a job (for example, does the comment author
  have write access)? It is not about the app's own permissions on the platform.
- `verifyWebhook` and `parseEvent` read a clone of the request (`req.clone()`), so the caller can read
  the body again. `parseEvent` returns `null` for a verified delivery that is of no interest.
- `jobAccess` returns a `GitAccess` for one repository. It carries `expiresAt`; jobs have a hard
  timeout well below the token lifetime, so there is no refresh.
- `GitAccess` (token) is never stored, never logged and never put into an error message.
- `credentials` and `webhook_secret` in the table are reserved for token integrations and are
  encrypted before they are used. A GitHub App keeps neither there: its private key and webhook secret
  live in the environment. `INTEGRATION_SECRET_STORAGE` in `types.ts` says what a type may store, and
  the repository refuses the rest. A `config` never holds a secret; keys that look like one
  (`privateKey`, `secret`, `token`, `password`, `credential`) are refused.

## Types and reserved values

`INTEGRATION_TYPES` is `["github_app"]`. Values are stored in the database, so they are never renamed
or reused. `github_token` and `bitbucket_cloud` are reserved (`RESERVED_INTEGRATION_TYPES`): the
registry answers them with `INTEGRATION_PROVIDER_NOT_IMPLEMENTED`, anything else it does not know with
`INTEGRATION_TYPE_UNKNOWN`.

## Adding a new integration

1. **Implementation.** Create `providers/<type>/` with a factory that returns an
   `IntegrationProvider`. Add the type to `INTEGRATION_TYPES` in `types.ts` (and to
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
imports the types, the interface or the registry. `provider-import-rule.ts` checks this on the whole
source tree and names every violating file; `provider-import-rule.test.ts` runs it in the unit tests.
Folding the same function into `verify:structure` is planned together with that script (see
`TESTING.md`).

## Testing without a platform

`src/test-support/fake-integration-provider.ts` has `fakeIntegrationProvider(options)`, a provider
that speaks a small made-up webhook format (`fakeWebhookRequest`) and translates it like a real one
would. Options: the repositories it lists, who may trigger, the access it hands out, a failure for
`jobAccess`. It records every call in `calls`. `fakeIntegration()` builds an `Integration` value.
Use it in jobs, runner API and UI tests; pass it to `createIntegrationRegistry({ github_app: fake })`
when the code under test resolves through a registry.
