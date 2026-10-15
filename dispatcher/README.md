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

| Part                                                                              | Where                                            | Status                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Dispatcher core: claim, capacity, heartbeat during the launch, release on failure | `src/core/`                                      | here; platform-free (no `node:*`, no platform SDK: ESLint and a test check it)     |
| Webhook-Trigger: `POST /dispatch`, `GET /health`                                  | `src/triggers/webhook.ts`, `src/app.ts`          | here                                                                               |
| Fake Launcher (tests)                                                             | `src/launchers/fake.ts`                          | here                                                                               |
| Hardened container spec renderer and `ContainerLauncher` (#325)                   | `src/launchers/container*.ts`                    | here, used by the Sandbox-Launcher (#329) and the Docker-Launcher (#334)           |
| Sandbox-Launcher over the Vercel Sandbox SDK (#329)                               | `src/launchers/sandbox*.ts`, `vercel-sandbox.ts` | here, wired into the Vercel entry when `SANDBOX_SNAPSHOT_ID` is set                |
| Vercel entry, a default export                                                    | `src/index.ts`                                   | here: the Sandbox-Launcher when a golden snapshot is configured, else `noLauncher` |
| Node entry, `@hono/node-server` and a graceful shutdown                           | `src/node.ts` (`pnpm start`)                     | here, with no engine until the Docker-Launcher (#334) is wired in                  |
| Poll-Trigger, Docker-Launcher                                                     | `src/triggers/poll.ts`, `src/launchers/`         | #334                                                                               |
| Golden snapshot pipeline (a command, not a runtime part)                          | `src/snapshot/`, `pnpm snapshot:build`           | here (#330), `docs/golden-snapshot.md`                                             |

Two entry files keep `node:child_process` (the Docker-Launcher's way of starting a process) out of the serverless
bundle; `src/bundle/serverless-bundle.test.ts` follows the import graph of `src/index.ts` to prove it. Without a real
Launcher an entry uses `noLauncher`: it advertises no engine, so every wake-up call is answered `200 ignored` with the
reason `not_capable` and nothing is claimed. The Node entry keeps it until the Docker-Launcher (#334); the Vercel entry
uses it until `SANDBOX_SNAPSHOT_ID` is set.

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

## The container spec renderer

`src/launchers/container.ts` renders the hardened container spec (`contracts/worker-container.v1.json`, one
definition shared with `compose.dynamic.yml` and the `runner-dynamic` service of `compose.coolify.yml`) to
`docker run` arguments: foreground with stdin attached, `--rm`, the user, `--cap-drop ALL` and the eight
`--cap-add`, `no-new-privileges`, a read-only root, the three tmpfs, memory, reservation, swap, pids, stop timeout
and the default bridge. No `--privileged`, no mount, no device, no host namespace. `renderDockerRunArguments`
refuses a spec that weakens the container (a forbidden key, a weaker value, an unknown key) and an option that
could become a flag, with the stable codes of `CONTAINER_ERROR_CODES`.

- `ContainerLauncher<H extends ContainerHost>` takes a host (where `docker` runs: the Sandbox VM, a local daemon)
  and a `LaunchSpec`. It renders the flags with `spec.config.container` (the memory limit of the job's Worker
  kind: `applyOverrides` changes only the keys the spec lists as overridable and keeps the swap equal to the limit),
  sets `RUNNER_JOB_TIMEOUT_SECONDS`, and hands `{appUrl, jobId, credential}` to the container on **stdin only**. It
  refuses to start if an argument would contain the credential.
- **Per-launcher additions (#345).** `RenderOptions.additions` / `ContainerLauncherConfig.additions` take the
  contract's `WorkerContainerLauncherAdditions`: exactly the two `net.ipv6.conf.{all,default}.disable_ipv6=1`
  switches, rendered as `--sysctl`, nothing else (`additions_not_allowed`). The Sandbox-Launcher passes
  `SANDBOX_LAUNCHER_ADDITIONS` for every Worker kind, because the Sandbox kernel only supports the nft `ip` family
  and the Dynamic-Worker then needs IPv6 off from the container spec. The shared spec and the self-hosted
  compose files do not have them (a full-mode host behaves as before); the default is no additions.
- The entry mode of the image (`worker-once`, `probe`) is a placeholder until the image has its entry modes (#324); the
  names are those #324 proposes, and nothing else changes when it fixes them.
- `seccomp.ts` derives, from Docker's default profile, a profile that denies chosen socket families (AF_VSOCK);
  off unless a profile path is passed as `seccompProfile`. Not required by the spike; not yet run against a daemon.
- A Sandbox VM needs `docker/sandbox/vm-prepare.sh` (the cgroup root fix, then `dockerd`) before the first
  `docker run` with limits; it is the host's job, not part of the flags. The Sandbox-Launcher runs it on every VM start.

## The Sandbox-Launcher

`src/launchers/sandbox.ts` starts the Worker of one job as our hardened container inside a fresh Sandbox VM
(#329). Vercel's firewall is not part of the security boundary: everything security-relevant comes from the container
(`ContainerLauncher`, one spec), run through Docker inside a throw-away VM. All platform-specific code is in
`vercel-sandbox.ts`, behind the small `SandboxService` port of `sandbox-service.ts`; `fakes/sandbox/` holds the doubles.

Per job, after the core has claimed it:

1. `Sandbox.create` from the golden snapshot (#330): `persistent: false` (a persistent sandbox writes a snapshot of the
   job on stop), region `fra1`, no failover region (snapshots are region-bound), a VM size per Worker kind, tags
   `{app, kind, job}`, and a **timeout of the job's plus 120 seconds**, the backstop that ends a VM nobody stops. The name
   is `cr-<kind>-<job id>-<random>`: unique per launch, so a second attempt of a job never meets the first one's VM, and
   it carries the job for lookup. A VM is never reused.
2. `/usr/local/sbin/vm-prepare.sh` as root (the cgroup fix and `dockerd`, spike F1), then `docker image inspect` of the
   image in the VM: its id must equal `SANDBOX_IMAGE_DIGEST`. Otherwise `image_mismatch` and the VM is stopped.
3. `docker run --interactive` with the flags of the container spec (`SANDBOX_LAUNCHER_ADDITIONS` for every kind), by
   image **id** (exactly what was verified, never a pull). The start document `{appUrl, jobId, credential}` is written to
   the process's stdin and the pipe closed. **It is in no argument, no environment variable and no file on the VM**; the
   SDK adapter has no way to set an environment or write a file, and a test searches every request for the credential.
4. The launch resolves when the Worker has taken over: the container is running and has run for `SANDBOX_HANDOVER_SECONDS`
   (20), or ended with 0 sooner. Until then the core heartbeats with the credential so the lease does not lapse. A
   container that ends with an error first is `worker_exited_early`. The time is the stand-in for the Worker's own first
   heartbeat, which the Worker does not announce (follow-up).
5. When the container ends, the VM is stopped by name (`stop()` takes about 2.4 s for an idle VM, 22.6 s with a running
   container, so the container ends first). This supervision is handed to the platform (`waitUntil`); if the function is
   gone before the job is, the VM timeout ends the VM. There is no `poweroff` in the image (spike T13).

Every failure before the hand-over stops the VM by name and ends in a `LaunchError` with a stable code and a `retryable`
flag. The core releases the job with `launch_failed` and the App counts the attempt (three attempts, then `failed`), no
matter whether the flag is set; it is for logs and for the operator.

| Code                                                                      | Retryable | Cause                                                                       |
| ------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| `sandbox_rate_limited`, `sandbox_quota_exceeded`                          | yes       | the platform's limits                                                       |
| `sandbox_network`, `sandbox_unavailable`                                  | yes       | no answer, or a platform error (these also stop by name: the VM may exist)  |
| `image_not_ready`                                                         | yes       | the platform says the snapshot is not ready                                 |
| `docker_not_ready`                                                        | yes       | `vm-prepare.sh` failed (cgroup or `dockerd`)                                |
| `worker_exited_early`, `worker_start_failed`                              | yes       | the container ended with an error first, or could not be started            |
| `sandbox_snapshot_missing`, `sandbox_region_mismatch`, `sandbox_rejected` | no        | the snapshot is gone or in another region; the platform refuses the request |
| `image_missing`, `image_mismatch`                                         | no        | the VM has no such image, or not the configured one                         |
| `sandbox_config_invalid`                                                  | no        | a VM size or memory limit the Launcher cannot run                           |
| `sandbox_create_failed`                                                   | no        | an error it does not recognise                                              |
| `launch_aborted`                                                          | no        | the deadline, a lost lease or a shutdown aborted the launch                 |

The classification of the platform's errors goes by the HTTP status first and by words in the error code second; the
platform does not document its error bodies, so the mapping is **not verified against the live API** (a follow-up of the
first real run). Only the code is logged, never the platform's text.

**Sizes.** The platform's VMs have 1 vCPU or an even number up to 8, and 2 GiB of memory per vCPU. Per Worker kind,
`DISPATCHER_WORKER_CONFIG` sets the VM (`launcher.vcpus`) and the container memory (`container.memory`), for example
`{"dynamic": {"launcher": {"vcpus": 2}, "container": {"memory": {"limit": "3g", "reservation": "2g"}}}}`. Without
configuration both kinds get 1 vCPU / 2 GB and a container limit of `1536m` (reservation `1280m`), which leaves room
for `dockerd` and the OS; a limit that leaves the VM less than 256 MiB is refused. The spike suggests 2 vCPU / 4 GB for
the Dynamic-Worker; its real peak is not measured yet, so that is a configuration change, not a code change. A wrong
value fails the deployment at start (`DISPATCHER_WORKER_CONFIG`), not the first job.

**Capabilities.** The Launcher advertises `pr-agent` only. `opencode` is advertised after the capability probe (#331)
has vouched for the hardening in a canary VM: until then the Dynamic-Worker is not claimed here (fail closed).

**What the container can reach (documented, not relied on).** The VM's agent listens on `172.17.0.1:23456` (the Docker
bridge gateway). Container root can reach it; the Dynamic engine's uid cannot, only because the egress rules drop it
(spike #317). No process in the VM can open an `AF_VSOCK` socket: a platform filter denies it, and Docker's default
profile adds a second layer. Nothing here depends on these; they are recorded because the supervisor's egress inside the
VM is unrestricted by design (#82 stays an open hosted gate). The platform operator can read job secrets by construction.

**Authentication.** Without credentials the SDK uses the OIDC token of the Vercel project, automatic inside a Function.
With `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` it uses that access token. The token is masked in every log
line and is never sent anywhere but to the SDK.

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
| `SANDBOX_SNAPSHOT_ID`                                                      | Vercel entry: the golden snapshot (#330 record `snapshotId`). Unset: no launcher, nothing is claimed                   | none         |
| `SANDBOX_IMAGE_DIGEST`                                                     | The Worker image id in that snapshot (#330 record `imageDigest`, `sha256:` and 64 hex). Required with the snapshot     | none         |
| `SANDBOX_HANDOVER_SECONDS`                                                 | How long the container runs before the Worker counts as having taken over, 1 to 120                                    | `20`         |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`                      | Platform access by token (all three). Without a token the OIDC token is used                                           | OIDC         |
| `DISPATCHER_SHUTDOWN_GRACE_SECONDS`                                        | Node entry: how long launches may finish after SIGTERM, 0 to 600                                                       | `60`         |
| `PORT`                                                                     | Node entry                                                                                                             | `8080`       |

## The golden snapshot pipeline

`src/snapshot/` builds and checks the VM snapshot that every Sandbox job VM is cloned from (#330). It is a command
(`pnpm snapshot:build`, run by `.github/workflows/golden-snapshot.yml`), not part of the Dispatcher at run time: no entry
imports it and the serverless bundle does not contain it. It talks to the platform through the port `src/snapshot/service.ts`
(`vercel-service.ts` is the only file that knows the SDK) and its tests run against `fakes/vercel-sandbox`. Steps, the record,
rebuild, rollback, retention, the scan and the failure codes are in `docs/golden-snapshot.md`.

## Working here

From the repository root: `make lint`, `make typecheck`, `make test-unit`, `make test-integration`, `make verify`.
Inside `dispatcher/`: `pnpm test`, `pnpm test:int`, `pnpm test:privileged` (a Docker daemon and the Worker image, `make test-sandbox-local`), `pnpm exec vitest run <path>`, `pnpm start` (the Node entry).
`src/contracts/` is generated from `contracts/` (`make generate-contracts`) and never edited by hand. The project
imports nothing from `app/` or `runner/`; what is shared is the contracts and `fakes/` (`fakes/dispatcher-app` is the
fake App every test here runs against). See `TESTING.md` for the test rules.
