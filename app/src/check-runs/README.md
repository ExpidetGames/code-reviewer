# Check runs and the review verdict (#405)

A review shows up on its pull request as the check run **Code Reviewer** (Waiting, Reviewing, a conclusion) and, after
a successful review, as a pull request review of the App (`REQUEST_CHANGES` or `APPROVE`). The check's name is a field of the
product identity (`checkName`), so another product names its own. The operator view of this
is in `docs/github-app.md`, "Check runs and the review verdict".

## Where it happens

In the App, not in the Worker or the runner: the App holds the installation token and sees every way a job changes
(enqueue, claim, result, release, cancel, supersede, a lease that ran out, a timeout, a give-up, a project switched
off). Worker tokens do not get `checks: write`.

`createCheckRunService(...).syncJob(jobId)` (`service.ts`) reads the job and does whatever GitHub still lacks. It never
throws, never changes the job, and is safe to repeat; the row `job_check_runs` (one per job, `src/db/repositories/
job-check-runs-repository.ts`, scoped by workspace) keeps what was synced, so a repeat with nothing new makes no call.

| Caller                                              | When                                                                                                                                                            | File                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Queues, after the response (`after()`)              | enqueue (and the jobs it superseded), claim (and every job it refused, #632), result, release, cancel, a heartbeat that learns of a supersede or a hard timeout | `notifying-queues.ts`, attached in `src/jobs/shared.ts` |
| `reconcileDue()` from the sweep                     | serverless (Vercel): the step `checks` repairs what the requests did not (lease expiry, give-up, timeout)                                                       | `src/dispatch/sweep.ts`                                 |
| `reconcileDue()` from the opportunistic maintenance | webhook mode of a hosted deployment, no timer                                                                                                                   | `src/dispatch/opportunistic.ts`                         |

So no check stays `in_progress`: a job that ends without a request of its own is found by the next reconcile.

## The check run

`check-text.ts` maps the job to what GitHub shows: `queued` "Waiting", `running` "Reviewing", `succeeded` completed
`success` (open findings per severity where known, a link to the review comment), everything else completed
**`neutral`** with a reason in words (failed, timed out, cancelled, "Superseded by a newer commit"). It is never
`failure`. A job given back to the queue goes back to `queued` and the next claim reuses the same check run. A job
cancelled or superseded before any check run existed gets none. The check run is updated by its stored id; one made
but not stored (a crash) is found again by `external_id` (the job id), so there is exactly one.

## The verdict

`verdict.ts` decides from the project setting `reviewVerdict` (`off`, `blocking` the default, `any`; the setting
lives with the review kind, `src/review-settings/`) and `findings` of the runner's result (`ReviewFindings`, additive in
`contracts/runner-api.v1.json`):

- Dynamic review (P0 to P3): `blocking` means a P0 finding, `any` means any open finding. Blocking findings give
  `REQUEST_CHANGES`, otherwise `APPROVE`.
- Diff review (PR-Agent, no severities): `blocking` submits nothing (it cannot tell a blocker from a nit and does not
  approve blindly); `any` means any active finding.
