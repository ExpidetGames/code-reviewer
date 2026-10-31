# Implementer: service and routes behind the form (#755)

Part of the Implementer of the factory deployment (epic #745, `plans/implementer-slice.md`). This folder is the server side of
"send off a task": which repositories, branches and models a person can pick, and the validated submit that writes a session, a
turn and a queued job. The page that uses it comes with #756. It follows the pattern of `manual-reviews`.

The routes exist only in a deployment with the capability `implementer` (the product `factory`, switched on by
`PRODUCT_CAPABILITIES`). Everywhere else every route below is **absent**: the access proxy answers it as a path that does not
exist (`src/capabilities/routes.ts`, class `implementer`, one entry per route file; `routes.test.ts` fails for a route without one),
and each route file asks again (`requireImplementerCapability()` in `shared.ts`, Next.js's own `notFound()`) before the session
or the database is looked at, so code-review.com hands out nothing.

| File                                    | Role                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts`                            | `createImplementerService`: `listRepositories()`, `listBranches(id)`, `listModels()`, `startTask(user, body)`; every rule is here                                                                                                                                                        |
| `models.ts`                             | `createImplementerModels`: the options of the model picker and the check at submit, one rule for both                                                                                                                                                                                    |
| `start-input.ts`                        | `validateStartInput`: the body, field by field, with `INSTRUCTION_MAX_LENGTH` (20,000)                                                                                                                                                                                                   |
| `branch-name.ts`                        | `checkBranchName`: the rules of `git check-ref-format --branch` plus 200 characters and "not the base branch"; one code per rule                                                                                                                                                         |
| `errors.ts`                             | `ImplementerError` with the stable codes, their HTTP status, the field `issues` and the model refusal `reason`s                                                                                                                                                                          |
| `http.ts`                               | The handlers behind the four routes: user first, then the origin, content type and body, then the service                                                                                                                                                                                |
| `shared.ts`                             | The wiring of the running server (`implementerServiceFor(workspaceId)`) and the second wall `requireImplementerCapability()`                                                                                                                                                             |
| `../db/implementer-job-shape.ts` (#752) | The one place that writes the pull request columns of a turn's job; the branch in `pr_url` is percent-encoded per part (#755). It lives in `db/` because the database layer imports it, and `implementer/` imports the database layer: the import cycle check (#715) allows no new cycle |

## Routes

All four are for every member (`start_implementer_task`, minimum role `member`; one line in `workspaces/permissions.ts` raises
it), run through `withWorkspace(...)` after the proxy, and answer `Cache-Control: no-store`. Every request is checked for where it
comes from (`Sec-Fetch-Site` / `Origin`), the body of the POST for `application/json` and 64 KB. Every refusal is `{ "error": <code> }`.

- `GET /api/w/:workspace/implementer/repositories`: `{ repositories: [{ id, fullName, writeGranted }] }`, the active
  repositories of the workspace whose integration is active (a project is not needed), by name. `writeGranted` is what the
  installation has accepted (`IntegrationProvider.installationPermissions`, asked once per installation); an installation the
  platform has removed or refuses reads as `false`, any other failure is `503`.
- `GET /api/w/:workspace/implementer/repositories/:repositoryId/branches`: `{ defaultBranch, branches, truncated }`, the default
  branch first, at most 100 names (`getRepositoryFacts` and `listBranches`).
- `GET /api/w/:workspace/implementer/models`: the options of the picker (below).
- `POST /api/w/:workspace/implementer/tasks` with `{ repositoryId, baseBranch, branch, instruction, model, costLimitCents?,
clientRequestId }`: `201 { runId, sessionId }`, `200` with the same ids for a client request id that was accepted before (nothing
  is written then). `model` is `{ entryId }` (operator's key) or `{ provider, model }` (own key).

| Status    | Code                                                                  | When                                                                                                            |
| --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 400       | `IMPLEMENTER_REQUEST_INVALID` (+ `issues`)                            | The body or the repository id is not usable; an issue is `{ field, code }`, a branch names the rule it breaks   |
| 403       | `IMPLEMENTER_CROSS_SITE_REQUEST`                                      | The request is from another site                                                                                |
| 404       | `IMPLEMENTER_REPOSITORY_NOT_FOUND`                                    | No such repository in this workspace (another workspace's looks the same), or the platform no longer lists it   |
| 404       | `IMPLEMENTER_BASE_BRANCH_NOT_FOUND`                                   | The repository has no branch with the base branch's name                                                        |
| 409       | `IMPLEMENTER_APP_NOT_INSTALLED`                                       | The integration is disabled, or GitHub answers 401, 403 or 404 for the installation or the repository           |
| 409       | `IMPLEMENTER_WRITE_NOT_GRANTED`                                       | The installation has not accepted contents write (#749); nothing else is asked of GitHub                        |
| 409       | `IMPLEMENTER_BRANCH_EXISTS`                                           | The new branch exists on GitHub, or a session of the repository holds the name: **a new branch name is needed** |
| 413 / 415 | `IMPLEMENTER_BODY_TOO_LARGE` / `IMPLEMENTER_CONTENT_TYPE_UNSUPPORTED` | A body over 64 KB; a body that is not `application/json`                                                        |
| 422       | `IMPLEMENTER_MODEL_NOT_ALLOWED` (+ `reason`)                          | The model is not one the claim would run (reasons in `errors.ts`)                                               |
| 422       | `EXCEEDS_OPERATOR_MAXIMUM` (+ `maximumCents`)                         | The cost limit is above the operator's maximum per turn                                                         |
| 503       | `IMPLEMENTER_GITHUB_UNAVAILABLE`                                      | GitHub failed, timed out, was rate limited or answered with something unusable; nothing was written             |

A request without a session is answered `401` and one from a person outside the workspace `404 not_found` by `withWorkspace`,
before any of this runs.

## The submit

In this order, each step ends the request on failure, and **nothing is written before the last one**:

1. the body is valid (`start-input.ts`; the new branch by `branch-name.ts`, which refuses a name equal to the base branch);
2. the repository is this workspace's (`repositories` is created for the workspace, every read filters by it), active, and its
   integration is active;
3. the installation holds `contents: write` (`installationPermissions`);
4. `getRepositoryFacts` — **always before `getBranch`**: `getBranch` answers `null` for a repository path that went stale, so a
   `null` is believed only after the path resolved;
5. `getBranch(base)` must exist (its sha becomes the job's `head_sha`), `getBranch(new)` must not;
6. the model is allowed (`models.check`, the rule of the picker);
7. a cost limit is at most the operator's maximum (`review_max_cost_cents`); none asked for is stored as none, and the maximum
   applies at the claim;
8. `queue.enqueueImplementerTurn`: session, turn and job in one transaction, then the Dispatcher is woken as for any job. A lost
   race on the branch name hits the unique index of the sessions and is `IMPLEMENTER_BRANCH_EXISTS`; two submits with one new
   branch give exactly one `201`.

A turn that fails before it starts keeps its branch name (accepted for this slice, #785), so the retry with the same name is
`IMPLEMENTER_BRANCH_EXISTS` too; the message says a new branch name is needed, and the form shows it. A retry of the _same_
request after the agent has pushed the branch is answered `409` as well, because the GitHub check comes before the queue's
idempotency; this is safe, and a lookup of the client request id before the GitHub reads is a follow-up.

The branch name is checked against git's rules at submit and the branch in the job's `pr_url` is percent-encoded part by part
(`#`, `%` and `+` stay in the path); `?`, `..` and the other characters git refuses never get that far.

## The models

One rule serves the picker (`models.options()`) and the submit (`models.check()`), and it is the claim's (#753): the agent is
OpenCode, so the native path is mandatory (an entry from the catalog and a cost policy). The key mode of the workspace decides:

- **own key**: the providers of the models.dev catalog (`src/native-providers/`) for which the workspace has saved a readable
  key, and the models the catalog lists. The registry's two providers (Anthropic, OpenRouter) are not on the native path and are
  not offered. Reasons: `provider_unsupported`, `no_key`, `model_not_in_catalog`.
- **operator's key**: the released catalog entries that serve Dynamic Review, that the plan allows (`modelAccess`) and whose model
  has a confirmed price and a catalog entry (`nativeCost.policyFor("managed")` and `entryFor`). A member sees the fields of
  `MemberCatalogEntry` only: never the provider or the model id (principle 2 of epic #420). Reasons: `entry_unknown`,
  `entry_not_released`, `entry_kind_mismatch`, `entry_not_allowed`, `entry_unavailable`.
- the other form of choice for the key mode is `wrong_key_mode`; entitlements that cannot be read give `key_mode_unreadable` and an
  empty picker.

## Tests

Unit: `branch-name.test.ts` (more than 30 names, a subset cross-checked against the real `git check-ref-format`), `start-input.test.ts`,
`models.test.ts`, `absent-routes.test.ts` (the proxy marks every route missing without the capability). Integration:
`service.integration.test.ts` (real Postgres, the real GitHub App provider and client against the fake GitHub, the real queue),
`http.integration.test.ts` (the handlers), `integration-tests/http/implementer-route-files.integration.test.ts` (the real route
files with the running server's wiring, also in the deployments without the capability). Byte-for-byte equality of the 404 with a
path that does not exist runs in the hosted lane (`e2e/hosted/capabilities.e2e.ts`).
