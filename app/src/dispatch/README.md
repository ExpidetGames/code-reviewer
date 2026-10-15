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
| `200 ignored`, `not_capable`                                                   | `stopped`               | Never again: the Dispatcher cannot run that review kind. Only a person or a later release revives it                                                                       |
| `429`, `503`                                                                   | `pending`, failures + 1 | The longer of the schedule and `Retry-After` (seconds or HTTP date, at most 1 hour). Only the status and `Retry-After` are read; the body is dropped                       |
| other `5xx`, timeout, no connection                                            | `pending`, failures + 1 | 10 s, 30 s, 2 min, 5 min, then 15 min                                                                                                                                      |
| any other status (`4xx`, a redirect, an unexpected `2xx`, an unreadable `200`) | `pending`, failures + 1 | **30 minutes**, and an error log line `DISPATCH_REJECTED` (a wrong URL or a wrong secret looks like this)                                                                  |

`last_status` and `last_code` (`DISPATCH_RESULT_CODES`) keep the last answer for support. The failures count resets
on any answer that is not a failure.

## The hook for the sweep (#328)

`getDispatchService()?.sendDue(limit)` is what the cron sweep calls (#328): every queued job that is due and
has no row or whose row is due and not stopped is sent (at most `limit`, five at a time). It is safe to call from
several instances or runs at once. The sweep decides the cap, the give-up (`dispatch_unavailable`) and when to call it;
this folder only sends. `job_dispatches` rows of finished jobs are not removed yet (the sweep's cleanup can).

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
