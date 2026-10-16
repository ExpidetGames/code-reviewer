# The Dispatcher and the Worker: vocabulary and interfaces

The words, the interfaces between the parts and the table of which Trigger and Launcher exist. The hosted
deployment (umbrella #316) is described step by step in [`deployment-vercel.md`](deployment-vercel.md); the
Dispatcher's code, configuration and Launchers are in [`dispatcher/README.md`](../dispatcher/README.md).

## Vocabulary

| Term | Meaning |
|---|---|
| **App** | The Next.js app with the database. Receives GitHub webhooks, creates jobs, stores results, serves the UI. It never reviews. |
| **Dispatcher** | The middle layer. Learns that a job exists, claims it with the dispatcher credential (today `RUNNER_TOKEN`), receives the per-job credential from the App and starts a Worker. It never reviews and never sees the git token or the model key. |
| **Trigger** | How the Dispatcher learns about a job: the **Poll-Trigger** (it asks the App) or the **Webhook-Trigger** (the App calls it). |
| **Dispatcher core** | Claim, per-job credential handling, concurrency cap, launch error handling. Platform-free. |
| **Launcher** | How a Worker is started: the **Docker-Launcher** (self-hosted: the Worker runs as its own process and user inside the already hardened container, no docker socket) or the **Sandbox-Launcher** (a fresh VM from a golden snapshot that hosts Docker; the Worker runs there as our hardened container). |
| **Worker** | The isolated process tree that executes exactly one job: the **Diff-Worker** (PR-Agent) or the **Dynamic-Worker** (OpenCode engine). It knows only the App URL, the job id and the per-job credential. |
| **Worker contract** | What the Worker may do with the per-job credential and nothing more: fetch job details, heartbeat, deliver the result. Identical whoever started the Worker. |
| **Hardened container spec** | One definition of the container flags: user, capabilities, `no-new-privileges`, read-only root, tmpfs, memory and pids limits, no volumes, devices or host namespaces (`contracts/worker-container.v1.json`). |
| **Golden snapshot** | A snapshot of a VM with Docker installed and the Worker image pre-pulled. Every job gets a fresh clone; a snapshot never contains job data ([`golden-snapshot.md`](golden-snapshot.md)). |

"Runner" is retired as a concept: the Python runner process of a self-hosted installation conflates the Dispatcher
(claim, cap) and the Worker host (heartbeat, supervise, deliver). Its identifiers (`RUNNER_*` variables, image and
service names, `/api/runners/v1`) stay until a dedicated rename.

## Interfaces

| Between | Interface | Defined in |
|---|---|---|
| GitHub and the App | Signed webhook `POST /api/webhooks/github-app` | [`github-app.md`](github-app.md) |
| App to Dispatcher (Webhook-Trigger) | `POST /dispatch`: a closed JSON body (`job.ready`, job id, review kind, attempt) signed with HMAC and a key id, at most 1 KiB. Answers `202`, `200 ignored`, `401`, `400`, `413`, `429`, `503` | `contracts/dispatch-webhook.v1.json`, `contracts/dispatch-signing-vectors.json`, `app/src/dispatch/README.md` |
| Dispatcher to App (Dispatcher API) | `GET /api/runners/v1/version`, `POST /api/runners/v1/claim` (by job id, with the pool cap), `POST /api/runners/v1/jobs/{id}/heartbeat`, `POST /api/runners/v1/jobs/{id}/release`, with the dispatcher credential or the per-job credential | `contracts/runner-api.v1.json` |
| Dispatcher to Launcher | `capabilities(signal, want)`, `launch(spec, signal)`, optional `probe(signal)`; a `LaunchSpec` is `{appUrl, jobId, credential, kind, timeoutSeconds, config}` | `dispatcher/src/core/types.ts`, `dispatcher/README.md` |
| Launcher to Worker | The start document `{appUrl, jobId, credential}` on **stdin only**, never an argument, environment variable or file; the container's entry mode `worker-once` (or `probe`) | `runner/README.md`, "Entry modes of the image" |
| Worker to App (Worker contract) | `GET /api/workers/v1/jobs/{id}` (job details, where the git token and the model key are revealed), `POST .../heartbeat`, `POST .../result`, with the per-job credential | `contracts/worker-api.v1.json` |
| Dispatcher to App (reaper) | `GET /api/runners/v1/jobs/{id}`: the state of a job, so that the reaper stops the VM of a job that is not `running` | `contracts/runner-api.v1.json` |
| Platform cron to Dispatcher | `GET /api/cron/reap-sandboxes` with `Authorization: Bearer <CRON_SECRET>` every 5 minutes | `dispatcher/README.md`, "The reaper" |
| Dispatcher to operator | `GET /health`; `POST /probe` (the capability probe, with the dispatcher credential) | `dispatcher/README.md`, "The capability probe" |
| Operator to App | `/api/operator/v1`: workspaces, entitlements, limits, usage; only with `OPERATOR_API_TOKEN` | `contracts/operator-api.v1.json`, `app/src/operator-api/README.md` |

Nothing here is shared as source: the three projects (`app/`, `dispatcher/`, `runner/`) exchange only the contracts
in `contracts/` and the generated types in `src/contracts/`; a test fails on any import across projects.

## Which Trigger and which Launcher exist

| | Docker-Launcher | Sandbox-Launcher |
|---|---|---|
| **Webhook-Trigger** | not built, configuration only, later | **exists: the hosted deployment** (`deployment-vercel.md`) |
| **Poll-Trigger** | the self-hosted split, **#334 (not merged)** | not built, configuration only, later |

What runs self-hosted **today** is neither: it is the runner's own job loop (`RUNNER_MODE=legacy`, the default),
which claims with `RUNNER_TOKEN` and reviews inside the runner container. It is unchanged and stays the default until
the split of #334 has soaked (#335). Only the two cells marked above are built and tested; the other combinations are
configuration of the same parts and are not promised.

| Part | Entry | Status |
|---|---|---|
| Dispatcher core, Webhook-Trigger, `GET /health` | `dispatcher/src/index.ts` (Vercel), `src/node.ts` (Node) | exists |
| Sandbox-Launcher, capability probe, `POST /probe` | Vercel entry, with `SANDBOX_SNAPSHOT_ID` set | exists |
| Golden snapshot pipeline | `pnpm --dir dispatcher snapshot:build`, workflow `golden-snapshot.yml` | exists |
| Deploy canary | `pnpm --dir dispatcher probe:canary`, workflow `dispatcher-canary.yml` | exists |
| Poll-Trigger, Docker-Launcher, the Dispatcher bundle in the runner image (`RUNNER_MODE=dispatch`) | | #334, later |
| Reaper for VMs that outlived a job | a Dispatcher cron, `/api/cron/reap-sandboxes` | exists (#364) |
