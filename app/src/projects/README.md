# Projects

A project is a repository the instance reviews. Repositories come from the GitHub sync
(`src/integrations/README.md`, table `repositories`, `active` = "GitHub still lists it"); a repository
becomes a project only when somebody activates it. New repositories are **not** reviewed until then.

| File         | Role                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts` | `createProjectService`: `activateProject`, `deactivateProject`, `getActiveProjectForRepository`, `hasActiveProject`, `listProjects`                                                                                                                                                                      |
| `errors.ts`  | `ProjectError` and the stable codes `PROJECT_REQUEST_INVALID` (400), `PROJECT_REPOSITORY_NOT_FOUND` (404), `PROJECT_REPOSITORY_UNAVAILABLE` (409), `PROJECT_INTEGRATION_UNAVAILABLE` (409), `PROJECT_CROSS_SITE_REQUEST` (403), `PROJECT_BODY_TOO_LARGE` (413), `PROJECT_CONTENT_TYPE_UNSUPPORTED` (415) |
| `hooks.ts`   | `ProjectHooks.onProjectDeactivated`, the seam the jobs module plugs into; the default does nothing                                                                                                                                                                                                       |
| `http.ts`    | The handler behind `PUT /api/w/:workspace/repositories/:repositoryId/project` (`src/app/api/w/[workspace]/repositories/[repositoryId]/project/route.ts`)                                                                                                                                                 |
| `shared.ts`  | The wiring of the running server: `projectServiceFor(workspaceId)`, `getProjectService()` (the workspace the signed-in user works in) and `getProjectHooks(workspaceId)`                                                                                                                                 |

The table is `projects` (`src/db/migrations/20261010190000_create_projects.ts`); the only code that
touches it is `src/db/repositories/projects-repository.ts`.

## States

| Status        | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `active`      | A project row exists with `active = 1` and the platform still lists the repository                |
| `inactive`    | No project row yet, a row only holding settings saved before activation, or a deactivated project |
| `unavailable` | The platform no longer lists the repository (removed from the installation, installation deleted) |

- The row is created by the first activation or by the first save of settings (`updateSettings`
  creates it with `active = 0`, so settings can be saved before activation) and **never deleted**. Deactivating sets `active = 0`;
  activating again switches the same row back on, so its settings (`projects.settings`, JSON text,
  the review setting overrides, `src/review-settings/README.md`) survive and there is never a second row (`repository_id` is unique).
- A repository that disappears from GitHub keeps its project row untouched, **including `active = 1`**.
  The list shows it as `unavailable`, it cannot be activated (`PROJECT_REPOSITORY_UNAVAILABLE`), and
  `getActiveProjectForRepository` / `hasActiveProject` answer "no project" for it, so no review is
  started for a repository the app cannot read. The same holds for a repository whose installation is
  suspended or removed (integration `disabled`): activation is refused with
  `PROJECT_INTEGRATION_UNAVAILABLE`, an existing project row stays as it is and does not count.
- **Decision: a repository that comes back resumes its project.** If the repository is added to the
  installation again, the sync makes it active again and a project that was on starts reviewing again,
  without anybody pressing a button; one that was off stays off. This is deliberate: re-adding a
  repository on GitHub is an explicit act of an administrator, and keeping the row keeps the settings.
  Consequences to know: no deactivation hook runs when a repository leaves (waiting jobs of an
  unavailable repository are dropped by the claim check of CR-28, which skips jobs without an active
  project), and CR-34 may want to say "will resume if the repository comes back" in the list. The
  alternative (the sync running the deactivate path when it flips a repository inactive) was rejected.
- Events that arrive while a project is inactive are not replayed on activation: a pull request opened
  in between needs a new push, a comment command or the manual start ("Review now", `src/manual-reviews/README.md`).
- `listProjects()` returns one entry per repository the platform lists, plus the ones that
  disappeared but have a project, ordered by name, each with its integration and its project (or
  `null`). A repository that disappeared and never had a project is left out.
- Activation checks the repository and writes in one transaction (transactions begin immediate), so
  two simultaneous activations create exactly one project and a sync cannot deactivate the repository
  between the check and the write. Activating a project that is on already is not an error: the answer
  says `changed: false`.

## Deactivating and the jobs

Deactivating a project stops new reviews and discards its **waiting** (unclaimed) jobs; a job that a
runner already holds (running) finishes. This module knows nothing about jobs. The jobs module
implements `ProjectHooks.onProjectDeactivated(event, executor)` (`createJobProjectHooks(workspaceId)` in
`src/jobs/project-hooks.ts`, which cancels the waiting jobs of the repository) and `getProjectHooks(workspaceId)` in
`shared.ts` returns it:

- It runs in the transaction that switches the project off. Write with `executor` (never the outer
  connection, see `src/db/README.md`), set the waiting jobs of the project's repository to `cancelled`,
  and everything commits together with the deactivation. A rejection rolls the deactivation back.
- It runs on every deactivation of a repository that has a project, also when the project was off
  already, so it must be idempotent; a repeated click finishes what a crashed call left.
- Race to keep in mind for the jobs module: the webhook route checks for an active project before it
  hands a trigger to the intake, and the intake enqueues afterwards. A trigger that passed the check
  just before the deactivation can enqueue a job after the hook ran. The `claim` of the runner API
  therefore asks again (`createProjectClaimGuard`, `src/runner-api`): a job whose repository has no
  active project is cancelled there (the claim is the line the runner cannot cross).

## Webhooks

The webhook route answers a review trigger for a repository without an active project with `202` and
the outcome `project_not_active`, and hands nothing to the intake (`src/webhooks/README.md`). That
covers a repository never activated, a deactivated project and an unavailable repository. The check
comes after the payload was read (only the payload says which repository it is about) and before
`canTrigger`.

**Known cost, follow-up:** for a comment command the provider's `parseEvent` asks GitHub twice (write
access of the commenter, head commit of the pull request) before the gate runs, so a commenter on a
repository that is not a project costs two API calls per command. A test pins this
(`project-gate.integration.test.ts`). The fix is to gate before parsing: let the provider expose the
repository of a delivery (like `identifyWebhook` does for the installation) and ask the project service
first.

## The route

The workspace is the one in the address, for a member only (`src/workspaces/README.md`); switching a project
on or off needs an Admin or an Owner (`manage_projects`), a Member sees the switch and cannot use it.

`PUT /api/w/:workspace/repositories/:repositoryId/project` with the JSON body `{ "active": true }` (activate) or
`{ "active": false }` (deactivate). Both are idempotent.

- Answers `200` with `{ repositoryId, projectId, active, changed }` (`projectId` is `null` for a
  repository that never had a project), always `Cache-Control: no-store`.
- Refusals are `{ "error": <code> }`: `400 PROJECT_REQUEST_INVALID` (body not JSON, not an object, or
  `active` not a boolean), `403 PROJECT_CROSS_SITE_REQUEST`, `413 PROJECT_BODY_TOO_LARGE` (over 1 KB),
  `415 PROJECT_CONTENT_TYPE_UNSUPPORTED` (not `application/json`), `404 PROJECT_REPOSITORY_NOT_FOUND`,
  `409 PROJECT_REPOSITORY_UNAVAILABLE` or `409 PROJECT_INTEGRATION_UNAVAILABLE`. (An id that is empty or
  longer than 128 characters is `PROJECT_REQUEST_INVALID`; any other id the lookup cannot match is
  `404`.) The checks run in this order after the user is known: where the request comes from, content
  type, size, JSON, then the service.
- The route is protected twice: the proxy answers `401` (no session) or `403` (a user the allow list
  turned away) before the route runs, and the route calls `requireUser()` first (the rule in
  `src/auth/README.md`), before it reads the body or the database.
- Two cheap layers sit on top of the `SameSite=Lax` session cookie against a request from another
  site: `Sec-Fetch-Site` must be `same-origin` or `none` (a sibling subdomain, `same-site`, is refused
  too); a browser that does not send it is judged by `Origin` against the host the request was addressed
  to (`X-Forwarded-Host`, `Host`). A client that sends neither is no browser and passes. And the body
  must be `application/json`, which a cross-site form cannot send without a preflight.
- If `requireUser()` is ever reached without a session (the proxy matcher changed), it redirects to the
  login page; the proxy normally answers 401/403 first.

## The pages

The Projects page (`src/app/(app)/w/[workspace]/projects/page.tsx`) and the settings page of one project
(`src/app/(app)/w/[workspace]/projects/[repositoryId]/page.tsx`) are built from `src/projects/ui/`:

| File                           | Role                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/list-view.ts`              | `loadProjectList` / `loadProjectRow`: one row per repository from `listProjects()` (or one from `findProject()`), with the status of its last run. `LastRunSource` is the seam for the jobs table (wired by `getLastRunSource()` in `src/runs/shared.ts`); without one the list says "No run yet".                                          |
| `ui/project-list.tsx`          | The list: name (a link to the settings for every repository, inactive ones too), installation, state, last run and the switch; the empty state with the install steps (`no-repositories.tsx`).                                                                                                                                              |
| `ui/project-toggle.tsx`        | The switch. Calls `PUT /api/w/:workspace/repositories/:id/project` and refreshes; a refusal is shown as a sentence (`ui/messages.ts`), never as a code. Off projects cannot be switched on while the GitHub App is not configured.                                                                                                          |
| `ui/sync-button.tsx`           | "Sync from GitHub": `POST /api/w/:workspace/integrations/sync`, says how many repositories are new and what went wrong at GitHub.                                                                                                                                                                                                           |
| `ui/projects-page.tsx`         | `loadProjectsPage` gathers the data from the services, `ProjectsPageContent` renders the hints and the list.                                                                                                                                                                                                                                |
| `ui/project-settings-page.tsx` | The settings page of a project: the form of `src/review-settings/ui` for the overrides; every repository of the list has a settings page, also an inactive one (it says that no reviews run until the project is activated); an unknown id shows the not-found page (status 200: under Cache Components the data sits behind `<Suspense>`). |

