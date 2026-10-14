# Dynamic Review: operating it

Dynamic Review is the second review kind next to Diff Review (PR-Agent): an agent reads the pull
request's code in a sanitised, read-only export and returns structured findings that the runner
publishes as one persistent summary comment. The decisions are in epic
[#193](https://github.com/ExpidetGames/code-reviewer/issues/193), the research in
`docs/spike/85-opencode-dynamic-review.md`, and the short deployment record is
[`docs/decisions/0002-dynamic-review-deployment.md`](decisions/0002-dynamic-review-deployment.md).

> **Status: shippable, off by default.** The engine is in the Dynamic runner image, the runner proves
> its isolation at start and advertises `opencode` only when the proof passes, and the instance admin
> has a switch for the rollout gate. Nothing turns Dynamic Review on by itself: the gate is off in
> every shipped configuration, `compose.dynamic.yml` is opt-in, and the default runner image holds no
> engine. The steps to switch it on are under "Activation, step by step"; whether and when to do it
> on an instance is the operator's decision. Read "Known limitations and residual risks" first.

## What exists, and what does not

| Part | State |
|---|---|
| Project setting `review_kind` (Diff or Dynamic), editable skill, default model `deepseek-v4.1-flash` | Shipped (#194, #200) |
| Rollout gate `dynamic_review` (instance setting, default off), admin control | Shipped (#195, #202) |
| Job tag, capability matching, `no_capable_runner`, `dynamic_review_disabled` | Shipped (#195) |
| Sanitised read-only checkout of the pull request head | Shipped (#196) |
| Fixed review core and the editable skill | Shipped (#198) |
| Engine seam: trusted config, hard limits, per-job model proxy, adapter, process-group cleanup | Shipped (#197 part 1, #202 process-group reuse) |
| Summary comment, findings state, reconciliation | Shipped (#199) |
| Real pinned OpenCode fetch, proxy-side audit, hostile-repository proof; launch as the dedicated engine user, static per-user network rules, `NET_ADMIN` dropped after startup | Shipped (#197 parts 2a and 2b, #244) |
| The Dynamic runner image: the `dynamic` target of `runner/Dockerfile` with the pinned OpenCode, a pinned `rg`, `nft` and the engine user (**linux-x64 glibc only**: the pins have no other platform, an arm64 image needs its own pinned digests) | Shipped (#202) |
| Startup self-check that advertises `opencode` only when everything holds, with a stable logged reason otherwise | Shipped (#202) |
| Opt-in deployment: `compose.dynamic.yml` (Docker Compose) and `compose.coolify.dynamic.yml` (Coolify, **untested on a real Coolify**) | Shipped (#202) |
| Provenance audit of the engine binary and `rg` in `make check-licenses` (source commit, licence, the Bun-lock runtime closure of the pinned commit), notices in `NOTICE` and `THIRD_PARTY_LICENSES.md` | Shipped (#202) |
| Worst-case memory and OOM measurements, the decision to run more than one Dynamic job at a time | **Manual step, not done** (needs a real deployment target, see "Capacity") |
| Full path from a signed webhook to the Run, including the pull request title, body and previous-review state in the prompt | Open (#201), see "Known limitations" |
| Hosted activation | Needs the hosted egress gate (#82) |

## How a Dynamic job reaches an engine

1. A project set to Dynamic Review enqueues a job tagged `review_kind: dynamic`, **only while the
   instance gate is on**. With the gate off the run is created `failed` with
   `dynamic_review_disabled`; it is never reviewed as a Diff.
2. A runner claims a Dynamic job only if it advertises `opencode` in the claim. The runner
   advertises it only after its startup self-check proved the dedicated engine user, the read-only
   export and proxy-only egress (`runner/src/code_reviewer_runner/dynamic_review/self_check.py`, see
   "The startup self-check"). A runner that fails it, and every PR-Agent-only runner, serves Diff
   jobs only.
3. A Dynamic job that no capable runner claims waits, without an attempt being counted, and is
   **cancelled with `no_capable_runner`** after `RUNNER_NO_CAPABLE_TIMEOUT_SECONDS` (app setting,
   default 30 minutes). It is visible in Runs; it never waits forever and never falls back to Diff.
4. The runner prepares the export (#196), starts one engine per job behind its own model proxy (the
   workspace key never reaches the engine), enforces the hard limits below, publishes (#199) and
   removes the job's temporary files and process group.

PR-Agent-only runners keep processing Diff jobs unchanged. A Dynamic-capable runner also serves Diff
jobs.

## The engine boundary

The container, not a sandbox, is the boundary (lead decision of 2026-10-12): no bubblewrap, no user
namespaces, no host kernel setting beyond the `nf_tables` support every current kernel has.

- **Two users in one container.** The job process is the **supervisor** and runs as root with exactly
  the capabilities listed in `compose.dynamic.yml` (`SETUID`, `SETGID`, `KILL`, `CHOWN`,
  `DAC_OVERRIDE`, `FOWNER` for its whole life; `NET_ADMIN` and `SETPCAP` for container startup only,
  see below; everything else dropped, `no-new-privileges` on). It holds
  every credential and the model proxy. The **engine** runs as the dedicated unprivileged user
  `10101:10101` of the image, with no capability, no supplementary group, a closed environment, its
  own home and temporary directories, and a config file only it can read. It is started with
  `setuid()` in the child process: no `sudo`, no setuid helper, so `no-new-privileges` can stay.
- **Why those capabilities.** `SETUID`/`SETGID` start the engine as the other user; `KILL` signals
  its process group and its leftovers; `CHOWN` seals the read-only export (#196); `DAC_OVERRIDE` and
  `FOWNER` remove the sealed export and the tree the engine user may have filled (sticky and
  unreadable directories included). `SYS_ADMIN`,
  `SYS_PTRACE` and `NET_RAW` are deliberately absent. Diff jobs on the same loop are dropped to uid
  10001 (`RUNNER_DIFF_JOB_USER`) and hold none of these.
- **Network: one user, one proxy.** The runner installs `nftables` output rules keyed on the socket
  owner **once, when the container starts**, for the single slot's fixed ports
  (`RUNNER_DYNAMIC_PROXY_PORT`, default 10180; `RUNNER_DYNAMIC_ENGINE_PORT`, default 10181). The
  engine user may open new connections only to the job's proxy port and its own server port on
  `127.0.0.1`; everything else it tries (another job's loopback service, any other
  address, IPv6, UDP, a flow that someone else opened and closed) is rejected at once. Only the
  replies of the engine's own server pass as tracked traffic. A per-job network namespace would need `SYS_ADMIN`, and a
  container-level egress rule cannot tell the supervisor (GitHub, the model upstream) from the engine
  in the same container. The rules are proven before every engine starts, by a probe running as the
  engine user against sentinel listeners (without `NET_ADMIN` not even the supervisor can list the
  ruleset, so the probe is how a job verifies them); any other result is
  `dynamic_isolation_self_check_failed` and no engine is started. The hosted egress gate (#82) is
  still a separate requirement.
- **Cleanup.** At the end of a job, on SIGTERM (the job loop's way to end a job on lease loss,
  shutdown and timeout) and in the watchdog, the supervisor kills the engine's process group and then
  every process of the engine user, also helpers that left the group with `setsid()`, removes the
  user's processes and deletes the job directory (the rules are static and stay; the lease on the user and its group is released with the
  process). A job that was killed without a chance to clean up (SIGKILL, an OOM kill) leaves its
  engine user's processes behind; the job loop (root) sweeps the user after every Dynamic job process
  has ended, and every job sweeps it again as its first step after taking the lease. If a sweep cannot
  finish, the next job does not start (`dynamic_isolation_self_check_failed`).
  A second Dynamic job on the same user is refused by the lease with the same code: run one Dynamic
  job at a time per engine user.
- **`NET_ADMIN` is held during startup only (#244).** The container is created with `NET_ADMIN` and
  `SETPCAP` because the capabilities of a container are fixed at start. The runner's entry point
  installs the static rules, then drops both from the bounding set and from its own sets, before its
  event loop and before any other thread exists (a runner that cannot confirm the drop does not
  start). From then on the loop, every job process, the supervisor and the engine have a bounding set
  without them: `nft` fails for all of them, root included, and no process can add or remove a rule
  for the life of the container. It is per container, not forever: the container restarts
  (`restart: unless-stopped`) with a writable root filesystem, so a compromised root supervisor
  could change `nft`, `tini` or the runner source, crash the container, and get the restart with
  `NET_ADMIN`. The engine user cannot write those files. Closing this is tracked in #249.
  If the rules cannot be installed (no `nft`, no `nf_tables`) the capabilities are dropped anyway and
  every Dynamic job fails with `dynamic_isolation_self_check_failed` while Diff jobs keep running.
  The fixed slot ports are checked at startup against the kernel's ephemeral port range
  (`/proc/sys/net/ipv4/ip_local_port_range`); a port inside it, or a range that cannot be read,
  means the rules are not installed and every Dynamic job fails closed. Keep the defaults (10180,
  10181) or other ports below the range.
  Only PID 1 (`tini`) keeps them. Do not run the container with `seccomp=unconfined`.
- **Nothing mounted, nothing shared.** `compose.dynamic.yml` has no `volumes`, `network_mode`, `pid`,
  `ipc` or Docker socket (a file test fails otherwise); do not add any. The rules do not cover
  AF_UNIX, and this is what keeps that gap empty. The privileged suite reads `/proc/net/unix` as the
  engine user and asserts that no listener other than its own exists and that no Docker socket is
  present.
- **What it does not give.** The engine can still reach a service on `127.0.0.1` that belongs to the
  engine user itself, a Unix socket (abstract or on a path) of the container's network namespace if
  one is ever added (none exists, see above) and anything the supervisor deliberately exposes
  there. The two ports are fixed, so a stranger holding one makes the job fail closed. With a concurrency above one the users and groups are leased
  per job (the image would need one pair per slot); the default is one slot.
- **Proof.** `runner/tests/privileged` runs as root with exactly the capability list above, in a
  startup phase (the container's created-with set) and a job phase (after the production startup
  step) (TESTING.md, "Privileged suite"); its CI step is part of the engine workflow.

## The Dynamic runner image

`runner/Dockerfile` builds two images from one shared base. The default target, `runtime`, is the
PR-Agent-only runner and is the last stage, so a plain `docker build -f runner/Dockerfile .` gives
it. The `dynamic` target adds:

| Part | Where | How it is pinned |
|---|---|---|
| Stock OpenCode v1.19.0 (about 186 MB, 60 MB compressed), unmodified | `/usr/local/bin/opencode`, owned by root, mode 0755 | `runner/opencode-pin.json`: release asset, source commit, size and SHA-256 of the archive and of the executable. The build downloads through `runner/scripts/fetch_opencode.py`, which accepts only the pinned bytes and checks that the executable reports the pinned version |
| ripgrep 14.1.1 (static musl release) | `/usr/local/bin/rg`, owned by root, mode 0755 | `runner/ripgrep-pin.json`, same checks (`runner/scripts/fetch_ripgrep.py`). The engine's grep and glob need it; without one the stock engine would download it at run time, which the runner never allows |
| `nft` | Debian's signed `nftables` package | Not pinned, by decision: `apt` installs the version Debian's repository has at build time (like `tini`), so it does not follow the base image digest and two builds on different days can differ. An exact `nftables=<version>` would not be reproducible either, because the Debian mirrors drop superseded versions and the build would break at the next point release. The package is signed, root-owned and has no setuid file (the smoke test measures that). It installs the engine user's network rules once, at container start |
| The engine user `engine` (uid and gid 10101, no home, no login shell, no other group) | `/etc/passwd` of the image | Fixed numeric ids, distinct from the Diff job user 10001 |
| Both pin files | `/opt/code-reviewer/pins/`, owned by root | The runner's self-check compares the installed files with them |

**Why a separate image and not one image.** The engine adds about 186 MB, and `nft`, `rg`, a second
user and a deployment shape that needs root and eight capabilities are things a Diff-only
installation never uses. A smaller image with fewer executables is a smaller attack surface, and the
default runner can never advertise `opencode`: it has no engine, no engine user and no `nft`, and its
smoke test asserts exactly that. Both images start as the unprivileged user 10001; the Dynamic image
only becomes a root supervisor through `compose.dynamic.yml` (`user: "0:0"` plus the capability list).

**What is trusted.** The build downloads from GitHub release URLs and accepts the bytes only if they
equal the pinned size and SHA-256; at start the runner hashes the installed files again. Nothing at
run time downloads anything (no `curl`, no package manager, no model-catalog fetch, no repository
plugin discovery). The checksums say the files are the ones that were pinned, not that upstream is
free of defects. `make check-licenses` audits the licences of the two binaries and of the runtime
dependency closure of OpenCode's Bun lock at the pinned commit (`runner/opencode-bundled-licenses.json`);
that closure is an upper bound of what Bun's bundler embedded, because the embedded set cannot be
read from the binary offline.

## The startup self-check

When the Dynamic runner starts it first installs the engine user's static network rules and drops
`NET_ADMIN` and `SETPCAP` for good (ADR 0003), then runs this check **before its first claim**, and
only then does it send `opencode` in the claim. Every failure is "not advertised": the runner logs a
stable reason (never a value) and keeps serving Diff jobs.

| Reason (in the log) | What did not hold |
|---|---|
| `not_a_dynamic_runner` | No engine user is configured: this is the default runner (information, not a warning) |
| `not_root_supervisor` | The process is not root; `compose.dynamic.yml` sets `user: "0:0"` |
| `engine_user_invalid` | The engine user does not exist with its own group, or is root. Image users are 10101; do not change `RUNNER_DYNAMIC_ENGINE_UID`/`GID` without a matching image |
| `network_rules_not_installed` | `nft` could not install the rules: no `NET_ADMIN` at container creation, no `nf_tables` in the host kernel, no `nft`, or a slot port inside the kernel's ephemeral range |
| `capabilities_not_dropped` | The process still holds `NET_ADMIN` or `SETPCAP` |
| `pin_unreadable` | A pin file in `/opt/code-reviewer/pins/` is missing, malformed or has no entry for this platform (arm64) |
| `engine_binary_missing`, `ripgrep_missing` | The file is absent, a link, or not executable |
| `engine_binary_untrusted`, `ripgrep_untrusted` | The file is not owned by root or can be written by group or others |
| `engine_binary_checksum_mismatch`, `ripgrep_checksum_mismatch` | Size or SHA-256 differ from the pin |
| `engine_version_mismatch` | Run offline as the engine user, the engine does not report the pinned version |
| `network_probe_failed` | A probe run as the engine user could not reach the slot's proxy port, or could reach something else (another loopback service, another address, UDP). Also: a stranger holds the proxy port |

The full log line is `Dynamic Review: opencode is not advertised, this runner serves Diff jobs only
(dynamic_isolation_self_check_failed: <reason>)`; a passing check logs `Dynamic Review: opencode is
advertised, the startup self-check passed`. A successful `--version` is one item of the list and
proves nothing about isolation; what cannot be known at start (the sealed read-only export, the
unreadable private state, the network again) is proven for every job before its engine starts, and a
failure there ends that job with `dynamic_isolation_self_check_failed`.

The loop hands the job process of a Dynamic job the engines it advertised, the verified engine
command and the operator's `RUNNER_DYNAMIC_CAPABILITIES`; nothing an operator sets under
`RUNNER_OPENCODE_COMMAND` or `RUNNER_ADVERTISED_ENGINES` reaches a job. A Dynamic job that arrives at
a runner without `opencode` in that list is refused with `dynamic_engine_unavailable`.

## The model

Dynamic Review is model- and provider-agnostic. The default model name is `deepseek-v4.1-flash`; it
is a default, not an allow-list, and there is no provider routing or fallback. The workspace's
existing encrypted BYOK credential is used (no new key variable, no per-project key).

The operator describes what the selected model and destination can do in
`RUNNER_DYNAMIC_CAPABILITIES` (trusted runner configuration, never repository input):

```json
{"tool_choice_required": true, "structured_output": true, "max_output_tokens": 8192}
```

If it is unset, not JSON, or lacks a required feature, the run fails with
`dynamic_model_features_unsupported`. There is no silent fallback to another model or to a Diff
review.

## Hard limits

The limits are fixed in the code (`runner/src/code_reviewer_runner/dynamic_review/budget.py`); no
project setting or pull request text widens them, and the wall-clock limit is the minimum of the
epic's 600 seconds and the runner's job timeout.

| Limit | Value |
|---|---|
| Wall clock | 600 s (lower when `RUNNER_JOB_TIMEOUT_SECONDS` is lower) |
| Model calls | 30 |
| Total tokens consumed (cumulative, not the context window) | 120,000 |
| Tool calls | 200 |
| Distinct files read | 100 |
| One tool result | 64 KiB |
| All tool results together | 4 MiB |
| Untrusted input to the engine | 2 MiB |
| Findings | 30 |

A limit hit ends the run with `dynamic_budget_exceeded`; a run whose usage cannot be established ends
with `dynamic_accounting_failed`. The previous summary comment is preserved in both cases. The
tool, file and result-byte limits are enforced at the model proxy, before the request is forwarded
(#197 part 2a): a model request whose history exceeds one of them never reaches the provider.

## Errors an operator sees

| Code | Meaning | What to check |
|---|---|---|
| `dynamic_review_disabled` | The instance gate is off | Turn the gate on (below) when the rollout is ready |
| `no_capable_runner` | No runner advertised `opencode` within the timeout | Is a Dynamic runner running, and did its self-check pass? (`docker compose logs runner-dynamic`) |
| `dynamic_engine_unavailable` | The runner got a Dynamic job but has no engine | The job should only reach a capable runner; report it |
| `dynamic_isolation_self_check_failed` | The startup self-check did not prove user, export and network | The runner logs the failed property, never a value |
| `dynamic_model_features_unsupported` | The model or destination lacks tool choice or structured output | `RUNNER_DYNAMIC_CAPABILITIES`, the model |
| `dynamic_config_invalid` | Model, skill or limits of the job are unusable | The project's settings page |
| `dynamic_budget_exceeded`, `dynamic_accounting_failed`, `dynamic_policy_violation` | A hard limit or rule stopped the run | The Runs page |

Switching a project from Dynamic to Diff (or back) starts a fresh summary comment; findings are not
carried across kinds (lead decision of 2026-10-13, see #199). Cancelling a run kills its engine's
whole process group and removes its temporary directory.

## The opt-in runner (`compose.dynamic.yml`)

`compose.dynamic.yml` is an override file that adds a second runner, `runner-dynamic`, next to the
Diff runner of `compose.yml`. It builds the `dynamic` target from the checkout (the Dynamic image is
not published to GHCR):

```sh
docker compose -f compose.yml -f compose.dynamic.yml up -d --build --wait
```

| Setting | Default | Why |
|---|---|---|
| `RUNNER_DYNAMIC_CONCURRENCY` | 1 | One Dynamic job at a time until the memory matrix below exists |
| `RUNNER_DYNAMIC_MEMORY_LIMIT` | `2g` | At least 1 GiB per Dynamic slot plus the runner and proxy reserve (the spike's conservative, unvalidated proposal) |
| `RUNNER_DYNAMIC_MEMORY_RESERVATION` | `1536m` | The soft reservation under the limit |
| `RUNNER_DYNAMIC_IMAGE` | `code-reviewer-runner-dynamic:local` | Name of the image compose builds; set it to use a prebuilt one |
| `RUNNER_DYNAMIC_CAPABILITIES` | empty | The model description (see "The model"); empty makes every Dynamic job fail with `dynamic_model_features_unsupported` |

The container runs the supervisor as root with only the capabilities of "The engine boundary", sets
`no-new-privileges`, bounds its process count (512) and has no swap, so a memory peak shows up as an
OOM kill of the job rather than as a slow host. It publishes no port and reaches only the app. The
slot's proxy and engine ports are fixed (10180, 10181); they, the engine user and the Diff job user
belong to the image and the file, not to settings. Do not set `RUNNER_OPENCODE_COMMAND` by hand: the
runner ignores it.

With one slot (`RUNNER_DYNAMIC_CONCURRENCY=1`) a long Diff job can occupy the Dynamic runner's only
slot, because that runner also serves Diff jobs. A Dynamic job can then end with `no_capable_runner`
although a capable runner exists. Keep the Diff runner of `compose.yml` for Diff work and do not raise
the concurrency before the memory matrix exists; a later change can keep Diff jobs off this runner.

## Activation, step by step

This is the order to follow; every step can be stopped and rolled back. Nothing in it is done by
installing the files.

**Before you start.** A Linux Docker host (Docker Engine with Compose v2) whose kernel has
`nf_tables` (every current distribution kernel; the self-check tells you when it does not), that can
give the Dynamic runner container at least 2 GiB; an app that is already running with the workspace's
LLM key entered (Settings, LLM access; Dynamic Review reuses it, there is no other key); and, for the
model you choose, the knowledge of what it supports (tool choice "required" and structured output).

1. **Upgrade every app instance** to the version that routes by `review_kind`
   (`contracts/README.md`, "Rolling out Dynamic Review"). A previous-release app on the same database
   could hand a Dynamic row to a runner as an untagged Diff job. Do not continue until all instances
   are upgraded.
2. **Describe the model** in `.env`: `RUNNER_DYNAMIC_CAPABILITIES={"tool_choice_required": true,
   "structured_output": true, "max_output_tokens": 8192}` (use what your model and destination really
   support). Review the memory settings of the table above.
3. **Deploy the Dynamic runner:**
   `docker compose -f compose.yml -f compose.dynamic.yml up -d --build --wait`.
   The first build downloads the pinned engine (about 60 MB) and verifies it; if the bytes are not the
   pinned ones the build fails and the Dynamic runner is not started. Containers that already run
   (the app, the Diff runner) stay up: only the new service is missing.
4. **Verify the self-check.** `docker compose logs runner-dynamic | grep "Dynamic Review"` must show
   `Dynamic Review: opencode is advertised, the startup self-check passed`. If it shows `opencode is
   not advertised` the reason is in the same line: see the table in "The startup self-check". Fix it
   and recreate the container. Do not go on while it is not advertised. The Diff runner and the Diff
   jobs of this runner are unaffected either way.
5. **Turn the gate on.** As instance admin open **Admin, Setup, Instance, Dynamic Review**, tick *Allow
   Dynamic Review on this instance*, confirm that step 1 is done and save. The control is server side
   and admin only; it uses the instance settings setter (lock, then cancellation), never raw SQL.
   Nothing changes for existing projects: all are Diff until step 6.
6. **Choose one project to try it on:** set its review kind to Dynamic on its settings page. Open a
   pull request (or use Review now) and look at the Run: the kind, the model and a result URL are
   visible, and the previous successful summary stays in place if a run fails.

**Rollback** (the full procedure and its reasons are in `contracts/README.md`):

1. Switch the gate off in the same admin card. That stops new Dynamic jobs and cancels the waiting ones
   with `dynamic_review_disabled`; **running jobs finish** on their leases. Projects set to Dynamic
   get a visibly failed run, never a silent Diff review.
2. To stop the Dynamic runner: `docker compose -f compose.yml -f compose.dynamic.yml stop runner-dynamic`
   (it ends running jobs within the 90-second grace period) and, to remove it,
   `docker compose -f compose.yml -f compose.dynamic.yml rm -f runner-dynamic`. The Diff runner and
   the data are not touched.
3. Before any **downgrade of the app**, quiesce the runners, check that no Dynamic engine process is
   left and that no Dynamic job is `queued` or `running`, as `contracts/README.md` says. Switching a
   project from Dynamic back to Diff starts a fresh summary comment.

**Coolify.** `compose.coolify.dynamic.yml` is the same service as a standalone file for a second
Coolify resource; read the section "Dynamic Review runner" of `docs/deployment-coolify.md` first. It
has **not been tested on a real Coolify instance**.

## Capacity: slots, memory and what is not measured

The shipped defaults are **one Dynamic slot** (`RUNNER_DYNAMIC_CONCURRENCY=1`) and a **2 GiB limit with
1.5 GiB reserved and no swap**: at least 1 GiB per slot plus the runner and proxy reserve. That is the
spike's conservative proposal, not a measurement. The spike's stock trace (11 model calls, 5.8 s,
596.57 MiB peak RSS of the engine process with fake model answers) is **not** a capacity figure: it
excludes the export's page cache, the proxy, the runner and helper processes, and it used a tiny
repository. Do not raise the concurrency, and do not lower the limit below 1 GiB per slot plus the
reserve, until the following has been measured on your deployment target.

**What an out-of-memory kill does.** With no swap, a peak above the limit makes the kernel kill
processes of the container. If the engine or the job process is killed, the loop ends the job, the
job's engine-user processes are swept (also before the next job starts), the job directory is removed
by the loop, and the run fails; the previous summary comment is untouched. If the kernel kills the
runner's loop or PID 1, Docker restarts the container (`restart: unless-stopped`), the lease on the job
expires and the job is taken back or fails per the normal rules.

**Manual measurement (not part of CI; it needs a real host).** Record the host, the kernel, Docker's
version, the cgroup version and the image digest with the result.

1. Start the Dynamic runner as in the activation steps on a test instance with a test repository at
   the size you want to support (the checkout limits are in `docs/dynamic-checkout.md`) and a model
   endpoint you control.
2. Run a worst-case job: the largest export and the largest tool-result envelope the limits above
   allow. Read the container's cgroup peak, not process RSS: with cgroup v2,
   `docker exec <runner-dynamic> cat /sys/fs/cgroup/memory.peak` and `memory.events` (`oom_kill`);
   with v1, `memory.max_usage_in_bytes`. `docker stats` is a coarse cross-check.
3. Measure one slot only. The shipped image has one engine user and one pair of ports, so a second
   concurrent Dynamic job is refused by the lease (`dynamic_isolation_self_check_failed`);
   concurrency above one needs a pair of ports, an engine user and a ruleset per slot, which is not
   shipped.
4. Inject an OOM kill and an engine kill (`docker kill --signal=SIGKILL` of the engine's process, or a
   deliberately small `RUNNER_DYNAMIC_MEMORY_LIMIT`) and check that the previous comment is preserved,
   no process of the engine user and no job directory survives (`docker exec <runner-dynamic> ps -eo
   user,pid,cmd`, `ls /tmp`).
5. Write the measured peaks, the host and the recommended concurrency per GiB into this page. Until
   then no recommendation beyond the defaults exists. The byte-to-token calibration of the token cap
   (#235) uses the same runs.

No prices, quality or latency claim is made here; the offline benchmark plan is in the spike
write-up and needs a separately authorised run.

## Known limitations and residual risks

These are known and accepted for the switch-on decision, or tracked in an issue. They are not hidden
by the defaults.

- **The prompt lacks the pull request title, body and previous-review state on the production Dynamic
  path (#201).** The supervisor's preparation (`dynamic_review/supervisor.py`) does not pass them to the
  checkout, so the model sees the diff and the files but an empty title, an empty description and no
  prior findings in the prompt. The publisher still reads the existing comment's state itself and
  reconciles the findings, so the summary stays one persistent comment, but review quality and
  re-review behaviour are degraded until #201 wires the full path.
- **Hidden Unicode tag characters in repository files reach the model untouched (#247).** An attacker
  who controls repository text can hide instructions in tag characters.
- **A restarted container runs with `NET_ADMIN` again (#249).** The capability is dropped per container
  lifetime, not forever: `restart: unless-stopped` starts a fresh container with the writable root
  filesystem, so a compromised root supervisor that crashes the container and altered `nft`, `tini` or
  the runner source gets the restart with the capability. The engine user cannot do this.
- **The byte-to-token estimate of the token cap is uncalibrated (#235).** The cap is preventive and
  conservative, but its calibration against real tokenizers is open.
- **Nested `AGENTS.md` and similar files** in the repository can influence the model. The core marks
  repository content as untrusted data and the engine has no write, execute or general-network
  capability, but there is no guarantee of model resistance.
- **The boundary is the container, not a sandbox.** The engine user's network is confined by nft rules
  that cover TCP, UDP and IPv6 but not AF_UNIX (kept empty by mounting and sharing nothing), and the
  supervisor is a root process that parses untrusted Git objects and HTTP. See ADR 0003.
- **Supported hosts.** Linux/amd64 glibc images only, on a Docker host whose kernel has `nf_tables`.
  Nothing is tested on arm64, rootless Docker, user-namespace remapping or Podman. Coolify support is
  written down but untested.
- **Capacity beyond one slot is unknown** (see above).
- **Hosted activation needs the egress gate (#82).** It is not permission for unrestricted
  self-hosted agent egress either.

## Not covered

- The firewall of hosted runners (#82) is a separate gate for hosted activation, not a permission
  for unrestricted self-hosted agent egress.
- Running repository code (build, tests) is out of scope (#130 and #82).
- Guarantees about model behaviour: see "Known limitations and residual risks".
