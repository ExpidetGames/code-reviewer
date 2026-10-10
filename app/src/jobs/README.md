# Job queue

A job is one requested run of a command (`review`, `improve`, `describe`, `ask`) on one pull request.
The queue lives in SQLite (table `jobs`, migration `20261010191500_create_jobs`); runners take jobs
from it through the runner API (CR-28), webhooks and the UI put jobs in. Everything goes through
`createJobQueue` (`job-queue.ts`), which checks input and calls the jobs repository
(`src/db/repositories/jobs-repository.ts`, the only code that touches the table). The running server
gets its queue from `getJobQueue()` (`shared.ts`).

| File            | Role                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-queue.ts`  | `createJobQueue(db, options)`: `enqueue`, `claimNext`, `heartbeat`, `complete`, `cancelWaitingForRepository`, `discardWaitingForPr`, `expireStaleJobs`, `get`, `list` |
| `job-status.ts` | The statuses and the table of allowed transitions; the repository builds its update conditions from it                                                                |
| `job-input.ts`  | `validateEnqueueInput`: field level checks before anything is written                                                                                                 |
| `job-types.ts`  | `Job`, the inputs and results, the trigger kinds and the error codes the queue itself writes                                                                          |
| `job-limits.ts` | Lease, maximum runtime and maximum attempts, with their defaults                                                                                                      |
| `errors.ts`     | `JobQueueError` with the stable codes `JOB_INPUT_INVALID` (with `fieldErrors`) and `JOB_REPOSITORY_UNKNOWN`                                                           |

Jobs refer to `repositories`, not to projects. Whether a repository has an active project is checked
by the code that enqueues (the trigger policy, CR-31), not here.

## Statuses

```
queued --claim--> running --complete--> succeeded | failed
queued --newer job--> superseded          running --lease lost--> queued (attempts + 1)
queued --project off / PR closed--> cancelled      running --last lease lost or too long--> failed
queued --failed before it started--> failed
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
   (`already_active`): the existing job is returned. Different arguments are different jobs (two
   questions to `/ask`).
4. **Supersession.** A new automatic job replaces the waiting jobs of the same pull request, command
   and arguments (status `superseded`, `superseded_by` set). A running job is never touched: the new
   job waits behind it, because only one job per pull request runs at a time.

`run_after` is `now` unless the caller passes a later time (the debounce of `synchronize` is policy and
belongs to the intake, CR-31). A manual job is due at once.

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

`heartbeat(jobId, runnerId)` sets `heartbeat_at` and extends the lease to now + 2 minutes (runners beat
every 30 seconds). `complete(jobId, runnerId, outcome)` finishes the job as `succeeded` or `failed`
with the result and error code. The runner holds a job as long as the row is `running` with its
`runner_id`: a lease that has run out but whose job nobody has taken yet does not cost the runner its
job (an expired lease is acted on when the next runner claims, not before). Both answer
`not_holder` for anyone else. `complete` with the same outcome again answers `already_completed`; with
another outcome `outcome_conflict` (also what a runner whose job was failed by the expiry gets).

## Dropping waiting jobs

`cancelWaitingForRepository(repositoryId)` (project deactivated) and
`discardWaitingForPr(repositoryId, prNumber)` (pull request closed) set waiting jobs to `cancelled`;
running jobs finish. Nothing is deleted.

## Tests

`job-status.test.ts` and `job-input.test.ts` are unit tests of the pure rules. The queue itself is
tested against a real SQLite file in `job-queue.integration.test.ts` (time is moved by a hand-set
clock) and `job-queue-concurrency.integration.test.ts` (callers that overlap are real child
processes). `integration-tests/webhooks/review-trigger-jobs.integration.test.ts` runs a signed
delivery through the webhook route into the queue. That the claim is the only dialect specific code is
checked in code review.
