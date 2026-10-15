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
| Project setting `review_kind` (Diff or Dynamic), editable skill, default model `deepseek/deepseek-v4.1-flash` | Shipped (#194, #200) |
| Rollout gate `dynamic_review` (instance setting, default off), admin control | Shipped (#195, #202) |
| Job tag, capability matching, `no_capable_runner`, `dynamic_review_disabled` | Shipped (#195) |
| Sanitised read-only checkout of the pull request head | Shipped (#196) |
| Fixed review core and the editable skill | Shipped (#198) |
| Engine seam: trusted config, hard limits, per-job model proxy, adapter, process-group cleanup | Shipped (#197 part 1, #202 process-group reuse) |
| Summary comment, findings state, reconciliation | Shipped (#199) |
| Real pinned OpenCode fetch, proxy-side audit, hostile-repository proof; launch as the dedicated engine user, static per-user network rules, `NET_ADMIN` dropped after startup | Shipped (#197 parts 2a and 2b, #244) |
| The Dynamic runner image: the `dynamic` target of `runner/Dockerfile` with the pinned OpenCode, a pinned `rg`, `nft` and the engine user (**linux-x64 glibc only**: the pins have no other platform. On another platform such as arm64 the image still builds, without an engine, and its runner serves Diff jobs only (#264); an arm64 engine needs its own pinned digests) | Shipped (#202, #264) |
| Startup self-check that advertises `opencode` only when everything holds, with a stable logged reason otherwise | Shipped (#202) |
| Deployment: `compose.dynamic.yml` (Docker Compose, opt-in override file) and the `runner-dynamic` service of `compose.coolify.yml` (Coolify, built and started with the rest, **untested on a real Coolify**) | Shipped (#202, #264) |
| Provenance audit of the engine binary and `rg` in `make check-licenses` (source commit, licence, the Bun-lock runtime closure of the pinned commit), notices in `NOTICE` and `THIRD_PARTY_LICENSES.md` | Shipped (#202) |
| Worst-case memory and OOM measurements, the decision to run more than one Dynamic job at a time | **Manual step, not done** (needs a real deployment target, see "Capacity") |
| Full path from a signed webhook to the Run: the pull request title, body and previous-review state in the prompt (#251), the review kind proved for every entry point and the model and usage in Runs (#252), and the privileged `e2e-dynamic` journey with the real pinned OpenCode that publishes the summary (#253) | Shipped (#251, #252, #253) |
| Recovery when a run wrote the summary and then ended failed | Shipped (#255, #257): the claim names the heads of earlier unsuccessful runs and says when that list was cut, see "Known limitations" |
| A short failure note in the summary comment when a run fails (not `lease_lost`, not a refused token) | Shipped (#299) |
| Hosted activation | Needs the hosted egress gate (#82) |

## How a Dynamic job reaches an engine

1. A project set to Dynamic Review enqueues a job tagged `review_kind: dynamic`, **only while the
   instance gate is on**. With the gate off the run is created `failed` with
   `dynamic_review_disabled`; it is never reviewed as a Diff. The kind comes from the project's
   stored settings, resolved by the queue inside the enqueue transaction, so it is the same for an
   automatic review, an authorized `/review` and a manual Review now. Nothing a pull request or a
   comment says (title, body, `/review` text) can select or change the kind, model, budget or skill.
   The Run's detail page shows the actual kind, model, tokens, model calls and cost. For Dynamic
   the cost is the `usage.cost` that OpenRouter reports with each answer, i.e. the credits it charged
   the account for that call, and the run sums them. With OpenRouter's bring-your-own-key
   (BYOK) routing, the charge of the upstream provider can differ from `usage.cost` (OpenRouter
   reports it separately); `costUsd` is always the `usage.cost` figure, not the upstream charge. If
   any call has no reported cost, the run's cost is unknown ("Not available") rather than a partial
   sum. It is never computed from a price table or from token counts.
2. A runner claims a Dynamic job only if it advertises `opencode` in the claim. The runner
   advertises it only after its startup self-check proved the dedicated engine user, the read-only
   export and proxy-only egress (`runner/src/code_reviewer_runner/dynamic_review/self_check.py`, see
   "The startup self-check"). A runner that fails it, and every PR-Agent-only runner, serves Diff
   jobs only.
3. A Dynamic job that no capable runner claims waits, without an attempt being counted, and is
   **cancelled with `no_capable_runner`** after `RUNNER_NO_CAPABLE_TIMEOUT_SECONDS` (app setting,
   default 30 minutes). It is visible in Runs; it never waits forever and never falls back to Diff.
4. The runner prepares the export (#196), starts one engine per job behind its own model proxy (the
   workspace key never reaches the engine), enforces the hard limits below and removes the job's
   temporary files and process group. Only after the engine has ended successfully, its findings
   passed validation and the export is released, the supervisor publishes (#199, wired in #253): the
   one persistent summary comment of the pull request, created on the first run and **edited in
   place** by every later run (a person's comment that merely quotes the marker is never edited). It
   writes with the job's own installation token; the engine never sees it. A failed run writes
   nothing, a failed write fails the run with its own stable code, and the Run links the comment.
   Right before the write the process asks the job loop whether the job is still its own (#260): the
   loop beats the heart once and answers from the app (a lost lease and a cancelled job are both
   409; a 5xx, a reset or a timeout is tried again up to three times within 40 seconds, and a 200
   counts only as the contract's heartbeat answer for this job). Anything but a clear yes ends the
   run with `lease_lost` and writes nothing, and so does a Dynamic job that was not handed the
   channel at all.

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
  (`restart: unless-stopped`) and gets `NET_ADMIN` again, so what a restart runs must not be
  changeable by a compromised root supervisor. That is what the read-only root filesystem is for
  (next item, #249).
  If the rules cannot be installed (no `nft`, no `nf_tables`) the capabilities are dropped anyway and
  every Dynamic job fails with `dynamic_isolation_self_check_failed` while Diff jobs keep running.
  The fixed slot ports are checked at startup against the kernel's ephemeral port range
  (`/proc/sys/net/ipv4/ip_local_port_range`); a port inside it, or a range that cannot be read,
  means the rules are not installed and every Dynamic job fails closed. Keep the defaults (10180,
  10181) or other ports below the range.
  Only PID 1 (`tini`) keeps them. Do not run the container with `seccomp=unconfined`.
- **Read-only root filesystem (#249).** `compose.dynamic.yml` runs the container with
  `read_only: true`: nothing in the image can be written, not even by root with `DAC_OVERRIDE`, so
  `nft`, `tini`, the pinned tools and pins, and the runner source stay as built and a restart cannot
  run altered code with `NET_ADMIN`. The only writable paths are three private `tmpfs`, all
  `noexec,nosuid,nodev`, empty again after every restart: `/tmp` (512 MiB, world-writable with the
  sticky bit as before: job working directories, the per-job export, the engine's HOME, XDG and
  TMPDIR), `/run` (1 MiB, root only: the identity leases) and `/home/runner` (64 MiB, owned by the
  Diff job user 10001, mode 0700: its HOME). The engine user (10101) has **no new write path**: `/tmp`
  is what it could write before, `/run` and `/home/runner` are closed to it, and the rest of the
  filesystem is read-only (besides Docker's own `/dev/shm`, as before); the image smoke test checks
  this against the same image without the layout. The three files Docker binds into `/etc`
  (`hosts`, `hostname`, `resolv.conf`) are read-only too under `read_only`, which the image smoke
  test checks. Because a tmpfs is
  charged to the container's memory limit, `/tmp` counts against the 2 GiB (see "Capacity"): a
  repository export is limited to 64 MiB, a preparation to 256 MiB and a download to 256 MiB (#296), but a runaway engine that
  fills `/tmp` takes memory, not disk, and ends in the OOM kill of the job, bounded at 512 MiB. Do
  not add `volumes` or widen the tmpfs; the file test pins them. It is not a way to a read-only
  Diff runner: only `compose.dynamic.yml` and the `runner-dynamic` service of `compose.coolify.yml` use it.
- **Nothing mounted, nothing shared.** Besides those three tmpfs, `compose.dynamic.yml` has no
  `volumes`, `network_mode`, `pid`, `ipc` or Docker socket (a file test fails otherwise); do not add any. The rules do not cover
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
| `pin_unreadable` | A pin file in `/opt/code-reviewer/pins/` is missing (or a directory above it is), malformed or has no entry for this platform (an x64 image started on arm64) |
| `pin_untrusted` | A pin file, or a directory above it up to `/`, is a link, is not owned by root or can be written by group or others |
| `engine_binary_missing`, `ripgrep_missing` | The file (or a directory above it) is absent, the file is a link, or not executable. This is also what an image **built on arm64** reports: the build installs no engine where there is no pin (#264), so the image builds and the runner serves Diff jobs only |
| `engine_binary_untrusted`, `ripgrep_untrusted` | The file, or a directory above it up to `/`, is not owned by root, is a link (directories) or can be written by group or others |
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
command, the verified `rg` (the engine runs exactly that file, first on its `PATH`) and the
operator's `RUNNER_DYNAMIC_CAPABILITIES` (a ceiling for the descriptor the job brings, #279); nothing an operator sets under `RUNNER_OPENCODE_COMMAND`,
`RUNNER_DYNAMIC_RIPGREP` or `RUNNER_ADVERTISED_ENGINES` reaches a job. A Dynamic job that arrives at
a runner without `opencode` in that list is refused with `dynamic_engine_unavailable`.

## The model

Dynamic Review is model- and provider-agnostic. The default model is `deepseek/deepseek-v4.1-flash`,
the id OpenRouter serves (the name is sent to the provider as it is). It is a default, not an
allow-list, and there is no provider routing or fallback. The workspace's existing encrypted BYOK
credential is used (no new key variable, no per-project key).

**The app describes the model for every job (#279).** When a Dynamic job is claimed, the app reads
OpenRouter's public metadata of the job's model (`GET /models/{author}/{slug}/endpoints`, no
credential, the same read the settings save does) and sends the result in `dynamic.capabilities` of
the job: whether a required tool choice and structured output (through tool calling) are supported,
the context window, the output allowance, and the unit prices per million tokens. So **any tool-capable
OpenRouter model runs without the operator describing it**. The values are read at the bound a
reservation needs, over the endpoints that can serve the run (those that list `tools` and
`tool_choice` and do not say they cannot force a tool choice): the smallest window and output limit, the
highest prices. The output allowance is at most 32,768 tokens for a model whose highest output price is
4 USD per million tokens or less (the app's `DYNAMIC_LARGE_OUTPUT_ALLOWANCE_TOKENS`, and the allowance
of the built-in default model), and 8,192 for a dearer or unpriced one; a larger limit of the model is
not an invitation, since the allowance is reserved against the cost limit on every call (about 0.13
USD at the price bound). Why (#309): a review of up to 30 findings plus the reasoning tokens, which
count against `max_tokens`, does not fit 8,192, and a turn cut off there ends without an answer. The
source for the default model: OpenRouter's `/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints`,
read on 2026-10-14, where the model's top provider states `max_completion_tokens` 943718 and the
smallest endpoint limit is 131072, so 32,768 is below every limit; the smallest limit of the endpoints
still wins when it is lower. The descriptor comes from the app, never from the repository, the pull request or the
model, and it only goes to a runner that said it reads it (`features: ["dynamic_capabilities"]` in its
claim; an older runner never receives the field, see `contracts/README.md`).

**Precedence, from the runner's side** (`capabilities_for_job` in `proxy.py`):

| Job descriptor | `RUNNER_DYNAMIC_CAPABILITIES` | Result |
|---|---|---|
| absent | unset or empty | the built-in description, for exactly the default model `deepseek/deepseek-v4.1-flash`; any other model fails with `dynamic_model_features_unsupported` (today's behavior) |
| absent | set | the operator's value, as before |
| present | unset or empty | the job's. A model whose metadata had no unit prices fails with `dynamic_config_invalid` (the default model keeps its built-in prices) |
| present | set | **the intersection: the operator's value is a ceiling.** Both must support the features, the smaller output limit wins, the smaller window wins when the operator names one, the higher unit price wins. The job can narrow what the operator allows and never widen it |

The built-in description is a fallback, never a ceiling. An operator value that is set but unusable
fails the run whatever the job says. The runner fails closed on prices: no unit prices from the job,
the operator or (for the default model only) the built-in description means `dynamic_config_invalid`,
because a cost that cannot be priced cannot be bounded before it is spent. No price is written into the
code beyond the built-in description of the default model.

**When the metadata is read.** At claim time, through a short in-memory cache (five minutes, positive
answers only), not at save time: the settings save also checks the model, but a stored snapshot would
go stale (prices and providers change) and would need a migration. A model whose metadata says it has
no tool calling or no required tool choice ends the job at claim, before any credential is created,
with `dynamic_model_features_unsupported`. **If OpenRouter cannot be asked** (unreachable, an answer
that cannot be used, a model it does not list, no stated or oversized window) nothing is invented: the job is
claimed without `dynamic.capabilities`, the claim log says `model capabilities not read (...)`, and
the runner uses its own description as before, so a provider outage fails only models the operator did
not describe. A claim waits at most five seconds for the metadata.

**Variants.** A `:variant` suffix (`:free`, `:nitro`, ...) is dropped for the metadata lookup, because
OpenRouter lists endpoints per base model. The descriptor of a variant is therefore the base model's:
the prices can only be higher than the variant's real ones (a safe reservation), the window lower, and
a variant that routes to endpoints without tool support is still caught at run time by the required
parameters on every request (#270), which ends the run with `dynamic_model_features_unsupported`.

`RUNNER_DYNAMIC_CAPABILITIES` is therefore optional for every model and is **a ceiling and an
override** for the operator who wants one, in JSON:

```json
{"tool_choice_required": true, "structured_output": true, "max_output_tokens": 32768,
 "context_window_tokens": 1048576, "input_usd_per_mtok": 0.5, "output_usd_per_mtok": 2}
```

`input_usd_per_mtok` and `output_usd_per_mtok` are what a million input and output tokens cost in
USD, used only to reserve the cost of a call before it is sent (see "Hard limits").
`context_window_tokens` is the model's context window (what a request and its output allowance must
fit). **Without a job descriptor the unit costs are required for every model other than the built-in
default**: a descriptor without them (or any descriptor that is set for the default model, since it
replaces the built-in one) ends the job with `dynamic_config_invalid`. The window is optional: without
it the conservative default of 128,000 tokens applies when the operator's value is used alone. A window
that is not a positive integer larger than `max_output_tokens`, or only one of the two unit costs, or an
unusable unit cost, fails the run with `dynamic_model_features_unsupported`. The built-in description
of the default model carries the window that OpenRouter's public model list gives for it (1,048,576
tokens, read on 2026-10-14, `https://openrouter.ai/api/v1/models`) and the unit costs of that list
(`runner/src/code_reviewer_runner/dynamic_review/proxy.py`).

A job whose model has no description at all (no job descriptor, unset variable, another model), a value
that is not JSON, or one that lacks a required feature fails with `dynamic_model_features_unsupported`.
There is no silent fallback to another model or to a Diff review.

## Hard limits

The limits are fixed in the code (`runner/src/code_reviewer_runner/dynamic_review/budget.py`) or are
trusted runner configuration; no project setting or pull request text widens them, and the
wall-clock limit is the minimum of 600 seconds and the runner's job timeout.

**The one budget is money (#290).** A Dynamic run is bounded by an operator cost limit in USD, not by
tokens, model calls, tool calls or files: a tool loop sends its whole history again with every call,
so those counts say little about what a run costs, and a count tight enough to protect an operator
stopped normal reviews of a medium repository. The tokens, calls, tool calls and files are still
counted and shown in the Run; they just stop nothing.

| Limit | Value | Kind |
|---|---|---|
| Cost of one run | 1.00 USD; `RUNNER_DYNAMIC_MAX_COST_USD` sets it (a plain decimal number above 0, up to the ceiling of 20 USD in the code; anything else fails the job with `dynamic_config_invalid`) | budget |
| Wall clock | 600 s (lower when `RUNNER_JOB_TIMEOUT_SECONDS` is lower) | technical: the lease and the runner's capacity depend on it |
| One tool result | 64 KiB | technical |
| All tool results together | 4 MiB | technical |
| Untrusted input to the engine | 2 MiB | technical |
| One model request, one answer, one stream | 4 MiB, 256 KiB, 1 MiB | technical |
| Findings | 30 | output size: the summary comment, GitHub's comment limit and the persisted review state are bounded by it (the project setting is 1 to 30) |

Removed in #290: 30 model calls, 120,000 total tokens, 200 tool calls and 100 distinct files. If one
of the technical limits blocks a normal review of a medium repository, report it with evidence
instead of raising it.

**How the cost is bounded.** Before every call the ledger reserves what the call could cost: the
input estimate and the output allowance at the unit costs of the model's description (a model
without unit costs does not run, see above). The call is refused (`dynamic_budget_exceeded`, before the provider sees it) when
what is spent, what is reserved for calls in flight and this reservation would together pass the
limit. After the call the reservation is replaced by the `usage.cost` the provider reported (the
credits it charged, #286). **A call that reports no cost ends the run with
`dynamic_accounting_failed`**: without it the run cannot be bounded by money, and a missing cost is
never read as zero. A cost of 0 (a free model) is a cost. What can still end above the limit
is the estimate's error: the input estimate can be up to 3 times too low for dense input (base64,
minified code), and a price list that changed after it was read under-prices the reservation; both
are paid for one call at most, and the next call is refused. The output cannot exceed its allowance
(the proxy sets `max_tokens`). A call that failed or was retried keeps its reservation (it may
still have been billed), so many provider retries can use up the limit without spending. With
OpenRouter's bring-your-own-key routing `usage.cost` may exclude the upstream provider's charge.
Repository and pull request input never set any of this.

**The input estimate.** Bytes divided by 3 (real text has about 3 to 4 bytes per token; the old
estimate of one token per byte was 3 to 4 times too high, which refused a request of about 92 KB
against a 100,000-token window), tightened to what the provider settled on the previous call when
that was denser (only from requests of 4 KiB up), and never below the last settled prompt. The
margin: every call also reserves its whole output allowance at the output cost, though most calls
use a small part of it. The provider's reported usage replaces the estimate after the call. It is
accepted up to the proven byte bound (a token is never fewer than one byte); above that it is an
accounting failure (`dynamic_accounting_failed`).

**The window is a backstop.** The window of a run is the model's, from its description
(`context_window_tokens`). The runner refuses a request before it is sent (`dynamic_budget_exceeded`)
only when it cannot fit even at 6 bytes per token, a density no natural text reaches (text has 3
to 4.5), so it never refuses what the provider would accept; that is a choice against the
production symptom, where an estimate that was too high refused a request the provider would have
taken. Every other case is the provider's: its "context length exceeded" answer (read from the
answer's `error.code` and `error.message` only, never from text elsewhere in the body) ends the run
with `llm_context_length_exceeded`. The conservative estimate (bytes over 3) is used for the cost
reservation only. The project's
Diff Review "Token budget" (`llm.maxTokens`) is **ignored** by Dynamic Review: it is another concept
(the size PR-Agent gives a diff), the review kind card hides it for Dynamic, and using it as the
window is what refused real reviews. It is neither a window nor an extra cap.

A run whose limit is hit ends with `dynamic_budget_exceeded` (see "Wrap-up" for the run that is
wrapped up before), a run whose usage or cost cannot be established with `dynamic_accounting_failed`. The previous summary comment is preserved in both
cases. The tool, file and result-byte checks are enforced at the model proxy, before the request is
forwarded (#197 part 2a): a model request whose history exceeds one of them never reaches the
provider.

## Wrap-up: a review at its limit is finished, not thrown away (#293)

A run that is about to reach its cost limit or the end of its wall clock does not just stop. The
model is given one last call in which it can only return its answer, and the review it produces is
published.

- **When.** The ledger decides, per model request, from its own cost and clock (never from the
  content of the request): the request becomes the *final call* when a further normal call could
  not be followed by a final one inside the cost limit (what is spent, what is held for calls in
  flight, this call, and a final call after it whose history may have grown by two tool results,
  128 KiB), or when less wall clock is left than one provider call needs (150 s of the 600 s; a
  quarter of a shorter deadline). The final call must itself fit the cost limit, else the run ends
  with `dynamic_budget_exceeded` as before.
- **What changes in that call.** The model proxy, which is trusted runner code, rewrites the request
  before it is forwarded: every tool except the engine's `StructuredOutput` return tool is removed,
  `tool_choice` is forced to `required` (with one tool this forces that tool; `required` is the
  capability every Dynamic model must have, and `provider.require_parameters` still holds), and a
  runner-written instruction is appended as the last message: *the limit set for this review is used
  up, do not call any more tools, return the complete review now with the findings you have so
  far*. The rest of the request is as the engine sent it. A request that does not offer the return
  tool (a title call, for example) is never rewritten and keeps the plain rule.
- **One final call.** After it is granted every other request is refused with
  `dynamic_budget_exceeded`. If the final call fails, the run ends with the stable code of that
  failure (the provider's or the transport's), and the engine's retry is refused.
- **Result.** The review is validated like any other, published, and its summary starts with a
  neutral notice that the review stopped early because it reached the cost limit set for a review (or
  its time limit) and may be incomplete. The notice is one of two constants and is not part of the
  stored review state, so the next complete run does not carry it. The runner result carries
  `usage.stoppedEarly` (`cost_limit` or `time_limit`; absent for a complete run) and the Run's
  detail page shows "Stopped early".
- **Security.** The instruction is trusted runner text. Repository content can neither trigger the
  wrap-up nor prevent it: the decision is made from the ledger's own state, and a request that sets
  its own `tool_choice` or tools is rewritten all the same. Nothing in the repository can imitate the
  instruction: it is a user-role message appended after all of the history, and the `<runner-wrap-up>`
  tag that wraps it is escaped, like `<system-reminder>`, in tool results, in the pull request text
  and in the prior review state (`tagescape.py`). Compaction is off (below), so the return tool is
  always still registered with the engine when the final call is made; a test pins that assumption.
- **Checked against the pinned OpenCode v1.19.0.** The tool the model calls in the final answer is
  the engine's own `StructuredOutput`, which the engine registers for the whole turn because the
  structured format lives on the turn's user message. Rewriting what the proxy forwards does not
  touch that registry: the engine captures the structured answer and ends the turn as it does after
  any last call (the real binary runs both wrap-up scenarios in `tests/engine`).
- **Reasoning tokens.** OpenRouter's documentation says reasoning tokens count against `max_tokens`
  (the limit "applies to reasoning and visible output combined"), are billed as output tokens, and
  are a subset of `completion_tokens`. The proxy sets `max_tokens` to the output allowance of the
  model's description, so the reservation of every call (priced at the output cost) already covers
  them. A provider that reports more completion tokens than the allowance, reasoning included, ends
  the run with `dynamic_accounting_failed` instead of being paid for it.

### How long a turn may take

The engine's turn is one blocking `POST /session/{id}/message` that returns only when the whole
agentic turn is done, with nothing on the socket meanwhile. Its socket timeout is therefore **the
time left to the whole-job deadline plus a 5 s margin**, never a fixed cap: a cap of 300 s once
ended a normal review turn as `dynamic_engine_unavailable: the engine is not reachable` (a
production run of this repository's own pull request, after about 339 s), before the wrap-up at
deadline minus 150 s could act. The run's own watch (the ledger's deadline, the proxy's recorded
limits, the engine process) ends a turn; the socket never does.

A failed engine call says why at the start of its detail, all with the code
`dynamic_engine_unavailable`: `engine_turn_timeout` (the turn ran into the client timeout before the
deadline, which the margin makes a defect to report), `engine_exited` (the engine process ended
during its turn), `engine_unreachable` (it runs but cannot be reached, e.g. a refused connection),
`engine_timeout` (another call did not answer in time). A failure at the deadline is
`dynamic_budget_exceeded`. The result log names how long each engine message call took
(`engine message call: 339.2 s`, numbers only), after a success and after a failure.

`prompt_async` (an immediate `204`, present in v1.19.0) was considered and not used: the result of
the turn would have to be read back through the session's message list, which answers HTTP 400 once
a JSON-schema format is stored (the defect of #85, pinned by an engine test), or through the
`/event` stream, which needs an event reader of its own. That is a follow-up if turns ever need to
outlive one connection.

## Recovery: a turn that ends without an answer gets one more chance (#309)

The pinned OpenCode ends a turn, and fails it with "Model did not produce structured output", as
soon as a model step finishes with any reason but `tool-calls` while no `StructuredOutput` call was
captured (`session/prompt.ts` of v1.19.0). That happens when the model answers in prose although
the tool choice is `required`, when its output is cut off at the allowance (`length`, mid tool call),
and when a provider says `stop` for a step that asked for tools. A production run died this way after
a 257 s turn with `llm_output_invalid: the engine returned no structured answer`, far from the cost
limit and the clock, so the wrap-up above never acted. The engine config has no step limit
(`agent.steps` is unset, so the engine's own maximum is infinite), and `tool_choice: required` is
sent on every request and forwarded by the proxy (both checked against the real binary).

- **Tool steps are tool steps.** The proxy reports a step with tool calls to the engine as
  `tool_calls` even if the provider called it `stop`, so that case no longer ends the turn.
- **One recovery.** When a turn ends without a structured answer, the adapter asks the ledger
  (`begin_recovery`). The ledger says yes only if no final call was granted yet, a model call was
  made, more than the wrap-up's clock reserve is left (150 s of 600 s, a quarter of a shorter
  deadline: the recovery call writes a whole review) and the estimate of one more call (the last
  prompt, one output allowance for the model's last answer, a 4 KiB slack) fits the cost limit. Only
  the engine's own missing-answer error (`StructuredOutputError`, or a turn that ended with no error
  at all) is recovered; another error of the engine (`APIError`, an abort, a content filter, ...) is
  its own failure and ends the run as before, with the error name in the detail. The adapter then sends a second message to the same session with the runner's fixed
  prompt (`Return the complete review now.`, no tag) and the same structured format. The first model
  call of that turn is granted as the run's final call: reserved like any call, rewritten by the
  proxy exactly like the wrap-up call (return tool alone, `tool_choice: required`, the instruction
  last), and after it every other request is refused. The instruction says that the previous turn
  ended without the review and that its last answer is not shown, and asks for the review based on
  what the model examined, concise (at most 10 findings, short descriptions), so a cut-off at the
  output allowance is less likely to repeat. The pinned engine does not replay the message that
  ended the turn (a prose answer, a cut-off return call): the history of the recovery call holds the
  task and the tool steps with their results, but not that answer (checked against the real binary,
  #312). Left like that, the model had to write the whole review again from the raw tool results,
  which is what the first recovery in production did not manage in 16 s. The adapter therefore
  hands the dropped text back: the visible text parts of the message that ended the turn (never the
  reasoning) become one `previous-answer` block of the recovery message, escaped like a tool result
  (it cannot pose as the runner's instruction), fenced like any untrusted block and cut at 48 KiB
  without splitting a character. The recovery is then a transcription, not a second review. The
  instruction uses the `<runner-wrap-up>` tag, so every escape that protects the wrap-up
  instruction covers it, and it says the message before it may quote the answer.
- **No second recovery turn.** A run has at most one final call: the recovery or the wrap-up, not
  both. If the recovery also yields nothing the run fails with `llm_output_invalid` as before; if the
  wrap-up's final call came back without the answer there is no recovery either.
- **The final call is enforced in the proxy, not hoped for (#312).** The pinned engine accepts
  whatever JSON the return tool is called with and ends the turn on any other reply, and the
  provider may ignore a forced tool choice (a prose or empty reply is `finish=stop` with no tool
  call). The proxy, which is trusted runner code, therefore checks the reply of every final call
  before the engine sees it:
  - a reply with no tool call whose whole text (or a ```json fence of it) is one JSON object with a
    `findings` key becomes the `StructuredOutput` tool call it should have been;
  - a reply is the answer when it calls `StructuredOutput` with arguments that parse as JSON and that
    the runner's own parser (`dynamic_findings`) accepts;
  - otherwise the proxy asks again, with the same final request, the model's reply as an assistant
    message (text only, escaped) and a `<runner-wrap-up>` message naming the concrete problem (`the
    reply did not call the StructuredOutput tool`, `the arguments ... are not valid JSON (Expecting
    ',' delimiter at position 120)`, `the review is not valid: priority must be one of P0, P1, P2,
    P3`; field names and parser positions, never a value);
  - at most `FINAL_ATTEMPTS` (3) requests per final call, each reserved and settled like any model
    call, and only while the clock and the cost limit have room (`try_reserve_final_retry`); no room
    means the last reply is what the engine gets;
  - what the engine gets is the last reply, valid or not. A reply that stays unfit is the model's
    failure, with the runner's validation naming the field (`dynamic_policy_violation`) or the
    missing answer (`llm_output_invalid`) as before. Normal calls are never checked or retried.
- **F3 of #301.** A final call (wrap-up or recovery) that answered without the return tool makes
  every later request fail with `llm_output_invalid`, not `dynamic_budget_exceeded`.
- **What is recorded.** A recovered review is complete as far as the model is concerned, so it is
  published without a notice and `usage.stoppedEarly` stays empty. The result log says
  `recovered after a turn without an answer (finish=stop, error=StructuredOutputError)` and names the
  duration of both message calls (`engine message call: 257.3 s, 12.1 s`). A failure says
  `the engine returned no structured answer (after one recovery; the first turn: finish=length)` or
  `(the first turn: ...; no recovery was possible)` or `(the first turn: ...; the engine's own
  error, not recovered)`. A failure of the recovery call itself (the provider refused it, the final
  call answered with a stray tool call, the deadline) keeps its own code and ends with
  `(during the recovery; the first turn: finish=..., error=...)`. The note holds only a finish reason and an error
  name that are plain identifiers; engine text is never copied.
- **What a failure says about itself (#312).** The engine reports a prose answer, an empty step and a
  broken tool call alike as `finish=stop, error=StructuredOutputError`. The failure detail (and so the
  Runs view) therefore also names, for the first turn and the recovery: the engine's own sentence for
  that error (`Model did not produce structured output`, copied only for that error and only while
  it is plain short words), the size of the visible text and of the reasoning of the last step, and
  the tools it called. And it ends with `last model calls: ...`, the last three provider answers as
  the proxy saw them: finish reason (and the provider's native one), the tools called (the return
  tool marked `(args not json)` when its arguments do not parse), the sizes of the text and of the
  reasoning, the output tokens, and `final call` for the wrap-up or recovery call. Sizes and plain
  identifiers only; no diff, no model text, no tool argument.
- **A review with one bad finding is still a review (#312).** The pinned engine does not validate the
  return tool's arguments against the schema (it only parses JSON), so the runner is where a
  malformed finding is found. A finding that is invalid next to at least one valid one (a swapped line
  range, a confidence of 85, an unknown field, an unsafe path, another head) is dropped and counted,
  and the log says `dropped N finding(s): finding_invalid (<field problems>)`; a finding that points
  outside the export is dropped as before. Fail closed: when there are findings and none is valid, or
  the envelope itself is invalid (`schemaVersion`, `reviewedSha`, `resolvedIds`, the finding bound),
  the run fails with the first problem as before, because nothing in such an answer can stand for
  "no findings".
- **Not covered (#301 F4).** The final call's history names tools that the call no longer offers. The
  pinned engine and the fakes accept that; if a provider behind OpenRouter rejects it (400, shown as
  `llm_bad_request`), the fallback is to keep the original tool definitions in that call and rely on
  `tool_choice`.

## Context window and compaction

OpenCode can compact a long session itself (`compaction.auto`, with the model's `limit.context` and
`limit.output` in the provider config, and `compaction.prune`). Both stay **off** (decision of #290,
re-check with every engine pin), because of a defect found against the real pinned v1.19.0 binary:

- After an automatic compaction the engine's next requests to the model no longer offer the
  `StructuredOutput` tool and no longer force a tool choice (`tool_choice` is `auto`). The
  structured-output format lives on the user message that started the turn; compaction replaces that
  message with a summary and a synthetic "continue" message that carries no format
  (`session/prompt.ts` and `session/compaction.ts` at the pinned commit). The model then answers in
  prose and the run ends without a typed answer (`dynamic_policy_violation: the findings are not
  valid JSON`). A run cannot finish after a compaction.
- The same lost format would defeat any later "answer now" step.
- What the model sees after a compaction also changes in trust: the review task (the pull request
  title, body and the diff, which are untrusted input) is replaced by a summary the model wrote, in
  an assistant-role message. Text from the repository can be carried into that summary and then reads
  like the model's own earlier words. The engine's permissions, the read-only tool set, the proxy's
  audits and the typed findings validation do not depend on that text, so this cannot widen what
  the engine can do, but it can make injected text more persuasive. The trusted system prompt (the
  fixed core and the skill) is the agent's own prompt and is sent again with every request, also
  after a compaction; the compaction request itself goes through the proxy like any other call, so it
  is counted and priced.

A compaction therefore needs either the engine to keep the format (an upstream fix) or a way for the
runner to keep it that is not a workaround of the proxy's rules; that is a follow-up. Until then the
run is bounded by the cost limit and the model's window.

## A failed run leaves a short note on the pull request (#299)

A run that fails used to leave the pull request silent: the reason was only in the Runs view. Now a
failure that a developer can understand or act on writes one short note into the run's own summary
comment (the comment of the publisher, the one a successful review is in), so there is never a
second comment.

**What the note says.** That the Dynamic Review did not complete for a named commit, one fixed
sentence for the failure, the stable error code and, where the run has one, the stable reason (for
example `checkout_incomplete` / `budget_preparation`). The sentences are a table in the code
(`FAILURE_SENTENCES` in `runner/src/code_reviewer_runner/dynamic_review/failure_note.py`): the code
is translated to words, never the other way round, like the Runs view.

**What it never holds.** Only the fixed text, the code, the reason and the head SHA. No path, file
name, diff text, log line, model output, provider message or secret: none of them is an input of the
note. A reason that is not a known stable name is left out (the code stays), and the diagnostic
detail the Runs view shows for a failure (the log, the checkout counters) is not in the note.

**Which failures.** The codes with a sentence: `checkout_incomplete`, `dynamic_budget_exceeded`,
`dynamic_model_features_unsupported`, the model provider failures (`llm_auth`, `llm_rate_limit`,
`llm_timeout`, `llm_unavailable`, `llm_bad_request`, `llm_quota`, `llm_context_length_exceeded`,
`llm_output_invalid`, `model_unknown`) and `timeout`. Everything else writes nothing and stays visible
in the Runs view only: `lease_lost`, `git_auth`, `git_forbidden` (the runner cannot write safely),
and the failures of the job's own setup or of the runner. A unit test classifies every `ErrorCode`
as one or the other, so a new code cannot be added without that decision. A job that is no longer
held by its runner writes no note either, as it writes no review.

**Update, do not spam.** The note lives in the same persistent summary comment:

- the same failure on the same head, or a different failure, replaces the note: there is one note;
- a later successful run replaces it with the review;
- a failure after an earlier successful review keeps that review's findings, resolved history and
  review state exactly as they are and shows the note on top of them (the failed head is not recorded
  as reviewed), also when that review found nothing; a pull request that was never reviewed shows the
  note alone, not "0 active findings" (a hidden mark in the comment says so, because its state looks
  like that of a clean review);
- the state of the comment is validated as for a review: a comment that is not the bot's is never
  edited, and a failure whose head the comment cannot account for (a newer review is there) writes
  nothing. A state that a review would reset is not dropped for a note;
- the first failure creates the comment with a review state that holds no findings and the failed
  head, a head the app reports as attempted (#255), so the next run, of any runner version, reads it
  like any other summary.

**Fail closed.** If writing the note fails (GitHub unreachable, a permission, anything), the run keeps
its original error code and reason; the note never changes the verdict. The result log says
`failure note: written` or `failure note: not written (<code>)`, a stable code and never the text of
the failure.

**Not covered.** The process watchdog that ends a job whose runner did not stop in time writes no
note: it cannot write safely while the job is being killed. That failure is in the Runs view.

## Errors an operator sees

| Code | Meaning | What to check |
|---|---|---|
| `dynamic_review_disabled` | The instance gate is off | Turn the gate on (below) when the rollout is ready |
| `no_capable_runner` | No runner advertised `opencode` within the timeout | Is a Dynamic runner running, and did its self-check pass? (`docker compose logs runner-dynamic`) |
| `dynamic_engine_unavailable` | The runner got a Dynamic job but has no engine | The job should only reach a capable runner; report it |
| `dynamic_isolation_self_check_failed` | The startup self-check did not prove user, export and network | The runner logs the failed property, never a value |
| `dynamic_model_features_unsupported` | The model's metadata (or the operator's description) says it lacks tool choice or structured output, or no provider supports the parameters | The model (OpenRouter's page lists the supported parameters); `RUNNER_DYNAMIC_CAPABILITIES` if you set one, since it is a ceiling |
| `lease_lost` | Right before the summary would have been written the job was no longer held by this runner (lease lost, job cancelled), or the app could not be asked; nothing was written | Normal after a requeue or a cancel. Often: the app was unreachable at that moment; the next push reviews again |
| `dynamic_config_invalid` | Model, skill or limits of the job are unusable; or no description of the model has unit costs (the provider's metadata stated none and the operator named none); or `RUNNER_DYNAMIC_MAX_COST_USD` is not a number up to the ceiling | The project's settings page; `RUNNER_DYNAMIC_CAPABILITIES` (`input_usd_per_mtok`, `output_usd_per_mtok`) |
| `dynamic_budget_exceeded`, `dynamic_accounting_failed`, `dynamic_policy_violation` | A hard limit or rule stopped the run. Accounting also fails when a call reports no cost | The Runs page; `RUNNER_DYNAMIC_MAX_COST_USD` |
| `llm_output_invalid` | The engine finished without a structured answer, and so did its one recovery (or none was possible); the detail says how the first turn and the recovery ended (the engine's `finish=stop` covers prose, silence and a broken tool call alike; `last model calls: ...` tells which; `finish=length`: cut off at the output allowance) | The model (does it follow a required tool choice?), the output allowance in `RUNNER_DYNAMIC_CAPABILITIES` |
| `llm_context_length_exceeded` | The provider said the request is larger than the model's context | The model's context window (its metadata, or `context_window_tokens` in `RUNNER_DYNAMIC_CAPABILITIES`); a smaller pull request |

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
| `RUNNER_DYNAMIC_MAX_COST_USD` | empty | The most one run may cost, in USD; empty is 1.00; up to 20 (see "Hard limits") |
| `RUNNER_DYNAMIC_CAPABILITIES` | empty | Optional ceiling and override of the model description (see "The model"). Empty: the description the app sends with the job applies, or, without one, the one built into the runner for the default model only |

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

**Deploy order.** `base.attemptedShas` (#255) is only sent when it is not empty and
`base.attemptedShasTruncated` (#257) only when it is true; a runner from before the respective issue
rejects the key (its job contract is closed). Update the app and the Dynamic runner image together, or
the runner first. A newer runner with an older app is safe: an absent key means none and false.

**Before you start.** A Linux Docker host (Docker Engine with Compose v2) whose kernel has
`nf_tables` (every current distribution kernel; the self-check tells you when it does not), that can
give the Dynamic runner container at least 2 GiB; an app that is already running with the workspace's
LLM key entered (Settings, LLM access; Dynamic Review reuses it, there is no other key); and, for the
model you choose, the knowledge of what it supports (tool choice "required" and structured output).

1. **Upgrade every app instance** to the version that routes by `review_kind`
   (`contracts/README.md`, "Rolling out Dynamic Review"). A previous-release app on the same database
   could hand a Dynamic row to a runner as an untagged Diff job. Do not continue until all instances
   are upgraded.
2. **Describe the model** only if you want to narrow what the app reads from the provider's metadata
   ("The model"): `RUNNER_DYNAMIC_CAPABILITIES={"tool_choice_required": true, "structured_output": true,
   "max_output_tokens": 32768, "input_usd_per_mtok": 0.5, "output_usd_per_mtok": 2}` is a ceiling for every
   Dynamic job of this runner. Nothing is needed for the default model or for any tool-capable OpenRouter
   model whose metadata states its window and prices. Review the memory settings of the table above.
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

**Coolify.** The `runner-dynamic` service is part of `compose.coolify.yml` (#264): the existing
Coolify resource builds and starts it with the app and the Diff runner after the next release, and a
file test keeps it equal to the service of `compose.dynamic.yml`. It does nothing until the gate is
turned on (it also takes Diff jobs, see "Capacity"), and the runner has the capability descriptor of the default model built in. Read the section
"Dynamic Review runner" of `docs/deployment-coolify.md` first. It has **not been tested on a real
Coolify instance**.

## Capacity: slots, memory and what is not measured

The Dynamic runner is also a Diff runner: it keeps `pr-agent` among its engines (as every runner
does), so the app hands it Diff jobs as well. Its one slot is shared: a Diff job (up to
`RUNNER_JOB_TIMEOUT_SECONDS`, 20 minutes by default) can occupy it once the gate is on, and a Dynamic
run then waits for it. Dynamic jobs wait for the gate and for an advertising runner; Diff jobs are
shared by both runners, and the total Diff capacity is the Diff runner's slots plus this one.

The shipped defaults are **one Dynamic slot** (`RUNNER_DYNAMIC_CONCURRENCY=1`) and a **2 GiB limit with
1.5 GiB reserved and no swap**: at least 1 GiB per slot plus the runner and proxy reserve. That is the
spike's conservative proposal, not a measurement. The spike's stock trace (11 model calls, 5.8 s,
596.57 MiB peak RSS of the engine process with fake model answers) is **not** a capacity figure: it
excludes the export's page cache, the proxy, the runner and helper processes, and it used a tiny
repository. Do not raise the concurrency, and do not lower the limit below 1 GiB per slot plus the
reserve, until the following has been measured on your deployment target. The read-only root
filesystem (#249) puts the job working directories in a 512 MiB `tmpfs` (`/tmp`), which is charged
to this limit like any other memory: it is part of the figure to measure, not extra.

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

- **A run that wrote the summary and then ended without success (#255).** The publisher refuses a
  comment whose recorded head it cannot account for, with `review_not_published` (fail-closed on
  purpose, #199). A run can edit the comment and then fail (the watchdog or `SIGTERM` fires after the
  write, the lease is lost, the completion report is lost): the comment says head A while the app has
  no succeeded review of A. The claim therefore carries `base.attemptedShas`: the heads of the
  pull request's earlier jobs of the same kind that *ran* and did not succeed (`failed`, or at least
  one lost attempt; a job superseded or cancelled while still waiting never ran and is not counted),
  created after the last succeeded job and before the claimed one (newest first, at most 20, the key
  is left out when there are none). The publisher accepts such a head next to the job's own head and
  `previousReviewedSha`, reconciles from that state and edits the same comment; the next success
  makes it the previous review again. A head the app never attempted (foreign, tampered, newer) is
  still refused.
- **The attempted-heads list is bounded, so a truncated claim recovers with a full review (#257).**
  After more than 20 distinct heads that ran and failed *without* a success in between, an older head
  of the summary comment can fall out of the list. The app then also sends `base.attemptedShasTruncated:
  true` (left out otherwise), and a state head the job cannot account for on the **bot-owned** summary
  (author and exact identity marker, and a valid state) no longer ends in `review_not_published`: the
  run is a full review (the checkout is full whatever `comparison` the claim declares), the old state
  is dropped (nothing of it is carried over as active or resolved, nothing is resolved by inference)
  and the same comment is rewritten. The history of resolved findings restarts **and the active
  findings are re-derived from scratch too**: a finding of the earlier summary is only on the pull
  request again if this run finds it. The rewritten summary says so in a one-shot notice ("Full
  review after a state reset: ..."), its footer no longer claims the previous state is kept, and the
  result log of the run carries `state_reset_attempted_shas_truncated` (visible in Runs). The notice
  is not part of the state, so the next normal run renders without it. A comment that is not the bot's, a corrupt state and a claim that was not
  truncated stay fail-closed. Residual risk: on a truncated claim a late result of an older run can no
  longer be told from a lost head and may overwrite a newer review; the next push reviews again.
  Since #260 the run asks for its lease right before it writes (see "How a Dynamic job reaches an
  engine"), so only a run that loses the lease *after* that check and before its write lands (a few
  requests of GitHub) can still overwrite; the check is not a lock and the write is not fenced by the
  app. The check also makes a run on a plain (not truncated) claim publish nothing as a zombie.
  A lost edit response is recognised by re-reading the comment (it must hold exactly the body sent).
- **Hidden Unicode tag characters in repository files reach the model untouched (#247).** An attacker
  who controls repository text can hide instructions in tag characters.
- **A restarted container runs with `NET_ADMIN` again, by design (#249).** The capability is dropped
  per container lifetime. Because the root filesystem is read-only, a compromised root supervisor
  that crashes the container cannot have changed `nft`, `tini` or the runner source for the restart;
  what it can still do is bounded by the three tmpfs, which are empty after the restart. PID 1
  (`tini`) still holds the two capabilities, and the supervisor's startup is the same code as before.
- **The byte-to-token estimate of the token cap is uncalibrated (#235).** The cap is preventive and
  conservative, but its calibration against real tokenizers is open.
- **Nested `AGENTS.md` and similar files** in the repository can influence the model. The core marks
  repository content as untrusted data and the engine has no write, execute or general-network
  capability, but there is no guarantee of model resistance.
- **The boundary is the container, not a sandbox.** The engine user's network is confined by nft rules
  that cover TCP, UDP and IPv6 but not AF_UNIX (kept empty by mounting and sharing nothing), and the
  supervisor is a root process that parses untrusted Git objects and HTTP. See ADR 0003.
- **Supported hosts.** Linux/amd64 (x86_64) glibc images only, on a Docker host whose kernel has
  `nf_tables`. **Dynamic Review needs x86_64.** On an arm64 host the stack still builds and deploys,
  but the Dynamic image has no engine (the build skips the unpinned download, #264), the runner reports
  `engine_binary_missing` and serves Diff jobs only: Dynamic stays unavailable. Nothing is tested on
  rootless Docker, user-namespace remapping or Podman. Coolify support is written down but untested.
- **Capacity beyond one slot is unknown** (see above).
- **Hosted activation needs the egress gate (#82).** It is not permission for unrestricted
  self-hosted agent egress either.

## Not covered

- The firewall of hosted runners (#82) is a separate gate for hosted activation, not a permission
  for unrestricted self-hosted agent egress.
- Running repository code (build, tests) is out of scope (#130 and #82).
- Guarantees about model behaviour: see "Known limitations and residual risks".