- **`APPROVE` needs a whole review.** It is never submitted when the counts are unknown, the Dynamic review stopped at
  its cost or time limit, the result says `findings.incomplete` (the runner reports it when the validation dropped a
  finding, or, for a Diff review, when PR-Agent's own record says the run was not complete: a failed chunk, files left
  out because the pull request did not fit the model's window, an incremental run), or the run made no model call (`usage.aiCalls`) or did not report its
  usage. A blocker that was found still requests changes. The verdict is a function of what the model reported; this
  is the part the app can check, and the docs say the rest (it can be manipulated; a human code owner is the gate).
- **A skipped verdict leaves an earlier one in place** (fail closed) and the check run says why no verdict was
  submitted. Only `off` takes the App's own latest `REQUEST_CHANGES` back, by dismissing it with a message
  (`provider.withdrawReviewVerdict`: the review of the App's login that carries `VERDICT_MARKER_PREFIX` and still
  asks for changes; any other review is never touched). Every such request of the App that stands is dismissed, not
  only the latest, because GitHub may count an earlier one of the same reviewer once the latest is gone. `off` costs
  GitHub calls only where the App asked for changes: the table remembers what the App did to a pull request
  (`job_check_runs.review_event`: `approve`, `request_changes`, `withdrawn`), and a skipped verdict records none, so
  the request stays on record. A request that this database does not know of (made before the feature, or by an
  instance with another database) is not looked for; dismiss it by hand.

Only a pull request that is open and still at the reviewed head gets the review (a stale head or a closed pull
request is a logged skip). The check of the head and the submit are two calls: a push in between puts the review on
the old commit, which GitHub accepts and shows as outdated; the review of the new head follows and replaces it. The
body is a verdict line, a link to the self-updating summary comment and a hidden marker
(`<!-- code-reviewer:verdict job=... -->`) by which a review whose id was not stored is found again. The link is
only ever a comment of this very pull request (`trustedCommentUrl`): a result is data from a worker. A failed,
cancelled or superseded job submits nothing. A later run submits a new review; GitHub counts the latest review of a
reviewer, and human reviews are never touched.

## Failure behaviour

A GitHub failure is one log line with a stable code (`CHECK_RUN_LOG_CODES` in `service.ts`; ids only, never a token or a
body). The work is bounded in time and in tries:

- A sync has a time budget (`budgetMs`: 15 s after a response, 15 s in the opportunistic maintenance, 40 s in the sweep
  and the timer) and a call in flight is cut off when it is over. Switching a token off after a call has a timeout of
  its own (3 s) and is not waited for once the time of the sync is over, so a sync overruns its budget by 3 s at most
  (a slow GitHub, a token to switch off), never by a whole request timeout. A call that could not reach GitHub is
  repeated twice in the same request (after 1 s and 3 s, as a repeat that may find what the first one made). The
  start of a sync counts as an attempt (`attempts` in `job_check_runs`, reset when a sync finishes), so a sync that is
  killed halfway is not forgotten, and the row is dropped once it has started `MAX_ATTEMPTS` (5) without finishing.
- A failed sync waits `2 min x attempts` (at most an hour; a rate limit as long as GitHub says) and is taken again by
  the sweep, the timer or the opportunistic maintenance.
- **While a check run is open on GitHub** (made, not completed) the row gets `MAX_OPEN_ATTEMPTS` (30, about fifteen
  hours) instead, so an outage cannot leave "Reviewing" behind. The same holds for a permission that was taken away
  after the check run was made, and for a connection that is switched off (`disabled`): the row waits for it to come
  back. A check run that is **not** known to exist is dropped after five.
- **What stays open for good**, and is logged: the installation is gone (`INTEGRATION_ACCESS_CONNECTION_GONE`), the
  repository was archived or left the installation (`CHECK_RUN_REPOSITORY_ARCHIVED`,
  `CHECK_RUN_REPOSITORY_NOT_ACCESSIBLE`), the connection was disconnected by a person, or the tries above ran out.
- An App without `checks: write` gets `CHECK_RUN_PERMISSION_MISSING` once per job and its row's check part is
  dropped; the verdict goes on. The App is believed to lack the permission for ten minutes
  (`PERMISSION_MEMORY_MS`), so the jobs that follow ask GitHub for no token. Only GitHub's own "Resource not
  accessible by integration" counts as a missing permission; an archived repository and one outside the installation
  have their own codes, and a 403 for another reason is retried like any failure.
- A refused review (own pull request, 403, 422) is `REVIEW_VERDICT_REFUSED` and dropped. An App that may not review is
  believed so for ten minutes too: the jobs that follow ask GitHub for nothing and log it once.
- The review comment of a run (#657): after a run that links to a comment of its pull request, the sync reads that
  comment once, with a token limited to the repository and `issues: read`, and keeps the body of the app's own comment on
  the row (`job_check_runs.review_comment`) for the Findings of the run page. A comment that is gone, written by somebody
  else, or whose links (`issue_url`, else `html_url`) do not name this repository and pull request is kept as an empty
  text (the id comes from the runner's result). A read that fails is `REVIEW_COMMENT_UNREADABLE`, one log line, no retry and no effect on
  the check run or the verdict; the run page then shows the link to the comment only.
- A check run that was made and whose id was not kept (the response was lost) is found again by its `external_id`
  (the job id) on the commit; this is also done for a job that was cancelled or replaced meanwhile, so that run is
  completed `neutral` and none is made.
- The **Re-run** button of a check run sends `check_run.rerequested`, which the App does not subscribe to: it does
  nothing. A new push or `/review` runs the review again.
- The permission shows up in the admin portal through `missingPermissions`.