The components never touch the database: pages call the services (`getProjectService()`,
`getReviewSettingsService()`), the browser calls the routes above. Everything that comes from GitHub
(repository names, installation names, addresses) is untrusted and rendered as text; a repository
address becomes a link only when it is an http(s) address. The configuration hints
(`src/config-status/`) name the variables of a missing GitHub App setting or LLM key, never a value.

**Review now:** the settings page of an active project starts with the `StartReviewPanel` of
`src/manual-reviews/ui` (pick an open pull request and a command, start it); a project that is off says
that reviews can be started by hand only while it is active.

**Last run:** `projects/page.tsx` passes `getLastRunSource()` (`src/runs/shared.ts`) to
`loadProjectsPage`: the newest job of each repository, whatever its status, with the time it last
changed (finished, else started, else queued). The list links it to the runs of that project.

## Testing

`projects-repository.integration.test.ts` (SQL, concurrency), `service.integration.test.ts` (codes,
hook), `http.integration.test.ts` (the handler), `integration-tests/http/projects-route.integration.test.ts`
(the proxy in front: 401, 403), `integration-tests/http/projects-route-file.integration.test.ts` (the
real route file) and `integration-tests/webhooks/project-gate.integration.test.ts` (the
webhook route). `startWebhookHarness().seedInstallation()` activates the seeded repository by default;
pass `{ activateProject: false }` to test the opposite.
