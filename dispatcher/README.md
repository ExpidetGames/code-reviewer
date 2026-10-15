# Dispatcher

The middle layer of the hosted deployment (#316). It learns that a review job exists, claims exactly that job
from the App with the dispatcher credential, receives the per-job credential, starts a Worker through a
Launcher and hands the job over. It never reviews, and it never sees the git token or the model key: the App
reveals those to the Worker when the Worker fetches its job.

```
App ──signed POST /dispatch──▶ Trigger ──▶ core ──claim──▶ App
                                            │  ◀── per-job credential
                                            └──▶ Launcher.launch(...)   (heartbeats with the credential meanwhile)
```

| Part                                                                              | Where                                    | Status                                                                         |
| --------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| Dispatcher core: claim, capacity, heartbeat during the launch, release on failure | `src/core/`                              | here; platform-free (no `node:*`, no platform SDK: ESLint and a test check it) |
| Webhook-Trigger: `POST /dispatch`, `GET /health`                                  | `src/triggers/webhook.ts`, `src/app.ts`  | here                                                                           |
| Fake Launcher (tests)                                                             | `src/launchers/fake.ts`                  | here                                                                           |
| Vercel entry, a default export                                                    | `src/index.ts`                           | here, with no engine until the Sandbox-Launcher (#329) is wired in             |
| Node entry, `@hono/node-server` and a graceful shutdown                           | `src/node.ts` (`pnpm start`)             | here, with no engine until the Docker-Launcher (#334) is wired in              |
| Poll-Trigger, Docker-Launcher, Sandbox-Launcher                                   | `src/triggers/poll.ts`, `src/launchers/` | #334, #329                                                                     |

Two entry files keep `node:child_process` (the Docker-Launcher's way of starting a process) out of the serverless
bundle; `src/bundle/serverless-bundle.test.ts` follows the import graph of `src/index.ts` to prove it. Until a real
Launcher is wired in, both entries use `noLauncher`: it advertises no engine, so every wake-up call is answered
`200 ignored` with the reason `not_capable` and nothing is claimed.

## The wake-up call

`POST /dispatch` follows `contracts/dispatch-webhook.v1.json`. In this order: content type (`application/json`) and
size (1 KiB at most), the form of the headers, the timestamp (300 seconds either way), the key id (the current and
the previous key), the signature (constant time), the closed body, and that its `dispatchId` equals the header. A
refusal never says which check failed: `401` for the clock, the key or the signature, `400` for a malformed or
invalid call, `413` for an oversize body, with the same body every time. Nothing is claimed for a refused call.

A verified call gets its answer at once: `202 accepted` (the Worker is being started in the background: `waitUntil` on
the platform, a tracked promise in the Node process), `200 ignored` with `not_claimable` (the claim answered `204`: a
replay, a job that is running or finished, or the pool cap) or `not_capable` (no configured engine of the Launcher
runs that kind; nothing is claimed), `429` or `503` with `Retry-After`.

## What the core does

1. Engines are the configured ones that the Launcher advertises now (`capabilities`, fail closed). The job's kind
   must be among them, else `not_capable`.
2. Capacity: no more launches in progress than `DISPATCHER_MAX_RUNNING`, else `429`; the same number is sent as
   `maxRunning` so the App enforces the cap atomically.
3. The App must offer the features of the split (`GET /api/runners/v1/version`: `worker_api`, `claim_by_job_id`,
   `pool_cap`, `release`), remembered for ten minutes. A previous release has no such route or lacks a feature:
   `503`, nothing claimed. An answer to the claim that is not the split one (a previous release sends the job input
   and a git token) is refused unread.
4. `POST /api/runners/v1/claim` with `{engines, features: ["worker_credential"], jobId, maxRunning}` and `X-Runner-Id`.
   `204` means ignored.
5. `launcher.launch({appUrl, jobId, credential, kind, timeoutSeconds, config}, signal)`, while heartbeating with the
   job credential every `heartbeatIntervalSeconds` so the two minute lease does not lapse. The launch has five
   minutes. At the deadline, or on a shutdown, the signal aborts and the job is released with `launch_failed` (the
   App counts it as a failed attempt). When a heartbeat shows the lease is lost the launch is stopped and nothing is
   released. The credential is held in memory only, in the scope of that one launch, and is dropped after the hand-over.
6. Logs go through a masker: the dispatcher token, the signing secrets and anything shaped like a job credential or an
   `Authorization` value are replaced. Only stable codes are logged for an error, never its text.

## The sender

The App sends the call (`app/src/dispatch/README.md`, #326) when it runs with `RUNNER_DISPATCH=webhook`: `RUNNER_WEBHOOK_URL`
is this project's `/dispatch`, and `RUNNER_WEBHOOK_SECRET` / `RUNNER_WEBHOOK_KEY_ID` are `DISPATCHER_SIGNING_SECRET` /
`DISPATCHER_SIGNING_KEY_ID`. It reads only the status (and `Retry-After` of `429`/`503`) of the answer: `202` is
acknowledged, `200 ignored` with `not_claimable` is sent again after two minutes, with `not_capable` never again; `429`
and `503` are retried after `Retry-After` or the back-off, whichever is longer; any other status waits half an hour and
raises an alert in the App's log.

## The Launcher

```ts
interface Launcher {
  capabilities(signal): Promise<readonly Engine[]>; // what it can run right now; fail closed
  launch(spec: LaunchSpec, signal): Promise<void>; // resolves when the Worker has taken over; throws LaunchError
}
```

`LaunchSpec.config` is the per-kind part of `DISPATCHER_WORKER_CONFIG`: `container` (what the container spec lets a
Launcher change, the memory limit) and `launcher` (the Launcher's own options, which the core does not read).

## Configuration

Names only: a refusal names the variable, never the value.

| Variable                                                                   | Meaning                                                                                                                | Default      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| `RUNNER_API_URL`                                                           | Base URL of the App                                                                                                    | required     |
| `RUNNER_TOKEN`                                                             | The dispatcher credential (the runner API token)                                                                       | required     |
| `DISPATCHER_MAX_RUNNING`                                                   | The pool cap, 1 to 1000                                                                                                | required     |
| `DISPATCHER_SIGNING_KEY_ID`, `DISPATCHER_SIGNING_SECRET`                   | The key the App signs the wake-up call with; the secret has at least 32 characters and differs from every other secret | required     |
| `DISPATCHER_SIGNING_KEY_ID_PREVIOUS`, `DISPATCHER_SIGNING_SECRET_PREVIOUS` | The previous key, accepted while the keys rotate                                                                       | none         |
| `DISPATCHER_POOL_ID`                                                       | Sent as `X-Runner-Id`; the App counts the running jobs of the pool by it                                               | `dispatcher` |
| `DISPATCHER_ENGINES`                                                       | `pr-agent`, `opencode` or both                                                                                         | both         |
| `DISPATCHER_JOB_TIMEOUT_SECONDS`                                           | How long a Worker may live, 60 to 21600                                                                                | `1200`       |
| `DISPATCHER_WORKER_CONFIG`                                                 | JSON `{"diff": {...}, "dynamic": {...}}` with `container.memory` and `launcher`                                        | none         |
| `DISPATCHER_SHUTDOWN_GRACE_SECONDS`                                        | Node entry: how long launches may finish after SIGTERM, 0 to 600                                                       | `60`         |
| `PORT`                                                                     | Node entry                                                                                                             | `8080`       |

## Working here

From the repository root: `make lint`, `make typecheck`, `make test-unit`, `make test-integration`, `make verify`.
Inside `dispatcher/`: `pnpm test`, `pnpm test:int`, `pnpm exec vitest run <path>`, `pnpm start` (the Node entry).
`src/contracts/` is generated from `contracts/` (`make generate-contracts`) and never edited by hand. The project
imports nothing from `app/` or `runner/`; what is shared is the contracts and `fakes/` (`fakes/dispatcher-app` is the
fake App every test here runs against). See `TESTING.md` for the test rules.
