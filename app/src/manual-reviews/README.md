# Manual start

A person can start a command (`review`, `improve`, `describe`, `ask`) for an open pull request of an
active project from the project page ("Review now"). The job goes through the same queue as every
other trigger, as a `manual` job with the login of the person (`src/jobs/README.md`); the run shows up
on the Runs page as "Started by <login>".

| File                          | Role                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts`                  | `createManualReviewService`: `listOpenPullRequests(repositoryId)` and `startReview(user, repositoryId, input)`; all rules are here |
| `start-input.ts`              | `validateStartInput`: the body (`prNumber`, `command`, `question` for `ask`), checked field by field                               |
| `errors.ts`                   | `ManualReviewError` with the stable codes (`MANUAL_REVIEW_*`), their HTTP status and the field `issues`                            |
| `http.ts`                     | The handlers behind the two routes: user first, then origin, content type and body, then the service                               |
| `shared.ts`                   | The wiring of the running server (`getManualReviewService()`)                                                                      |
| `ui/start-review-panel.tsx`   | The client panel: loads the list, picks, validates the question, sends, shows the answer and a link to the run                     |
| `ui/pull-request-list.tsx`    | The radio list of pull requests (number, title, author, draft); the empty state                                                    |
| `ui/command-fields.tsx`       | The command choice and, for `ask`, the question field                                                                              |
| `ui/api.ts`, `ui/messages.ts` | The two calls of the panel; the sentence for every code                                                                            |

## Routes

Both are behind the access proxy and call `requireUser()` first (`src/auth/README.md`). Every answer
is `Cache-Control: no-store`.

- `GET /api/repositories/:repositoryId/pull-requests`: `{ repositoryId, fullName, allowedCommands,
pullRequests: [{ number, title, url, author, draft, headRef, baseRef }] }`, the open pull requests
  (drafts included), newest first, read from the platform through `IntegrationProvider.listOpenPullRequests`
  (every page). The head commit is not part of the answer.
  The pages are read one after the other (up to 100 per page, 100 pages at most) every time the panel
  is shown or the list is refreshed; fine for the MVP, and the calls share the rate limit of the
  installation with the jobs.
- `POST /api/repositories/:repositoryId/reviews` with `{ "prNumber": 7, "command": "review" }` (and
  `"question"` for `ask`): `201 { runId, created: true, prNumber, command }` for a new run, `200` with
  `created: false` for the run that was already waiting or running.

| Status    | Code                                                            | When                                                                                                  |
| --------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 400       | `MANUAL_REVIEW_REQUEST_INVALID` (+ `issues`)                    | The number is not a positive integer, the command is unknown, an `ask` has no or a too long question  |
| 403       | `MANUAL_REVIEW_CROSS_SITE_REQUEST`                              | `Sec-Fetch-Site` / `Origin` say the request is from another site                                      |
| 404       | `MANUAL_REVIEW_PROJECT_NOT_FOUND`                               | Unknown repository, or no active project (also what a repository of no installation looks like)       |
| 404       | `MANUAL_REVIEW_PULL_REQUEST_NOT_FOUND`                          | GitHub has no pull request with this number in the repository (a number of another repository, too)   |
| 409       | `MANUAL_REVIEW_PULL_REQUEST_NOT_OPEN`                           | The pull request is closed or merged now                                                              |
| 409       | `MANUAL_REVIEW_COMMAND_NOT_ALLOWED`                             | The project switched the command off (`allowedCommands`)                                              |
| 409       | `MANUAL_REVIEW_APP_NOT_INSTALLED`                               | The integration is disabled, or GitHub answers 401, 403 or 404 for the installation or the repository |
| 413 / 415 | `MANUAL_REVIEW_BODY_TOO_LARGE` / `..._CONTENT_TYPE_UNSUPPORTED` | A body over 16 KB; a body that is not `application/json`                                              |
| 502       | `MANUAL_REVIEW_GITHUB_UNAVAILABLE`                              | GitHub failed, timed out, was rate limited or answered with something unusable                        |

A request without a session is turned away by the proxy (`401`, `403` for an account that is not
allowed) before any of this runs.

## The rules of a start

The same as for the other triggers, in this order: the body is valid; the repository has an active
project (and its integration is not disabled); the project allows the command; GitHub itself says the
pull request exists and is open (the browser names only the number, the head commit and the pull
request address come from GitHub, the login from the session); then `queue.enqueue` with
`triggerKind: "manual"`. The queue does the rest (`src/jobs/README.md`, "Enqueueing"): a waiting or
running job for the same pull request, command and arguments is returned instead of a second one
(and a debounced automatic job is made due now), a manual job is due at once, and two starts at the
same moment give one job. Draft pull requests can be started.

`ask` takes a question of at most 2000 characters. Markdown images and links to images are replaced
like in a comment, because PR-Agent would fetch them from the runner, and the limit counts the text
that is left (each image link grows to `[image link removed]`, so `![]` repeated 666 times is too long
although it is shorter as written). A longer question is refused with `too_long` (the comment trigger
cuts it instead); anything above 8000 characters is refused without being looked at. The other
commands carry no text.

## The panel

The panel (`ui/start-review-panel.tsx`) is on the settings page of an active project, keyed on the
repository. It loads the list in an effect, so with Cache Components (which keeps a page that was left
mounted but hidden) it asks again when the page is shown again. A failed load shows a sentence and
"Try again"; a start that finds the pull request closed or gone says so and loads the list again. A
second press while a request is on its way does nothing. Titles and names come from GitHub and are
only ever rendered as text; the link to a pull request is made only for `https://github.com/`
addresses.

## Tests

Unit: `start-input.test.ts`, `ui/*.test.ts(x)`. Integration: `service.integration.test.ts` (real
SQLite, the real GitHub App provider and client against the fake GitHub, the real queue),
`http.integration.test.ts` (the handlers), `integration-tests/http/manual-review-route.integration.test.ts`
(the access proxy in front), `integration-tests/http/manual-review-route-file.integration.test.ts` (the
real route files). Journeys: `e2e/reviews/manual-start.e2e.ts`; the runner is stood in for by the job
queue (`claimNextRun`, `completeRun`), the full path through the real runner is the ticket CR-47.
