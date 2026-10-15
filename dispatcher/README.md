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

| Part                                                                              | Where                                            | Status                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Dispatcher core: claim, capacity, heartbeat during the launch, release on failure | `src/core/`                                      | here; platform-free (no `node:*`, no platform SDK: ESLint and a test check it)           |
| Webhook-Trigger: `POST /dispatch`, `GET /health`                                  | `src/triggers/webhook.ts`, `src/app.ts`          | here                                                                                     |
| Fake Launcher (tests)                                                             | `src/launchers/fake.ts`                          | here                                                                                     |
| Hardened container spec renderer and `ContainerLauncher` (#325)                   | `src/launchers/container*.ts`                    | here, used by the Sandbox-Launcher (#329) and the Docker-Launcher (#334)                 |
| Sandbox-Launcher over the Vercel Sandbox SDK (#329)                               | `src/launchers/sandbox*.ts`, `vercel-sandbox.ts` | here, wired into the Vercel entry when `SANDBOX_SNAPSHOT_ID` is set                      |
| Capability probe, `POST /probe`, canary VM, deploy canary command (#331)          | `src/probe/`, `src/launchers/sandbox-canary.ts`  | here, in front of the Sandbox-Launcher: `opencode` is advertised from a fresh probe only |
| Vercel entry, a default export                                                    | `src/index.ts`                                   | here: the Sandbox-Launcher when a golden snapshot is configured, else `noLauncher`       |
| Node entry, `@hono/node-server` and a graceful shutdown                           | `src/node.ts` (`pnpm start`)                     | here, with no engine until the Docker-Launcher (#334) is wired in                        |
| Poll-Trigger, Docker-Launcher                                                     | `src/triggers/poll.ts`, `src/launchers/`         | #334                                                                                     |
| Golden snapshot pipeline (a command, not a runtime part)                          | `src/snapshot/`, `pnpm snapshot:build`           | here (#330), `docs/golden-snapshot.md`                                                   |

Two entry files keep `node:child_process` (the Docker-Launcher's way of starting a process) out of the serverless
bundle (none of ours: the Sandbox SDK's dependency tree holds `execa` for a local-development token fetch and `undici`; the
test leaves out exactly those two, each only as imported by its known importer); `src/bundle/serverless-bundle.test.ts` follows the import graph of `src/index.ts` to prove it. Without a real
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
   must be among them, else `not_capable`. The core says which engine it is about to need (`want`: the job's kind),
   so a Launcher that must prove an engine first can answer for the other one at once. A Launcher that is still
   proving the wanted engine throws `CapabilitiesPending` (a probe is on its way): the answer is `503` with its
   `Retry-After`, nothing is claimed and no error is logged ("The capability probe", below).
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
  capabilities(signal, want?: Engine): Promise<readonly Engine[]>; // what it can run right now; fail closed
  launch(spec: LaunchSpec, signal): Promise<void>; // resolves when the Worker has taken over; throws LaunchError
  probe?(signal): Promise<ProbeResult>; // runs the capability probe now (POST /probe); never rejects
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
   `{app, kind, job}`, and a **timeout of the job's plus 300 seconds** (`SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`, at least 180 and at least 150 more than the
   hand-over time: the platform counts from the creation of the VM, the Worker's own timer from the start of the container, so
   the margin has to cover create, `vm-prepare.sh`, the image check and the hand-over besides the Worker's `timeout` result), the backstop that ends a VM nobody stops. The name
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
5. When the container ends, the VM is stopped by the name the platform returned (`stop()` takes about 2.4 s for an idle VM,
   22.6 s with a running container, so the container ends first). A `wait()` that fails (a broken log stream or network
   during a long job) is asked again, three tries in all; if it still fails, what became of the container is unknown, so
   the VM is **not** stopped under a Worker that may be reviewing: `worker_wait_failed` is logged and the VM timeout ends
   it. There is no `poweroff` in the image (spike T13).

**The function lifetime and the VM timeout.** The supervision of step 5 is work held in `waitUntil`, so it lives as long as
the Dispatcher's function may. `vercel.json` sets `maxDuration` of `src/index.ts` explicitly to **1800 s** and the region
to `fra1`. 1800 s is the extended maximum for Pro and Enterprise teams on Node.js 22 or 24 (**beta**; 800 s is the generally
available maximum, and Hobby is limited to 300 s); it covers the default job (1200 s) plus its launch (at most 300 s). When
the function ends before the container does (a job of more than about 1500 s, a platform restart, a lost instance), nothing
stops the VM and **the VM timeout is the backstop**: it keeps running, idle and billed, until job + margin after its
creation. A reaper that stops leftover VMs by their tags is a follow-up of #316, to be done before staging.

Every failure before the hand-over stops the VM by name and ends in a `LaunchError` with a stable code and a `retryable`
flag. The core releases the job with `launch_failed` and the App counts the attempt (three attempts, then `failed`), no
matter whether the flag is set; it is for logs and for the operator.

| Code                                                                      | Retryable                    | Cause                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox_rate_limited`, `sandbox_quota_exceeded`                          | yes                          | the platform's limits                                                                                                                                                                                                                                                                |
| `sandbox_network`, `sandbox_unavailable`                                  | yes                          | no answer, or a platform error (these also stop by name: the VM may exist)                                                                                                                                                                                                           |
| `image_not_ready`                                                         | yes                          | the platform says the snapshot is not ready                                                                                                                                                                                                                                          |
| `sandbox_auth_failed`                                                     | no                           | the platform refuses the credentials (HTTP 401 or 403): an expired or wrong token or OIDC token                                                                                                                                                                                      |
| `docker_not_ready`                                                        | yes                          | `vm-prepare.sh` exited with an error (cgroup or `dockerd`)                                                                                                                                                                                                                           |
| `vm_prepare_failed`                                                       | yes                          | a call of the host preparation failed in a way no other code names (a platform failure keeps its own code)                                                                                                                                                                           |
| `worker_exited_early`                                                     | no for exit 1, yes otherwise | the container ended with an error before the hand-over. Exit 1 is the Worker reporting that the job failed, after delivering its own result: a second VM gets the same answer. A setup error (2), docker's own refusals (125 to 127) and a kill (137) are about this VM or its start |
| `worker_start_failed`                                                     | yes                          | the container could not be started                                                                                                                                                                                                                                                   |
| `sandbox_snapshot_missing`, `sandbox_region_mismatch`, `sandbox_rejected` | no                           | the snapshot is gone or in another region; the platform refuses the request                                                                                                                                                                                                          |
| `image_missing`, `image_mismatch`                                         | no                           | the VM has no such image, or not the configured one                                                                                                                                                                                                                                  |
| `sandbox_config_invalid`                                                  | no                           | a VM size or memory limit the Launcher cannot run                                                                                                                                                                                                                                    |
| `sandbox_create_failed`                                                   | no                           | an error it does not recognise                                                                                                                                                                                                                                                       |
| `launch_aborted`                                                          | no                           | the deadline, a lost lease or a shutdown aborted the launch                                                                                                                                                                                                                          |

The classification of the platform's errors goes by the HTTP status first (429 rate limit, 402 quota, 401 and 403 authentication, 5xx platform), then by the code of the error body (an explicit quota or `limit_exceeded` code), then by words of the message for the snapshot and the region; a message that only says `limit` or `exceeds` is not a quota; the
platform does not document its error bodies, so the mapping is **not verified against the live API** (a follow-up of the
first real run). Only the code is logged, never the platform's text.

**Sizes.** The platform's VMs have 1 vCPU or an even number up to 8, and 2 GiB of memory per vCPU. Per Worker kind,
`DISPATCHER_WORKER_CONFIG` sets the VM (`launcher.vcpus`) and the container memory (`container.memory`), for example
`{"dynamic": {"launcher": {"vcpus": 2}, "container": {"memory": {"limit": "3g", "reservation": "2g"}}}}`. Without
configuration both kinds get 1 vCPU / 2 GB and a container limit of `1536m` (reservation `1280m`), which leaves room
for `dockerd` and the OS; a limit that leaves the VM less than 256 MiB is refused. The spike suggests 2 vCPU / 4 GB for
the Dynamic-Worker; its real peak is not measured yet, so that is a configuration change, not a code change. A wrong
value fails the deployment at start (`DISPATCHER_WORKER_CONFIG`), not the first job.

**Capabilities.** The Launcher itself advertises `pr-agent` only. `opencode` is added in front of it by the capability
probe (#331) when a canary VM has vouched for the hardening: until then the Dynamic-Worker is not claimed here (fail
closed). Next section.

**The Dynamic configuration of the container.** The container of a Dynamic job (not a Diff job's) is given the operator's
`RUNNER_DYNAMIC_CAPABILITIES` (the model's descriptor, a JSON object) and `RUNNER_DYNAMIC_MAX_COST_USD` (the cost limit of
a run) from the Dispatcher's own environment, as the self-hosted `runner-dynamic` service has them: both names are on the
container spec's allow-list, both are non-secret, and a value that is not of the right form fails the deployment at start,
not the first Dynamic job. The runner reads them again and decides what they mean. The canary gets the same. They are read, and refused when malformed, only by a deployment that serves Dynamic jobs
(`DISPATCHER_ENGINES` includes `opencode`): a typo there does not take a Diff-only Dispatcher down.

**What the container can reach (documented, not relied on).** The VM's agent listens on `172.17.0.1:23456` (the Docker
bridge gateway). Container root can reach it; the Dynamic engine's uid cannot, only because the egress rules drop it
(spike #317). No process in the VM can open an `AF_VSOCK` socket: a platform filter denies it, and Docker's default
profile adds a second layer. Nothing here depends on these; they are recorded because the supervisor's egress inside the
VM is unrestricted by design (#82 stays an open hosted gate). The platform operator can read job secrets by construction.

**Authentication.** Without credentials the SDK uses the OIDC token of the Vercel project, automatic inside a Function.
With `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` it uses that access token. The token is masked in every log
line and is never sent anywhere but to the SDK.

## The capability probe

The Dynamic-Worker must be advertised only if our hardening is established in the VM, and "established" means proven now,
not configured: advertising `opencode` from configuration alone would claim Dynamic jobs that the container then fails
(#331). The Vercel entry therefore puts the Sandbox-Launcher behind `withCapabilityProbe`
(`src/probe/probed-launcher.ts`) when `DISPATCHER_ENGINES` includes `opencode`.

**What is proven.** The image's `probe` mode (#324, `runner/README.md`) runs the container's own startup in a canary VM
and prints one line, the verdict (`contracts/probe-verdict.v1.json`): the engines the container may advertise and, when
`opencode` is not among them, the stable reasons of the startup self-check (`docs/dynamic-review.md`, "The startup
self-check"). `opencode` is in it only when the whole self-check passed: the hardening of the container (root, the eight
capabilities then `NET_ADMIN` and `SETPCAP` dropped, a read-only root), the egress mode (the full `inet` ruleset or the
fallback), IPv6 proven off where the fallback ruleset needs it, the pinned engine and `rg`, and the probe as the engine
user. The canary runs with the **real flags** of a Dynamic-Worker: the one rendered container spec, the memory of the
Dynamic kind, the two IPv6 switches of the Sandbox variant (`SANDBOX_LAUNCHER_ADDITIONS`) and the Dynamic environment of a
job, so a launch flag that is wrong makes the probe fail instead of the job.

**The canary VM** (`src/launchers/sandbox-canary.ts`) is a job VM without a job: a VM from the golden snapshot
(`persistent: false`, `fra1`, the size of a Dynamic job, tags `{app, kind: canary, job: canary}`, a timeout beyond the
probe's own as the backstop), `vm-prepare.sh`, the image check (a probe of another image proves nothing), `docker run` of
the image by id with `probe` as its command, and the VM is stopped by name whatever happened. It has no stdin, no App URL,
no token and no credential. The exit status of the probe must be 0 (the probe ran; 2 means it had nothing to say).

**Reading the verdict** (`src/probe/verdict.ts`) treats it as data from a container that runs next to hostile pull request
content: one line, at most 64 KiB, version 1; the engines it knows and the reasons of the contract's closed list are
kept, anything else (a field, a text, a value shaped like a secret) is dropped and never echoed or logged. `opencode`
counts as proven only when the verdict says it **and** gives no reason against it, and no reason was dropped as unknown.

**Cache and refresh** (`src/probe/capability-probe.ts`). One answer per Dispatcher instance, in memory:

| Answer                                                               | Counts for                              | Then                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `passed` (`opencode` proven)                                         | `DISPATCHER_PROBE_TTL_SECONDS` (1 hour) | refreshed lazily when the next call finds it stale                                                                            |
| `denied` (the container answered without `opencode`: its reasons)    | the same hour                           | the same                                                                                                                      |
| `failed` (no verdict: the platform, the VM, the container, the time) | one minute                              | tried again by the next call, so a platform that comes back is used again soon and an outage does not create a VM per wake-up |

Only one probe runs at a time per instance: any number of wake-up calls and a forced probe share it. A probe that takes
longer than `DISPATCHER_PROBE_TIMEOUT_SECONDS` (150) is a `failed` answer (`probe_timeout`). The probe then waits up to 10
seconds for the run to finish stopping its canary VM before it answers, so the stop is part of the work held in `waitUntil`
and a frozen function does not leave the VM to its timeout. **A stale answer is not used**: the first call after the hour
finds nothing proven. A `failed` answer never replaces a `passed` one that still counts (below).

**What a wake-up call sees.** A Diff job never waits for a probe and never starts one. A Dynamic job:

- with a fresh `passed` answer: `opencode` is advertised and the job is claimed;
- with no fresh answer: the probe is started in the background (`waitUntil`), and the call is answered `503` with
  `Retry-After: 20`. The App's sender (8 second timeout) must not wait for a canary VM, and it asks again after the
  retry time. Nothing is claimed;
- with a fresh `failed` answer (no verdict: a platform error, a timeout): `503` with `Retry-After` of what is left of the
  failure minute, at least 20 s. A transient error must not look like "not capable": the App stops sending a job
  that was answered `not_capable` for ten minutes, a `503` is retried on its back-off (10 s, 30 s, 2 min, ...; the longer of
  that and the header). Nothing is claimed. `app/src/dispatch/capability-probe-answers.test.ts` holds both answers against the
  sender;
- with a fresh `denied` answer (the container's own "no", with its reasons): PR-Agent only, so the call is answered
  `200 ignored` with `not_capable` and nothing is claimed. The App stops sending that job, revives the dispatch ten minutes
  later (a Dispatcher that was fixed is asked again, slowly), and a Dynamic job that nobody can run ends `no_capable_runner`
  after 30 minutes (`app/src/dispatch/README.md`). Diff jobs are unaffected throughout.

Between the claim and the launch the proof is checked once more: a Dynamic job is launched only while a `passed` answer still
counts, otherwise the launch fails with the retryable `capability_not_proven` and the job is released like any failed launch
(the Worker proves the same again itself in `worker-once`; this is defence in depth). A "poll" call that wants no engine in
particular gets PR-Agent only while nothing is proven.

The stable reasons and codes are logged (`probe_passed`, `probe_denied` with the reasons, `probe_failed` with the code):
the reasons of the self-check list, and for a probe that gave no verdict a code of the **closed** list `ProbeFailure`
(`src/probe/failure-codes.ts`, equal to the contract's): the launch codes of a job VM (`sandbox_unavailable`,
`docker_not_ready`, `image_mismatch`, ...) and `probe_timeout`, `probe_unreadable` (the output is not a verdict),
`probe_exit_nonzero`, `probe_exec_failed`, `probe_aborted`, `probe_not_supported`, `probe_error`. Anything else, such as a code in
a platform's error, is `probe_error`.

**Cost.** A probe is one short VM (tens of seconds) per instance per hour of Dynamic traffic, and one more for every new
serverless instance that serves its first Dynamic call. A Diff-only deployment (`DISPATCHER_ENGINES=pr-agent`) has no probe.

### `POST /probe`

Forces a probe (or joins the one that runs) and answers its report (`ProbeReport` of the contract). The call needs the
dispatcher credential as `Authorization: Bearer <RUNNER_TOKEN>`, checked in constant time **before** anything is started: a
refused call creates no VM, and every refusal is the same `401` with the same body.

**Throttle.** A forced probe is served from the last answer, whatever its status, when that is younger than
`DISPATCHER_PROBE_REUSE_SECONDS` (60; 0 turns it off; `checkedAt` of the report says when it was made), so a holder of the
credential cannot run canary VMs back to back. A fresh deployment instance has an empty cache, so the deploy canary
against a new deployment is always a real run. **A forced probe that only failed** (a platform error, a timeout) is
reported to its caller, and the deploy step is blocked, but it does **not** replace a `passed` answer that still counts:
production Dynamic is not switched off by a bad minute of the platform during a release check. A real `denied` verdict
(the container's own answer) does replace it.

| Status | Body                                                                                          | Meaning                                                           |
| ------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `200`  | `{version, status, ok: true, engines, reasons, checkedAt}`                                    | every engine this deployment is configured to serve is advertised |
| `503`  | the same with `ok: false`; `status` is `denied` (with `reasons`) or `failed` (with `failure`) | the canary did not pass, or could not run: block the release      |
| `401`  | `RUNNER_UNAUTHORIZED`                                                                         | no, a wrong or a malformed credential                             |

`status: failed` with `failure: probe_not_supported` is a Launcher that has no probe (the Node entry's `noLauncher`): it
proves nothing and advertises what it advertises.

### The deploy canary

`pnpm probe:canary --url https://<dispatcher> [--allowed-hosts host,host] [--check-only] [--engines pr-agent,opencode] [--wait-seconds 120] [--timeout-seconds 300]`
(`src/probe/canary.ts`) is the step of a release pipeline that calls `POST /probe` and fails the release when the Dynamic
canary fails. The credential is `RUNNER_TOKEN` in the environment (never an argument); `VERCEL_AUTOMATION_BYPASS_SECRET`, when set,
is sent as `x-vercel-protection-bypass` for a deployment behind deployment protection. It waits for the deployment to answer
`GET /health` first (never sending the credential there), sends the credential to that one URL (https, or http to this machine;
no redirect is followed) and prints stable codes and the contract's reasons only. With `--allowed-hosts` (or
`CANARY_ALLOWED_HOSTS`) a URL whose host is not on the list is refused with exit 2 **before any request**, this machine included;
an empty list refuses every URL. `--check-only` does only that check, without a credential.

| Exit | Meaning                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the deployment advertises every required engine (both by default) from a probe that ran just now                                  |
| `1`  | it does not, it could not be reached or refused the credential, or answered something that is not a report: **block the release** |
| `2`  | wrong use (a bad URL or option); nothing was sent                                                                                 |

`.github/workflows/dispatcher-canary.yml` runs it (`workflow_dispatch`, or `workflow_call` from a release workflow) in the
environment `hosted-canary`, which holds the secrets `RUNNER_TOKEN` and, when needed, `VERCEL_AUTOMATION_BYPASS_SECRET`; inputs
are `url` and `engines` (`pr-agent` for a Diff-only deployment). The credential is sent to one host only: a step without any
secret first checks the `url` against the repository variable **`DISPATCHER_CANARY_HOSTS`** (exact host names, comma separated;
unset or empty refuses every URL), and the step with the secrets checks it again. The job runs only from `main` and
`development` (its own condition, because a manual run executes the code of the branch it is started on).

**What the maintainer sets on the environment `hosted-canary`** (repository settings, Environments), because a workflow cannot
protect itself: _Deployment branches and tags_: **selected branches**, `main` and `development` only (without it any branch could
run its own copy of the canary code with the environment's secrets); _Required reviewers_: at least one person other than whoever
starts the run; no secret of any other purpose in it. `RUNNER_TOKEN` there is the Dispatcher project's dispatcher credential;
rotate it with the Dispatcher project's. The sequence of a release: deploy the Dispatcher to a URL
that carries the candidate `SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST` (a preview deployment, or the new production
deployment before it is promoted), run the canary against it, promote only on exit 0. After a golden snapshot rebuild
(`docs/golden-snapshot.md`) the same step proves the new snapshot before the Dispatcher project is switched to it.

**The engine uid and the VM's agent channel (#317).** The spike found that no process in the VM can open an `AF_VSOCK` socket
(a platform filter) and that the container's root can reach the VM's agent on the Docker bridge gateway while the engine
uid cannot, only because its egress rules drop it. The probe proves those rules (`network_probe_failed`, `network_rules_not_installed`),
so a Dynamic-Worker whose rules are not in place is not advertised. A seccomp profile that denies a socket family
(`src/launchers/seccomp.ts`) stays available but is not required and is not enabled.

## Configuration

Names only: a refusal names the variable, never the value.

| Variable                                                                   | Meaning                                                                                                                                                                                       | Default      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `RUNNER_API_URL`                                                           | Base URL of the App                                                                                                                                                                           | required     |
| `RUNNER_TOKEN`                                                             | The dispatcher credential (the runner API token)                                                                                                                                              | required     |
| `DISPATCHER_MAX_RUNNING`                                                   | The pool cap, 1 to 1000                                                                                                                                                                       | required     |
| `DISPATCHER_SIGNING_KEY_ID`, `DISPATCHER_SIGNING_SECRET`                   | The key the App signs the wake-up call with; the secret has at least 32 characters and differs from every other secret                                                                        | required     |
| `DISPATCHER_SIGNING_KEY_ID_PREVIOUS`, `DISPATCHER_SIGNING_SECRET_PREVIOUS` | The previous key, accepted while the keys rotate                                                                                                                                              | none         |
| `DISPATCHER_POOL_ID`                                                       | Sent as `X-Runner-Id`; the App counts the running jobs of the pool by it                                                                                                                      | `dispatcher` |
| `DISPATCHER_ENGINES`                                                       | `pr-agent`, `opencode` or both                                                                                                                                                                | both         |
| `DISPATCHER_JOB_TIMEOUT_SECONDS`                                           | How long a Worker may live, 60 to 21600                                                                                                                                                       | `1200`       |
| `DISPATCHER_WORKER_CONFIG`                                                 | JSON `{"diff": {...}, "dynamic": {...}}` with `container.memory` and `launcher`                                                                                                               | none         |
| `SANDBOX_SNAPSHOT_ID`                                                      | Vercel entry: the golden snapshot (#330 record `snapshotId`). Unset: no launcher, nothing is claimed                                                                                          | none         |
| `SANDBOX_IMAGE_DIGEST`                                                     | The Worker image id in that snapshot (#330 record `imageDigest`, `sha256:` and 64 hex). Required with the snapshot                                                                            | none         |
| `SANDBOX_HANDOVER_SECONDS`                                                 | How long the container runs before the Worker counts as having taken over, 1 to 120; with create, `vm-prepare.sh` and the image check (150 s) it must fit in the core's 300 s launch deadline | `20`         |
| `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`                                        | Seconds added to the job's timeout for the VM's own, 180 to 3600 and at least the hand-over time plus 150                                                                                     | `300`        |
| `DISPATCHER_PROBE_TTL_SECONDS`                                             | How long a capability probe's answer counts before a new canary VM is asked, 60 to 86400 (#331)                                                                                               | `3600`       |
| `DISPATCHER_PROBE_REUSE_SECONDS`                                           | A forced probe (`POST /probe`) is served from an answer younger than this instead of a new canary VM, 0 to 600; 0 runs every one                                                              | `60`         |
| `DISPATCHER_PROBE_TIMEOUT_SECONDS`                                         | How long a probe may take, the canary VM included, 30 to 600                                                                                                                                  | `150`        |
| `RUNNER_DYNAMIC_CAPABILITIES`, `RUNNER_DYNAMIC_MAX_COST_USD`               | The operator's Dynamic configuration for the container of a Dynamic job and for the canary: a JSON object (no line breaks, at most 4096 characters) and a plain positive decimal              | none         |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`                      | Platform access by token (all three). Without a token the OIDC token is used                                                                                                                  | OIDC         |
| `DISPATCHER_SHUTDOWN_GRACE_SECONDS`                                        | Node entry: how long launches may finish after SIGTERM, 0 to 600                                                                                                                              | `60`         |
| `PORT`                                                                     | Node entry                                                                                                                                                                                    | `8080`       |

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

The hosted end-to-end lane (#332, `TESTING.md`, "Hosted e2e lane") runs this project as a process: `src/test-support/hosted-e2e-main.ts` is the
Node entry's composition with the Sandbox-Launcher and the capability probe over the local mode of the Sandbox double
(`fakes/sandbox/local.ts`) and `fakes/sandbox/bin/docker-worker.sh`, which runs the real Worker as a local process in place of the
container. It repeats the wiring of `sandboxFromEnvironment` with that one platform, so a change to the wiring is a change there too. It
is test code: no entry of a deployment imports it.
