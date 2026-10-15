# Dispatch webhook (the Webhook-Trigger, sending side)

In a serverless deployment no process polls the app for jobs. When a job is queued, the app wakes the
Dispatcher (#316) with one signed `POST`; the Dispatcher claims exactly that job (`jobId` in the claim, #322) and
starts a Worker. This folder is the sending side (#326). The receiving side is the Dispatcher project
(`dispatcher/`, #327); the wire format is `contracts/dispatch-webhook.v1.json` and
`contracts/dispatch-signing-vectors.json`, which both ends are tested against.

**Off by default.** `RUNNER_DISPATCH` is `poll` unless set to `webhook`. In poll mode there is no hook, no row
in `job_dispatches` and no HTTP: the app behaves as it did before this folder existed (runners poll).

## Settings

`config.ts` is the one place that knows the names. A refusal names the variable, never the value.

| Variable                                                           | Meaning                                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_DISPATCH`                                                  | `poll` (default) or `webhook`                                                                                                    |
| `RUNNER_WEBHOOK_URL`                                               | The Dispatcher's `POST /dispatch`. https, no credentials in it (plain http only for `localhost`, `127.0.0.1`, `[::1]`)           |
| `RUNNER_WEBHOOK_SECRET`, `RUNNER_WEBHOOK_KEY_ID`                   | The signing key: at least 32 characters, no white space; the id (`a-z0-9_-`, at most 32, default `k1`) names it for the receiver |
| `RUNNER_WEBHOOK_SECRET_PREVIOUS`, `RUNNER_WEBHOOK_KEY_ID_PREVIOUS` | The key being replaced, both or neither. The app signs with the current key only; see "Rotating the key"                         |
| `RUNNER_WEBHOOK_BYPASS_TOKEN`                                      | Optional. Sent as `x-vercel-protection-bypass` when the Dispatcher project sits behind the platform's deployment protection      |
| `RUNNER_DISPATCH_GIVE_UP_SECONDS`                                  | The sweep's give-up (#328, "The cron sweep"): default 3600 in webhook mode, off in poll mode; `0` is off                         |
| `RUNNER_DISPATCH_MAX_RUNNING`                                      | Optional. The pool cap the sweep keeps to when it sends (#328), 1 to 1000                                                        |

The signing secret is a credential of its own and must differ from `RUNNER_TOKEN`, `APP_SECRET`,
`BETTER_AUTH_SECRET`, `OPERATOR_API_TOKEN`, `CRON_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`,
`GITHUB_OAUTH_CLIENT_SECRET` and `LLM_API_KEY` (`OTHER_CREDENTIAL_VARIABLES`), and its previous value and the bypass
token must differ from it. A production start with `RUNNER_DISPATCH=webhook` and a missing URL, a short or reused
secret ends with `DEPLOY_CONFIG_INVALID` (`src/deploy/startup.ts`, serverless start included). At run time a bad
setting turns the dispatch off for that call and logs `DISPATCH_CONFIG_INVALID` once; it never fails a queue call.

The Dispatcher's own names for the same key are `DISPATCHER_SIGNING_KEY_ID` and `DISPATCHER_SIGNING_SECRET`
(`dispatcher/README.md`).

## How a job is announced

| File                                           | Role                                                                                                                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                                    | `loadDispatchConfig`, `dispatchConfigProblems`                                                                                                                                                                                          |
| `request.ts`                                   | `buildDispatchRequest`: the closed body (`{version, type:"job.ready", jobId, reviewKind, attempt, dispatchId, sentAt}`, no secret, no repository data) and the headers; `signDispatch`                                                  |
| `send.ts`                                      | `sendDispatch`: one `POST`, 8 seconds for everything, no redirect followed; the answer becomes a `SendResult`                                                                                                                           |
| `outcome.ts`                                   | `decideOutcome`: what an answer means (state, next time, alert); the back-off schedule                                                                                                                                                  |
| `service.ts`                                   | `createDispatchService`: `onEnqueued` (the queue hook) and `sendDue` (the hook for the sweep) and `sendJob` (one job of its listing; it sends only a row that is due now, so a listing older than another sender's claim sends nothing) |
| `hook.ts`, `shared.ts`                         | The hook for `createJobQueue` (none in poll mode), run through Next's `after()`; `getDispatchService()` for the sweep                                                                                                                   |
| `db/repositories/job-dispatches-repository.ts` | The rows of `job_dispatches`                                                                                                                                                                                                            |

1. A producer (the GitHub webhook, a comment, the start button) enqueues through `jobQueueFor`
   (`src/jobs/shared.ts`), which passes `onEnqueued` to `createJobQueue`. The queue calls it **after the enqueue
   transaction committed**, with the result; a hook that throws is ignored. `producers.test.ts` fails if a producer
   builds a queue some other way.
2. The hook hands the work to `after()` (Next keeps a serverless function alive for it, `waitUntil` on the
   platform). The GitHub response, the comment handling and the start button never wait for it and never fail
   because of it. There is no timer and no loop in the app for this.
3. `onEnqueued` acts for a **new** job and for an `already_active` one (a person's click that pulled a job waiting
   behind the debounce forward); a job returned as `same_delivery`, `same_comment` or `same_head` gets nothing, and
   neither does a job that was created already failed (Dynamic Review off). It makes the `job_dispatches` row and,
   if the job is due, sends. A job that is not due yet (the 90 second debounce of an automatic review) only gets
   its row with `next_dispatch_at = run_after`; the sweep sends it when it is due.
4. The send is **claimed in the row first** (`claimSend`: a compare and set on `next_dispatch_at`, which also counts
   the attempt), so the request that queued the job, the sweep and another instance never send one call twice. If
   the sender dies, the claim runs out after 30 seconds and the job is due again.

The job is durable before any of this: nothing here can lose it or undo the enqueue. If even the row cannot be
written, the job is still queued, and `sendDue` finds queued, due jobs **without** a row as well.

## What an answer means (`outcome.ts`)

| Answer                                                                         | Stored                  | Next                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `202`                                                                          | `acked`, `acked_at`     | Looked at again after the **acknowledgement timeout** (2 minutes); sent again only if the job is still queued then (the claim failed, or the Worker launch was given back) |
| `200 ignored`, `not_claimable` (or any other reason of the right form)         | `pending`               | Again after the acknowledgement timeout (not due, running, pool cap reached, ...)                                                                                          |
| `200 ignored`, `not_capable`                                                   | `stopped`               | Not by the send itself: the Dispatcher cannot run that review kind. The sweep asks again after 10 minutes ("The cron sweep", step 3)                                       |
| `429`, `503`                                                                   | `pending`, failures + 1 | The longer of the schedule and `Retry-After` (seconds or HTTP date, at most 1 hour). Only the status and `Retry-After` are read; the body is dropped                       |
| other `5xx`, timeout, no connection                                            | `pending`, failures + 1 | 10 s, 30 s, 2 min, 5 min, then 15 min                                                                                                                                      |
| any other status (`4xx`, a redirect, an unexpected `2xx`, an unreadable `200`) | `pending`, failures + 1 | **30 minutes**, and an error log line `DISPATCH_REJECTED` (a wrong URL or a wrong secret looks like this)                                                                  |

`last_status` and `last_code` (`DISPATCH_RESULT_CODES`) keep the last answer for support. The failures count resets
on any answer that is not a failure.

## The cron sweep (#328)

A serverless deployment has no process that polls and none that lives long enough to hold a timer, so **the clock
is the platform's cron**: `GET /api/internal/dispatch-sweep`, once a minute (`app/vercel.json`), with
`Authorization: Bearer <CRON_SECRET>` like the daily repository sync. The route exists only in serverless mode
(`APP_RUNTIME=serverless`, a `404` anywhere else, so a Coolify installation is untouched), a missing or wrong
secret is `401` with no side effect, and nothing below `/api/internal` is open except the two exact paths of the
two crons (`src/auth/access.ts`).

| File                             | Role                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/src/cron/dispatch-sweep.ts` | The route's handler: the secret, the try-lock, the answer (counts only)                                                                                            |
| `app/src/db/try-lock.ts`         | `tryWithLock`: a Postgres transaction advisory try-lock (`pg_try_advisory_xact_lock(328, 1)`) on a dedicated connection, not the pool; an in-process set on SQLite |
| `sweep.ts`                       | `createDispatchSweep(...).run()`: the steps of one run                                                                                                             |
| `sweep-settings.ts`              | The two settings below                                                                                                                                             |
| `sweep-shared.ts`                | The wiring of the running server                                                                                                                                   |

**Overlapping runs.** A run that starts while another one is still working (the platform retries, or a run
outlasts its minute) does not queue behind it: it answers `{"status":"skipped","reason":"already_running"}` and
does nothing. The lock lives and dies with one transaction on a connection of its own (not the pool, whose connections the steps
need: a pool of one still works), so a crashed instance can never leave it locked. Every step is also safe on its own, so a second instance that got in anyway (for example the job
creation hook running at the same moment) only ever sees compare-and-set statements.

**One run, in order.** A step that fails is logged by its name (`[sweep] SWEEP_STEP_FAILED step=<name>`, never the
cause) and does not stop the others; the answer is then `500` with `failedSteps`, and the next run tries again.

1. **`expire`** (`expireStaleJobs()`, which claims did and now nobody does): a running job whose lease lapsed is
   queued again with the attempt counted (on the last allowed attempt it fails with `lease_expired`), a job that runs
   longer than 25 minutes fails with `timeout` whatever its heartbeats say, and a Dynamic job nobody can run is
   cancelled (`no_capable_runner`). Its row in `job_dispatches` is due by then (the acknowledgement timeout is as long
   as the lease), so step 4 sends it again.
2. **`give_up`**: a job that has been **queued for the give-up time without a claim** fails with the stable code
   `dispatch_unavailable` (copy on the Runs pages, `runs/error-copy.ts`) and no attempt is counted, so the pull
   request is free for the next push or review request. "Queued" is counted from the later of the time the job
   became due (`run_after`, so a debounce does not eat the budget) and the time it was last queued (a job given back
   after a lost lease waits again from then, never from its first due time). A job whose dispatch a Dispatcher
   **acknowledged** (`202`) within the last acknowledgement timeout is spared: that Dispatcher is working on it.
   A job that is running is never touched by this step. The time is `RUNNER_DISPATCH_GIVE_UP_SECONDS`: **3600 (60
   minutes) when `RUNNER_DISPATCH=webhook`**, **off in poll mode** unless the operator sets it, `0` turns it off, a
   value outside 60 to 604800 or one that is not a whole number keeps the default of the mode. It is also the longest a
   job may wait when the pool is full, so set it above the longest queue you accept.
3. **`revive`** (webhook mode): a dispatch **stopped** with `not_capable` (the Dispatcher cannot run that review
   kind) is made pending again `STOPPED_REVIVE_MS` (10 minutes) after it stopped, if its job is still queued, so a
   Dispatcher that was updated or got its engine back is asked again, at a slow pace and never in a hot loop. A
   Dynamic job that nobody can ever run still ends as `no_capable_runner` after 30 minutes (step 1).
4. **`send`** (webhook mode, `getDispatchService()?.sendDue(limit)`): every queued job that is due and has no row, or
   whose row is due and not stopped, is sent: jobs queued by an instance that had no hook, a row that could not be
   written, a debounced job that became due, a call that was never acknowledged, an acknowledged job that is still
   queued after the acknowledgement timeout (the claim failed, or the Worker launch was given back). **The pool cap:**
   with `RUNNER_DISPATCH_MAX_RUNNING` (1 to 1000, normally the Dispatcher's `DISPATCHER_MAX_RUNNING`) the run sends
   at most as many calls as there are free slots (the cap minus the jobs running now, never more than 20 a run), and
   none at the cap, so a long queue does not wake the Dispatcher for nothing every two minutes; the job is sent in the
   first run after a slot frees. Unset, the sweep does not limit itself and the Dispatcher's own cap (enforced by the
   app at the claim, `maxRunning`) is the only limit. The first call right after a job is queued (the hook of
   `jobQueueFor`) is not held back by the cap: the claim is.
5. **`cleanup`**: the cleanup a server runs on a timer (`maintenance/cleanup.ts`: old rate limit counters,
   unverified accounts, verification and reset links, signed states, remembered job keys, **and the `job_dispatches`
   rows of jobs that finished a week ago**) runs **once when the hour has changed**. The hour of the last
   successful run is kept in `app_meta` (`maintenance.sweep_cleanup_hour`), so every instance sees the same one; a run
   that failed is tried again by the next minute's run. On a server (Docker, Coolify) the timer stays as it was.

The answer is `{"status":"ok","expired":{...},"givenUp":n,"revived":n,"sent":n,"cleanedUp":bool}`; a line
`[sweep] requeued=.. lease_expired=.. timed_out=.. given_up=.. revived=.. sent=..` is logged for a run that did
something. Nothing a database or a Dispatcher said reaches a log or an answer.

## Rotating the key

The receiver accepts a current and a previous key. Order: (1) give the Dispatcher the new key as current and the old
one as previous; (2) switch the app to the new key (`RUNNER_WEBHOOK_SECRET`, `RUNNER_WEBHOOK_KEY_ID`); (3) remove the
previous key from the Dispatcher when no call signed with it can still be in flight (the receiver's tolerance is
5 minutes). The app's `..._PREVIOUS` pair is only checked and carried (it must be a strong, distinct secret); the app
never signs with it.

## Logs

A failed send logs `[dispatch] DISPATCH_SEND_FAILED job=<id> code=<name> status=<n|none> failures=<n> retry_at=<time>`;
an answer an operator has to look at logs `DISPATCH_REJECTED`; a failure inside the dispatch logs `DISPATCH_FAILED`
with the database error code. Never the URL, the key, the key id, a signature, a header or the text of an error.

## Mixed versions

The table is new and nothing reads it but this code, so an app of the previous release on the same database is
unaffected; the jobs it queues have no row and are found by `sendDue`. The default is poll mode, which changes
nothing. A Dispatcher of the previous release has no `/dispatch`; the app then gets `404`, which is the "any other
status" case above (30 minute wait and an alert), never a lost job.

The sweep (#328) adds no table and no column. `dispatch_unavailable` is a new value in the free-text `jobs.error_code`;
a previous release shows a failed job with a code it does not know under its general sentence and the code, never as
an error. A previous release has no `/api/internal/dispatch-sweep`: a cron entry that reaches it gets `404`, which
changes nothing. While old and new instances share a database, the new sweep only does what the old claim path
already did (`expireStaleJobs`), plus the compare-and-set statements of this folder; a lease lapsed by the new sweep
is the same lease an old instance's claim would have expired.
