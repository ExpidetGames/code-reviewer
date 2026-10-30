# The Dispatcher and the Worker: vocabulary and interfaces

The words, the interfaces between the parts and the table of which Trigger and Launcher exist. The hosted
deployment (umbrella #316) is described step by step in [`deployment-vercel.md`](deployment-vercel.md); the
Dispatcher's code, configuration and Launchers are in [`dispatcher/README.md`](../dispatcher/README.md).

## Vocabulary

| Term | Meaning |
|---|---|
| **App** | The Next.js app with the database. Receives GitHub webhooks, creates jobs, stores results, serves the UI. It never reviews. |
| **Dispatcher** | The middle layer. Learns that a job exists, claims it with the dispatcher credential (today `RUNNER_TOKEN`), receives the per-job credential from the App and starts a Worker. It never reviews and never sees the git token or the model key. |
| **Trigger** | How the Dispatcher learns about a job: the **Webhook-Trigger** (the App calls it, signed). |
| **Dispatcher core** | Claim, per-job credential handling, concurrency cap, launch error handling. Platform-free. |
| **Launcher** | How a Worker is started: the **Sandbox-Launcher** (a fresh VM from a golden snapshot that hosts Docker; the Worker runs there as our hardened container). |
| **Worker** | The isolated process tree that executes exactly one job: the **Diff-Worker** (PR-Agent) or the **Dynamic-Worker** (OpenCode engine). It knows only the App URL, the job id and the per-job credential. |
| **Worker contract** | What the Worker may do with the per-job credential and nothing more: fetch job details, heartbeat, deliver the result. Identical whoever started the Worker. |
| **Hardened container spec** | One definition of the container flags: user, capabilities, `no-new-privileges`, read-only root, tmpfs, memory and pids limits, no volumes, devices or host namespaces (`contracts/worker-container.v1.json`). |
| **Golden snapshot** | A snapshot of a VM with Docker installed and the Worker image pre-pulled. Every job gets a fresh clone; a snapshot never contains job data ([`golden-snapshot.md`](golden-snapshot.md)). |

**More than one App (#730).** One Dispatcher can serve several Apps. The key that signs a call names the app (a key belongs to
exactly one app), the core claims, heartbeats, releases and reports at that app only, each app may submit only the job kinds
the registry lists for it, and every job VM is tagged with its app (`tenant`), so one app can never claim, stop or read
another's jobs or VMs, and the Dispatcher counts each app's live VMs against its cap itself, so one app cannot take the Sandbox concurrency of another. The legacy variables define the app `reviewer`; `DISPATCHER_APPS` adds the others
([`dispatcher/README.md`](../dispatcher/README.md), "More than one App"; variables in
[`deployment-vercel.md`](deployment-vercel.md), 3.2).

**The kind `implementer` (#759).** The Implementer's job kind (engine `implementer`, contract `runner-api.v1.json`) is served
for an app of `DISPATCHER_APPS` that names it in `kinds`, and for no other: the app `reviewer` (the legacy variables,
code-review.com) never has it, whatever `DISPATCHER_ENGINES` says (`REVIEWER_KINDS` in `dispatcher/src/core/types.ts`), so
code-review.com cannot start an agent job even if its app is misconfigured. The same three checks as for the other kinds
apply: a wake-up call for the kind from another app is `200 ignored` with `not_capable` and no claim, the claim asks for the
`implementer` engine only for an app whose kinds name it, and a claimed job of the kind for another app is released
unlaunched (`kind_not_allowed`). A job of the kind lives 3600 s by default (`DISPATCHER_WORKER_CONFIG.implementer.timeoutSeconds`,
60 to 21600) where Diff and Dynamic keep `DISPATCHER_JOB_TIMEOUT_SECONDS`. The Sandbox launcher does not advertise the engine
yet: it needs the container profile of the Implementer (#760), until then a dispatch for the kind is `not_capable`.

"Runner" is retired as a concept: the former runner process conflated the Dispatcher
(claim, cap) and the Worker host (heartbeat, supervise, deliver). Its identifiers (`RUNNER_*` variables, image and
service names, `/api/runners/v1`) stay until a dedicated rename.

## Interfaces

| Between | Interface | Defined in |
|---|---|---|
| GitHub and the App | Signed webhook `POST /api/webhooks/github-app` | [`github-app.md`](github-app.md) |
| App to Dispatcher (Webhook-Trigger) | `POST /dispatch`: a closed JSON body (`job.ready`, job id, review kind, attempt) signed with HMAC and a key id, at most 1 KiB. Answers `202`, `200 ignored`, `401`, `400`, `413`, `429`, `503` | `contracts/dispatch-webhook.v1.json`, `contracts/dispatch-signing-vectors.json`, `app/src/dispatch/README.md` |
| App to Dispatcher (stop) | `POST /stop`: a closed JSON body (`job.stop`, job id, stop id) signed like `/dispatch`; the Dispatcher stops the VMs tagged with that job. Answers `202`, `200 ignored` (`no_vm`, `replayed`), `401`, `400`, `413`, `503`; a Dispatcher of the previous release answers `404` | `contracts/dispatch-webhook.v1.json`, `dispatcher/README.md`, "The stop call" |
| Dispatcher to App (Dispatcher API) | `GET /api/runners/v1/version`, `POST /api/runners/v1/claim` (by job id, with the pool cap), `POST /api/runners/v1/jobs/{id}/heartbeat`, `POST /api/runners/v1/jobs/{id}/release`, with the dispatcher credential or the per-job credential | `contracts/runner-api.v1.json` |
| Dispatcher to Launcher | `capabilities(signal)`, `launch(spec, signal)`, optional `probe(signal)`; a `LaunchSpec` is `{appId, appUrl, jobId, credential, kind, timeoutSeconds, config}` | `dispatcher/src/core/types.ts`, `dispatcher/README.md` |
| Launcher to Worker | The start document `{appUrl, jobId, credential}` on **stdin only**, never an argument, environment variable or file; the container's entry mode `worker-once` (or `probe`) | `runner/README.md`, "Entry modes of the image" |
| Worker to App (Worker contract) | `GET /api/workers/v1/jobs/{id}` (job details, where the git token and the model key are revealed), `POST .../heartbeat`, `POST .../result`, with the per-job credential | `contracts/worker-api.v1.json` |
| Dispatcher to App (reaper) | `GET /api/runners/v1/jobs/{id}`: the state of a job, so that the reaper stops the VM of a job that is not `running` | `contracts/runner-api.v1.json` |
| Platform cron to Dispatcher | `GET /api/cron/reap-sandboxes` with `Authorization: Bearer <CRON_SECRET>` every 5 minutes | `dispatcher/README.md`, "The reaper" |
| Dispatcher to operator | `GET /health`; `POST /probe` (the canary probe of the deploy canary, with the operator credential `DISPATCHER_OPERATOR_TOKEN`, required with several Apps, else the `reviewer` token while `reviewer` is the only App and the token is unset; dispatch never runs it); `POST /apps/check` (per app: reachable, credential, features; operator credential only) | `dispatcher/README.md`, "The canary probe" and "More than one App", `contracts/dispatcher-ops.v1.json` |
| Operator to App | `/api/operator/v1`: workspaces, entitlements, limits, usage; only with `OPERATOR_API_TOKEN` | `contracts/operator-api.v1.json`, `app/src/operator-api/README.md` |

Nothing here is shared as source: the three projects (`app/`, `dispatcher/`, `runner/`) exchange only the contracts
in `contracts/` and the generated types in `src/contracts/`; a test fails on any import across projects.

## What exists

The Dispatcher has one Trigger, the Webhook-Trigger, and one Launcher, the Sandbox-Launcher: the hosted deployment
(`deployment-vercel.md`).

| Part | Entry | Status |
|---|---|---|
| Dispatcher core, Webhook-Trigger, `GET /health` | `dispatcher/src/index.ts` (Vercel) | exists |
| Sandbox-Launcher, canary probe, `POST /probe` | Vercel entry, with `SANDBOX_SNAPSHOT_ID` set | exists |
| Golden snapshot pipeline | `pnpm --dir dispatcher snapshot:build`, workflow `golden-snapshot.yml` | exists |
| Deploy canary | `pnpm --dir dispatcher probe:canary`, workflow `dispatcher-canary.yml` | exists |
| Reaper for VMs that outlived a job | a Dispatcher cron, `/api/cron/reap-sandboxes` | exists (#364) |
