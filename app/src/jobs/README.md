# Job queue

A job is one requested run of a command (`review`, `improve`, `describe`, `ask`) on one pull request.
The queue lives in SQLite (table `jobs`, migration `20261010191500_create_jobs`); runners take jobs
from it through the runner API (CR-28), webhooks and the UI put jobs in. Everything goes through
`createJobQueue` (`job-queue.ts`), which checks input and calls the jobs repository
(`src/db/repositories/jobs-repository.ts`, the only code that touches the table). The running server
gets its queue from `getJobQueue()` (`shared.ts`).

| File            | Role                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-queue.ts`  | `createJobQueue(db, options)`: `enqueue`, `claimNext`, `heartbeat`, `complete`, `release`, `cancelClaimed`, `cancelWaitingForRepository`, `discardWaitingForPr`, `expireStaleJobs`, `get`, `list` |
| `job-status.ts` | The statuses and the table of allowed transitions; the repository builds its update conditions from it                                                                                            |
| `job-input.ts`  | `validateEnqueueInput`: field level checks before anything is written                                                                                                                             |
| `job-types.ts`  | `Job`, the inputs and results, the trigger kinds and the error codes the queue itself writes                                                                                                      |
| `job-limits.ts` | Lease, maximum runtime and maximum attempts, with their defaults                                                                                                                                  |
| `errors.ts`     | `JobQueueError` with the stable codes `JOB_INPUT_INVALID` (with `fieldErrors`) and `JOB_REPOSITORY_UNKNOWN`                                                                                       |

Jobs refer to `repositories`, not to projects. Whether a repository has an active project is checked
by the code that enqueues (the trigger policy of the webhook handler, CR-31), not here.

## Statuses

```
queued --claim--> running --complete--> succeeded | failed
queued --newer automatic job--> superseded     running --lease lost or release--> queued (attempts + 1)
queued --project off / PR closed--> cancelled  running --last attempt lost, or too long--> failed
```

`succeeded`, `failed`, `superseded` and `cancelled` are final; nothing leads back from them. A
superseded job keeps `superseded_by`; a cancelled or failed job keeps its `error_code`
(`project_deactivated`, `pull_request_closed`, `lease_expired`, `timeout`, or the code a runner
reported).

## Enqueueing

`enqueue` runs in one transaction (the write lock is taken up front), in this order:

1. **Same delivery.** A job with the same `delivery_id` exists: it is returned (`same_delivery`). This
   makes the webhook route's claim and the enqueue safe to repeat.
2. **Automatic jobs** (`trigger_kind = webhook`): one per (repository, pull request, head commit,
   command) while it is waiting, running, succeeded or failed (`same_head`). A superseded or cancelled
   job frees the slot, so a commit that comes back (a force push to an old state) is reviewed again.
3. **Jobs a person started** (`comment`, `manual`): exempt from the head commit rule, but there is never a
   duplicate of a waiting or running job for the same pull request, command and arguments
   (`already_active`): the existing job is returned, and if it is waiting behind a `run_after` in the
   future (a debounced automatic job) it is made due now, because a person does not wait for a
   debounce. Different arguments are different jobs (two questions to `/ask`).
4. **Supersession.** A new automatic job replaces the waiting _automatic_ jobs of the same pull request,
   command and arguments (status `superseded`, `superseded_by` set). Waiting `comment` and `manual`
   jobs are never replaced, and a running job is never touched: the new job waits behind it, because
   only one job per pull request runs at a time.

`run_after` is `now` unless the caller passes a later time (the debounce of `synchronize` is policy and
is decided by the webhook handler's trigger policy, CR-31). A manual job is due at once.

Three partial unique indexes enforce the promises even if the code were wrong: one job per delivery id,
one automatic job per head commit and command in the slot-holding statuses, one running job per pull
request.

## Claiming, leases, attempts

`claimNext(runnerId)` runs in one transaction:

1. **Expire.** Running jobs whose lease ran out go back to `queued` with `attempts + 1`, runner and
   times cleared (the old runner is no longer the holder); on the last allowed attempt
   (`attempts + 1 >= maxAttempts`, default 3) the job is `failed` with `lease_expired` instead. Then
   running jobs claimed longer than `maxRuntimeMs` ago (default 25 minutes: the runner's 20 minute
   hard timeout plus 5) are `failed` with `timeout`, whatever their heartbeats say. The runtime is
   counted from the latest claim. No scheduler is needed: every claim does this.
2. **Claim.** One `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` hands out the oldest due
   job (`status = queued`, `run_after <= now`, ordered by `created_at`) of a pull request that has no
   running job. Two runners claiming at once are serialized by the write lock; each gets a different
   job or nothing.

That statement is the only dialect specific code (`src/db/repositories/jobs-claim.ts`); a port to
Postgres changes it (`FOR UPDATE SKIP LOCKED`) and nothing else.

### The lease token

Every claim gets a new random `lease_token`, returned by `claimNext` next to the job (it is not a field
of `Job` and is never listed or logged). `heartbeat`, `complete` and `release` take that token, not the
runner id, and answer `not_holder` for any other: a runner that stalled past its lease, was requeued
and claimed the same job again under the _same_ runner id cannot be confused with its own stale
execution. Requeueing clears the token; a finished job keeps it, so a repeated report is recognised.
`runner_id` is bookkeeping only.

`heartbeat(jobId, leaseToken)` sets `heartbeat_at` and extends the lease to now + 2 minutes (runners
beat every 30 seconds). It also enforces the hard limit: a job claimed longer ago than `maxRuntimeMs`
is failed with `timeout` by the heartbeat itself and the holder is told `not_holder`, so a runner busy
on a hung job learns to stop without anybody else claiming.

`complete(jobId, leaseToken, outcome)` finishes the job as `succeeded` or `failed` with the result and
error code. The holder keeps a job as long as the row is `running` with its token: a lease that has
run out but whose job nobody has taken yet does not cost it the job (an expired lease is acted on when
the next runner claims, not before). `complete` with the same outcome again answers
`already_completed`; with another outcome `outcome_conflict` (also what the holder of a job that the
expiry failed gets).

`release(jobId, leaseToken, reason, { retryAt? })` gives a claimed job back (runner shutdown, no token
for the repository). It is a lost attempt with the same rule as a lapsed lease: the job waits again
(from `retryAt`, default now), or, on the last allowed attempt, fails with `reason` as its error code.
`attempts` therefore never grows past the maximum.

## Dropping waiting jobs

`cancelWaitingForRepository(repositoryId)` (project deactivated) and
`discardWaitingForPr(repositoryId, prNumber)` (pull request closed) set waiting jobs to `cancelled`;
running jobs finish. Nothing is deleted.

`cancelClaimed(jobId, leaseToken, errorCode)` is the one exception for a _running_ job: the claim of the
runner API uses it when it finds the project of a just claimed job switched off. One statement keyed on
the job id and the lease token (running to cancelled), no attempt counted, never queued in between. It
is deliberately not a transition of the shared table (`canTransition`): `cancelWaiting...` derives its
statuses from that table and must never cancel a running job.

## Tests

`job-status.test.ts` and `job-input.test.ts` are unit tests of the pure rules. The queue itself is
tested against a real SQLite file in `job-queue.integration.test.ts` (time is moved by a hand-set
clock) and `job-queue-concurrency.integration.test.ts` (callers that overlap are real child
processes). `list` returns at most 100 jobs (500 at most) unless told otherwise. `integration-tests/webhooks/review-trigger-jobs.integration.test.ts` runs a signed
delivery through the webhook route into the queue. That the claim is the only dialect specific code is
checked in code review.

## For the tickets that build on it

- **CR-31 (triggers).** Done: the webhook handler applies the trigger policy before the intake
  (`src/webhooks/README.md`, "The trigger policy for automatic reviews"). It checks the active
  project, skips drafts and switched-off settings, compares a push with the pull request's current
  head commit (`getPullRequest`) _before_ enqueueing, debounces `synchronize` through `runAfter`
  (default 90 seconds, `REVIEW_DEBOUNCE_SECONDS`) and calls `discardWaitingForPr` when a pull request
  closes.
- **CR-24 (projects).** Done (CR-46): `createJobProjectHooks` (`project-hooks.ts`) calls `cancelWaitingForRepository` in the transaction of the deactivation; `src/projects/shared.ts` plugs it in.
- **CR-28/CR-29 (runner).** The runner API exists (`src/runner-api/README.md`); it uses `release` for
  "token creation failed". Its claim guard skips and cancels jobs of repositories
  without an active project (`project-claim-guard.ts`, wired in CR-46). The runner (CR-29) reports its
  shutdown through `complete` with the error code `runner_shutdown`; the runner API turns that into
  `release`, so the job is requeued with the attempt cap (the runner never calls `release` itself).
- **CR-32 (comments).** The provider does not cut `args`; the queue refuses more than 10 000 characters
  (the intake drops such a trigger with a log line instead of failing the delivery). Truncate to 2000
  with a note before the intake. Comment jobs are exempt from the head commit rule, so a captured signed
  comment body replayed under a new delivery id runs again once the previous job finished: record the
  comment id and dedupe on it.
