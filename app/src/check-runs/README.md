# Check runs and the review verdict (#405)

A review shows up on its pull request as the check run **Code Reviewer** (Waiting, Reviewing, a conclusion) and, after
a successful review, as a pull request review of the App (`REQUEST_CHANGES` or `APPROVE`). The operator view of this
is in `docs/github-app.md`, "Check runs and the review verdict".

## Where it happens

In the App, not in the Worker or the runner: the App holds the installation token and sees every way a job changes
(enqueue, claim, result, release, cancel, supersede, a lease that ran out, a timeout, a give-up, a project switched
off). Worker tokens do not get `checks: write`.

`createCheckRunService(...).syncJob(jobId)` (`service.ts`) reads the job and does whatever GitHub still lacks. It never
throws, never changes the job, and is safe to repeat; the row `job_check_runs` (one per job, `src/db/repositories/
job-check-runs-repository.ts`, scoped by workspace) keeps what was synced, so a repeat with nothing new makes no call.

| Caller                                              | When                                                                                                                           | File                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Queues, after the response (`after()`)              | enqueue (and the jobs it superseded), claim, result, release, cancel, a heartbeat that learns of a supersede or a hard timeout | `notifying-queues.ts`, attached in `src/jobs/shared.ts` |
| `reconcileDue()` from the sweep                     | serverless (Vercel): the step `checks` repairs what the requests did not (lease expiry, give-up, timeout)                      | `src/dispatch/sweep.ts`                                 |
| `reconcileDue()` from the opportunistic maintenance | webhook mode of a hosted deployment, no timer                                                                                  | `src/dispatch/opportunistic.ts`                         |
| `reconcileDue()` from a timer every minute          | a long-lived server (Compose, Coolify), production only                                                                        | `startup.ts`, `src/instrumentation.ts`                  |

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
- Unknown counts, and a Dynamic review that stopped at its cost or time limit, never approve.

Only a pull request that is open and still at the reviewed head gets the review (a stale head or a closed pull
request is a logged skip). The body is a verdict line, a link to the self-updating summary comment and a hidden marker
(`<!-- code-reviewer:verdict job=... -->`) by which a review whose id was not stored is found again. A failed,
cancelled or superseded job submits nothing. A later run submits a new review; GitHub counts the latest review of a
reviewer, so the App dismisses nothing, and human reviews are never touched.

## Failure behaviour

A GitHub failure is one log line with a stable code (`CHECK_RUN_LOG_CODES` in `service.ts`; ids only, never a token or a
body) and a retry with a back-off, given up after `MAX_ATTEMPTS`. An App without `checks: write` gets
`CHECK_RUN_PERMISSION_MISSING` once per job and its row's check part is dropped; the verdict goes on. A refused review
(own pull request, 403, 422) is `REVIEW_VERDICT_REFUSED` and dropped. The permission shows up in the admin portal
through `missingPermissions`.
