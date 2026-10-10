# Projects

A project is a repository the instance reviews. Repositories come from the GitHub sync
(`src/integrations/README.md`, table `repositories`, `active` = "GitHub still lists it"); a repository
becomes a project only when somebody activates it. New repositories are **not** reviewed until then.

| File         | Role                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts` | `createProjectService`: `activateProject`, `deactivateProject`, `getActiveProjectForRepository`, `hasActiveProject`, `listProjects`               |
| `errors.ts`  | `ProjectError` and the stable codes `PROJECT_REQUEST_INVALID` (400), `PROJECT_REPOSITORY_NOT_FOUND` (404), `PROJECT_REPOSITORY_UNAVAILABLE` (409) |
| `hooks.ts`   | `ProjectHooks.onProjectDeactivated`, the seam the jobs module plugs into; the default does nothing                                                |
| `http.ts`    | The handler behind `PUT /api/repositories/:repositoryId/project` (`src/app/api/repositories/[repositoryId]/project/route.ts`)                     |
| `shared.ts`  | The wiring of the running server: `getProjectService()` and `getProjectHooks()`                                                                   |

The table is `projects` (`src/db/migrations/20261010190000_create_projects.ts`); the only code that
touches it is `src/db/repositories/projects-repository.ts`.

## States

| Status        | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `active`      | A project row exists with `active = 1` and the platform still lists the repository                |
| `inactive`    | No project row yet, or the project was deactivated                                                |
| `unavailable` | The platform no longer lists the repository (removed from the installation, installation deleted) |

- The row is created by the first activation and **never deleted**. Deactivating sets `active = 0`;
  activating again switches the same row back on, so its settings (`projects.settings`, JSON text,
  written by the settings ticket) survive and there is never a second row (`repository_id` is unique).
- A repository that disappears from GitHub keeps its project row untouched. The list shows it as
  `unavailable`, it cannot be activated (`PROJECT_REPOSITORY_UNAVAILABLE`), and
  `getActiveProjectForRepository` / `hasActiveProject` answer "no project" for it, so no review is
  started for a repository the app cannot read. If it comes back, the sync makes the repository active
  again and a project that was on starts reviewing again; one that was off stays off.
- `listProjects()` returns one entry per repository the platform lists, plus the ones that
  disappeared but have a project, ordered by name, each with its integration and its project (or
  `null`). A repository that disappeared and never had a project is left out.
- Activation checks the repository and writes in one transaction (transactions begin immediate), so
  two simultaneous activations create exactly one project and a sync cannot deactivate the repository
  between the check and the write. Activating a project that is on already is not an error: the answer
  says `changed: false`.

## Deactivating and the jobs

Deactivating a project stops new reviews and discards its **waiting** (unclaimed) jobs; a job that a
runner already holds (running) finishes. This module knows nothing about jobs. The jobs module (CR-27)
implements `ProjectHooks.onProjectDeactivated(event, executor)` and returns it from `getProjectHooks()`
in `shared.ts`:

- It runs in the transaction that switches the project off. Write with `executor` (never the outer
  connection, see `src/db/README.md`), set the waiting jobs of the project's repository to `cancelled`,
  and everything commits together with the deactivation. A rejection rolls the deactivation back.
- It runs on every deactivation of a repository that has a project, also when the project was off
  already, so it must be idempotent; a repeated click finishes what a crashed call left.
- Race to keep in mind for the jobs module: the webhook route checks for an active project before it
  hands a trigger to the intake, and the intake enqueues afterwards. A trigger that passed the check
  just before the deactivation can enqueue a job after the hook ran. `claim` (CR-28) should therefore
  also skip jobs whose repository has no active project (the claim is the line the runner cannot cross).

## Webhooks

The webhook route answers a review trigger for a repository without an active project with `202` and
the outcome `project_not_active`, and hands nothing to the intake (`src/webhooks/README.md`). That
covers a repository never activated, a deactivated project and an unavailable repository. The check
comes after the payload was read (only the payload says which repository it is about, and for a comment
command that already costs a GitHub call) and before `canTrigger`.

## The route

`PUT /api/repositories/:repositoryId/project` with the JSON body `{ "active": true }` (activate) or
`{ "active": false }` (deactivate). Both are idempotent.

- Answers `200` with `{ repositoryId, projectId, active, changed }` (`projectId` is `null` for a
  repository that never had a project), always `Cache-Control: no-store`.
- Refusals are `{ "error": <code> }`: `400 PROJECT_REQUEST_INVALID` (body not `{ "active": boolean }`,
  larger than 1 KB, or a content type other than `application/json`), `404 PROJECT_REPOSITORY_NOT_FOUND`,
  `409 PROJECT_REPOSITORY_UNAVAILABLE`. (An id that is empty or longer than 128 characters is
  `PROJECT_REQUEST_INVALID`; any other id the lookup cannot match is `404`.)
- The route is protected twice: the proxy answers `401` (no session) or `403` (a user the allow list
  turned away) before the route runs, and the route calls `requireUser()` first (the rule in
  `src/auth/README.md`), before it reads the body or the database.
- Insisting on `application/json` is also the defense against a cross-site form: a browser can send
  `text/plain` or form data to another site with the user's cookie, but not JSON without a preflight.

The project list page and its buttons are the UI ticket (CR-34); it calls this route (or a Server
Function that calls the service and starts with `requireUser()`) and reads `listProjects()`.

## Testing

`projects-repository.integration.test.ts` (SQL, concurrency), `service.integration.test.ts` (codes,
hook), `http.integration.test.ts` (the handler), `integration-tests/http/projects-route.integration.test.ts`
(the proxy in front: 401, 403) and `integration-tests/webhooks/project-gate.integration.test.ts` (the
webhook route). `startWebhookHarness().seedInstallation()` activates the seeded repository by default;
pass `{ activateProject: false }` to test the opposite.
