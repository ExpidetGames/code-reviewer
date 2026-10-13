# Job queue

A job is one requested run of a command (`review`; `/ask`, `/improve` and `/describe` were removed)
on one pull request.
The queue lives in SQLite (table `jobs`, migration `20261010191500_create_jobs`); runners take jobs
from it through the runner API (CR-28), webhooks and the UI put jobs in. Everything goes through
`createJobQueue` (`job-queue.ts`, scoped to one workspace) and `createRunnerQueue` (`runner-queue.ts`, the
lease side, for the whole instance). They call the jobs repositories
(`src/db/repositories/jobs-repository.ts` and `runner-jobs-repository.ts`, the only code that changes the
table). The running server gets its queues from `jobQueueFor(workspaceId)` / `getJobQueue()` (the
workspace the signed-in user works in) and `getRunnerQueue()` (`shared.ts`). The pages that show runs read the table through
`src/db/repositories/runs-repository.ts` (read only; `src/runs/README.md`).

| File              | Role                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-queue.ts`    | `createJobQueue(db, workspaceId, options)`: `enqueue`, `cancelWaitingForRepository`, `discardWaitingForPr`, `discardWaitingAutomaticForPr`, `get`, `list`. A job of another workspace is not there for it                                                                                                                    |
| `runner-queue.ts` | `createRunnerQueue(db, options)`: `claimNext`, `heartbeat`, `complete`, `release`, `cancelClaimed`, `expireStaleJobs`, `get`. **Not scoped**: runners serve the whole instance, a claim hands out the oldest due job of any workspace, and every change is fenced by the lease token. The `Job` it returns has `workspaceId` |
| `job-status.ts`   | The statuses and the table of allowed transitions; the repository builds its update conditions from it                                                                                                                                                                                                                       |
| `job-input.ts`    | `validateEnqueueInput`: field level checks before anything is written                                                                                                                                                                                                                                                        |
| `job-types.ts`    | `Job`, the inputs and results, the trigger kinds and the error codes the queue itself writes                                                                                                                                                                                                                                 |
| `job-limits.ts`   | Lease, maximum runtime and maximum attempts, with their defaults                                                                                                                                                                                                                                                             |
| `errors.ts`       | `JobQueueError` with the stable codes `JOB_INPUT_INVALID` (with `fieldErrors`) and `JOB_REPOSITORY_UNKNOWN`                                                                                                                                                                                                                  |

Every job belongs to the workspace of its repository (`jobs.workspace_id`; the database refuses a job
whose repository is in another workspace, which `enqueue` reports as `JOB_REPOSITORY_UNKNOWN`). Jobs
refer to `repositories`, not to projects. Whether a repository has an active project is checked
by the code that enqueues (the trigger policy of the webhook handler, CR-31), not here.

## Statuses

```
queued --claim--> running --complete--> succeeded | failed
queued --newer automatic job--> superseded     running --lease lost or release--> queued (attempts + 1)
queued --project off / PR closed--> cancelled  running --last attempt lost, or too long--> failed
queued --review kind changed--> cancelled
```

`succeeded`, `failed`, `superseded` and `cancelled` are final; nothing leads back from them. A
superseded job keeps `superseded_by`; a cancelled or failed job keeps its `error_code`
(`project_deactivated`, `pull_request_closed`, `review_kind_changed`, `lease_expired`, `timeout`, or
the code a runner reported).

## The review kind of a job (#195)

A job is queued for exactly one review kind, `diff` (PR-Agent) or `dynamic` (the read-only agent of
the epic), stored in `jobs.review_kind`. It is resolved when the job is enqueued, from the project's
stored settings, **inside the enqueue transaction** (`review-kind.ts`). Before resolving the kind,
`jobs-repository.ts` locks the workspace-scoped repository row, the same row settings saves lock
with `FOR UPDATE` on PostgreSQL (including before the first project row exists). SQLite uses its
immediate transaction write lock. Both retain the lock through commit, so a concurrent kind change
can never leave a stale-kind job waiting. A producer never passes a kind; a repository without a project row is Diff.

The rollout gate: Dynamic Review is only **queued** when the instance setting `dynamic_review` says
`{ enabled: true }` (`dynamic-review-gate.ts`), default off until #202 ships. With the gate off, a
Dynamic project still gets a run, and that run is created `failed` with `dynamic_review_disabled` —
visible in Runs, never a silent Diff review and never a Dynamic row a previous-release app could
claim. PostgreSQL queue writers take the instance gate advisory lock before row locks: shared for
enqueue/settings, exclusive for gate changes and runner transitions; multi-row operations then lock
jobs by ascending id (full order: `contracts/README.md`). Disabling cancels queued Dynamic work and
leaves running jobs, their leases/heartbeats and PR slots unchanged. A release or lease expiry with
the gate off fails Dynamic work with `dynamic_review_disabled` instead of requeueing it. Use the
instance settings repository setter; a raw SQL update bypasses this boundary. The instance admin
switches it on the portal's Instance page (the Dynamic Review card, `src/admin/`), which uses that
setter; there is no CLI. See `contracts/README.md` for the
upgrade/rollback order.

The kind widens what the queue treats as "the same job": the automatic per-head uniqueness, the
comment/manual duplicate check and supersession all include it, so a Diff job and a Dynamic job of one
pull request are two jobs. Per-PR serialization (one running job per pull request) is **not** split by
kind: two waiting kinds of one pull request still run one after the other.

A runner only ever claims a kind one of its engines can run (`runner-capabilities.ts`,
`runner-queue.ts`): the claim filters on `review_kind` in the atomic statement, so an ineligible job is
never selected — it keeps waiting without an attempt being counted and without credentials being
created. Because every production runner advertises only `pr-agent` until #202, such a job is
**cancelled** after `noCapableRunnerMs` (default 30 minutes, `RUNNER_NO_CAPABLE_TIMEOUT_SECONDS`) with
the stable code `no_capable_runner`. That is the one exception to "waiting forever": it is a bounded
outcome, not a failed review, and no attempt is counted. This initial-claim deadline starts at the
later of creation and `run_after`, so a scheduled delay does not consume the waiting budget. Jobs
already claimed (`attempts > 0` after lease loss/release) follow the existing lease/attempt/backoff
policy instead, independently of which runner polls first.

When the project's review kind changes, #194's `ReviewSettingsHooks.onProjectSettingsChanged` calls
`cancelWaitingForReviewKindChange` in the settings transaction: the project's waiting jobs become
`cancelled` with `review_kind_changed`, a running job finishes, and a rejecting hook rolls the
settings change (and the cancellation) back. The hook is `createJobReviewSettingsHooks`, wired in
`review-settings/shared.ts`.

## Enqueueing

`enqueue` runs in one transaction (the write lock is taken up front), in this order:

1. **Same delivery.** A job with the same `delivery_id` exists: it is returned (`same_delivery`). This
   makes the webhook route's claim and the enqueue safe to repeat.
   **Same comment.** The comment (`commentId`, a `comment` job) is in `job_comments` already: the job
   that answered it is returned (`same_comment`), whatever became of that job. GitHub's delivery id is
   not covered by the signature, so a captured signed comment replayed under a new delivery id would
   otherwise run its command again once the first job has finished. `job_comments` has one row per
   (repository, comment) and names the job that answers it. The row is written for every comment that
   gets an answer: for the job it created, and for the equal job it found already waiting or running
   (`already_active`), so the replay of that second comment is recognised later too.
2. **Automatic jobs** (`trigger_kind = webhook`): one per (repository, pull request, head commit,
   command) while it is waiting, running, succeeded or failed (`same_head`). A superseded or cancelled
   job frees the slot, so a commit that comes back (a force push to an old state) is reviewed again.
3. **Jobs a person started** (`comment`, `manual`): exempt from the head commit rule, but there is never a
   duplicate of a waiting or running job for the same pull request, command and arguments
   (`already_active`): the existing job is returned, and if it is waiting behind a `run_after` in the
   future (a debounced automatic job) it is made due now, because a person does not wait for a
   debounce. Different arguments are different jobs (`/review` takes none; a historical person job
   with arguments is still its own job).
4. **Supersession.** A new automatic job replaces the waiting _automatic_ jobs of the same pull request,
   command and arguments (status `superseded`, `superseded_by` set). Waiting `comment` and `manual`
   jobs are never replaced, and a running job is never touched: the new job waits behind it, because
   only one job per pull request runs at a time.

`run_after` is `now` unless the caller passes a later time (the debounce of `synchronize` is policy and
is decided by the webhook handler's trigger policy, CR-31). A manual job is due at once. The start button
(CR-33, `src/manual-reviews/README.md`) is the producer of `manual` jobs; it passes the head commit and the
pull request address it got from the platform and the login of the signed in person.

Unique indexes enforce the promises even if the code were wrong: one job per delivery id, one answer
per comment of a repository (the primary key of `job_comments`, migration `20261011090000_create_job_comments`),
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
`discardWaitingForPr(repositoryId, prNumber)` (pull request closed; all queued jobs of it, also the ones a person started) and `discardWaitingAutomaticForPr` (turned into a draft; only `webhook` jobs, error code `pull_request_draft`) set waiting jobs to `cancelled`;
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
- **CR-32 (comments).** Done: the trigger carries the comment id, and the queue
  dedupes on it (`same_comment`). The queue's own limit of 10 000 characters stays as a safety net.
  The removed command question truncation went away with the commands (#203).
