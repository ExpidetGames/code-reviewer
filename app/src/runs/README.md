# Runs

A run is a job as a person sees it: a review (or `/improve`, `/describe`, `/ask`) on one pull request,
with its status, who or what started it, its times, the link to the review comment on GitHub and, if
it did not succeed, why. The **Runs** page lists them (newest first, filtered by project and status),
the page of one run shows the details, and the project list shows the status of each repository's
last run. Jobs are made and changed only by the job queue (`src/jobs`); this module reads them.

| File              | Role                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run-status.ts`   | Label, description and symbol of each status (a status is never told by color alone); which statuses can still change                                                                                              |
| `run-duration.ts` | `runDurationMs` (waiting: none; running: start to the given time; finished: start to end) and `formatDuration`; the clock is passed in                                                                             |
| `error-copy.ts`   | The plain-English sentence for every error code the queue, the claim of the runner API and the runner can store; a test requires one for each code. An unknown code gets a general sentence and is shown beside it |
| `run-view.ts`     | The boundary to the browser: `toRunRowView`, `toRunDetailView`. Only listed fields leave the server; of the stored result only the comment link and the log tail are read. `safeCommentUrl`, `cleanLog`            |
| `runs-service.ts` | `createRunsService` (`list`, `get`), `parseRunsFilter`, `createLastRunSource` (the real `LastRunSource` of the project list)                                                                                       |
| `http.ts`         | The handlers behind `GET /api/runs` and `GET /api/runs/:id`, the two polling routes (`src/app/api/runs/`)                                                                                                          |
| `shared.ts`       | The wiring of the running server: `getRunsService()` (with the secrets of the app removed from a log) and `getLastRunSource()`                                                                                     |
| `ui/`             | `RunsList`, `RunDetail`, `RunStatusBadge`, the page contents (`runs-page.tsx`, `run-detail-page.tsx`) and the browser side of the polling (`api.ts`)                                                               |

The read side of the table is `src/db/repositories/runs-repository.ts` (a join with the repository name,
newest first, and the newest job of each repository); it only reads. The list is read without the
stored result, the arguments and the lease (every open tab asks every few seconds), and the newest job
of a repository is one lookup per repository on the index `jobs_repository_recent`
(`repository_id, created_at, id`).

## What a person sees

| Status       | Label     | Meaning                                                                                                |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------ |
| `queued`     | Waiting   | Waiting for a runner (or for its debounce)                                                             |
| `running`    | Running   | A runner holds it                                                                                      |
| `succeeded`  | Succeeded | The review was published                                                                               |
| `failed`     | Failed    | Ended without a review; the error code is translated                                                   |
| `cancelled`  | Cancelled | Stopped before it produced a review (project switched off, pull request closed or turned into a draft) |
| `superseded` | Replaced  | A newer commit made it unnecessary; the page links the newer run                                       |

A run has no pull request title (the job stores the number, the address and the head commit), so none
is shown. The "Started by" line is `Automatic`, `Comment by <login>` or `Started by <login>`.

## Polling

The server renders the first snapshot; the browser then asks for newer ones (`useLiveSnapshot` in
`src/ui/`): the list every 3 seconds while a run waits or runs and every 5 seconds once everything is
settled (so a run that starts after the page was opened still appears: a deviation from the story's
"stop after the last state", which holds for the page of one run: it stops asking once the run is
settled). A page nobody looks at (another tab, or a page Next.js keeps mounted but hidden) does not
ask, and asks at once when it is shown again. A failed request keeps the last data on screen and shows
"Updating failed"; the next attempt runs on schedule, and the wait doubles with every further failure in
a row (up to a minute). A failure that asking again cannot fix (the session ended, the person is not
allowed, the run is gone) stops polling and says so. With Cache Components a page that was left stays
mounted, so state is tied to server data: the polled snapshot is shown only while the server snapshot
it was fetched next to is still the current one, and the list is keyed on its filter.

The duration of a running run is counted to the time of the answer (`generatedAt`), so a page renders
the same on the server and in the browser.

## What never leaves the server

The lease token, the runner id, the delivery id, the heartbeat and lease times, the `usage` of a result
and its `errorMessage` are not in any view, list, detail or polling answer (`run-view.ts` copies listed
fields only; tests search the answers for them). The log is cleaned (terminal escapes and control
characters out) and passed through the same redaction the runner API uses for results, with the secrets
the app knows. Everything that came from outside (project name, login, a question of `/ask`, the log)
is rendered as text. The links made from stored data are the comment link and the pull request link, and only when they are `https://github.com/` addresses
(`rel="noopener noreferrer"`, one rule: `safeGithubUrl`).

## Access

The pages and both routes need a session: the proxy answers `401` (data routes) or redirects (pages),
and every page and route calls `requireUser()` itself first. `GET /api/runs` takes `repository` and
`status` (`RUNS_FILTER_INVALID`, `400`, for a value it does not know); `GET /api/runs/:id` answers
`404 RUN_NOT_FOUND` for an unknown or malformed id. With Cache Components the page of a run streams, so
an unknown id shows the not-found page with status 200; the data route answers a real 404.

## Tests

Unit (`*.test.ts(x)` here): status, duration, error copy (every code has a sentence), the views (links,
logs, what is left out), the list and the detail component (rows, empty states, polling with fake
timers, text rendered as text). Integration: `runs-service.integration.test.ts` (real SQLite, runs made
through the queue with `src/test-support/runs.ts`), `ui/runs-page.integration.test.tsx` (the pages with
real data and the filter from the address), `integration-tests/http/runs-route*.integration.test.ts`
(the proxy in front of the routes, 401 and 403, the route files). E2E: `e2e/runs/runs.e2e.ts`, where a
pull request opened at the fake GitHub arrives as a signed delivery and the queue stands in for the
runner (`e2e/helpers/job-queue.ts`, `src/test-support/e2e-queue-child.ts`).
