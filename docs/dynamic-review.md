# Dynamic Review: operating it

Dynamic Review is the second review kind next to Diff Review (PR-Agent): an agent reads the pull
request's code in a sanitised, read-only export and returns structured findings that the runner
publishes as one persistent summary comment. The decisions are in epic
[#193](https://github.com/ExpidetGames/code-reviewer/issues/193), the research in
`docs/spike/85-opencode-dynamic-review.md`, and the short deployment record is
[`docs/decisions/0002-dynamic-review-deployment.md`](decisions/0002-dynamic-review-deployment.md).

> **Status: not yet activatable.** The pieces below the line "What exists" ship and are tested, but
> the engine itself (the pinned stock OpenCode binary) is not in the runner image and the runner's
> isolation self-check is still fail-closed. No runner advertises `opencode`, so a Dynamic job never
> runs. Everything on this page about turning it on describes the order to follow once the rest of
> #197/#202 has shipped; the rollout gate and the deployment file can be prepared now.

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
| Opt-in deployment file for a separate Dynamic runner (`compose.dynamic.yml`) | Shipped (#202), cannot claim yet |
| Pinned OpenCode fetch (checksum-verified), real-engine fixes, proxy-side audit, hostile-repository proof | Shipped (#197 part 2a) |
| Launch as the dedicated engine user from the root supervisor, per-user network rules, lease loss and cleanup, proofs as root in CI | Shipped (#197 part 2b) |
| Pinned OpenCode binary (**linux-x64 glibc only**: `runner/opencode-pin.json` has no other platform, and the fetch script refuses one; an arm64 image needs its own pinned digest), `nft`, a trusted `rg` (CI installs it from apt, unpinned until the provenance audit of #202) and the engine user in the runner image, offline startup self-check that advertises `opencode` | **Not shipped** (rest of #202) |
| Binary and Bun lock provenance audit in `make check-licenses` | **Not shipped** |
| Worst-case memory and OOM measurements, the decision to run more than one Dynamic job at a time | **Not shipped** |
| Hosted activation | Needs the hosted egress gate (#82) |

## How a Dynamic job reaches an engine

1. A project set to Dynamic Review enqueues a job tagged `review_kind: dynamic`, **only while the
   instance gate is on**. With the gate off the run is created `failed` with
   `dynamic_review_disabled`; it is never reviewed as a Diff. The kind comes from the project's
   stored settings, resolved by the queue inside the enqueue transaction, so it is the same for an
   automatic review, an authorized `/review` and a manual Review now. Nothing a pull request or a
   comment says (title, body, `/review` text) can select or change the kind, model, budget or skill.
   The Run's detail page shows the actual kind, model, tokens, model calls and cost (unknown for
   Dynamic, which never guesses a price).
2. A runner claims a Dynamic job only if it advertises `opencode` in the claim. The runner
   advertises it only after its startup self-check proved the dedicated engine user, the read-only
   export and proxy-only egress (`runner/src/code_reviewer_runner/capabilities.py`). Today the
   check always fails closed.
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
Diff runner of `compose.yml`:

```sh
docker compose -f compose.yml -f compose.dynamic.yml up -d --wait
```

| Setting | Default | Why |
|---|---|---|
| `RUNNER_DYNAMIC_CONCURRENCY` | 1 | One Dynamic job at a time until the memory matrix below exists |
| `RUNNER_DYNAMIC_MEMORY_LIMIT` | `2g` | At least 1 GiB per Dynamic slot plus the runner and proxy reserve (the spike's unvalidated, conservative proposal) |
| `RUNNER_DYNAMIC_MEMORY_RESERVATION` | `1536m` | The soft reservation under the limit |
| `RUNNER_DYNAMIC_IMAGE` | the runner image | The Dynamic image will carry the engine; today there is none |
| `RUNNER_DYNAMIC_CAPABILITIES` | empty | The model description above |

The container runs the supervisor as root with only the capabilities of "The engine boundary", sets
`no-new-privileges`, bounds its process count (512) and has no swap, so a memory peak shows up as an OOM kill of the job rather than as a slow host. It
publishes no port and reaches only the app. The same service block should work for Coolify (copy it
into the Compose application; untested, see `deployment-coolify.md`, "What is verified"); a
`compose.coolify.yml` variant follows with the real image.

With one slot (`RUNNER_DYNAMIC_CONCURRENCY=1`) a long Diff job can occupy the Dynamic runner's only
slot, because that runner also serves Diff jobs. A Dynamic job can then end with `no_capable_runner`
although a capable runner exists. Do not raise the concurrency before the memory matrix exists; a later
change can keep Diff jobs off this runner.

This file does **not** make Dynamic Review work: with today's image (no engine binary, no `nft`, no
engine user) the runner starts, fails its self-check and keeps serving Diff jobs only. Do not set `RUNNER_OPENCODE_COMMAND` by
hand to get around that.

## Activation order (once the engine ships)

1. Deploy **every app instance** with the version that routes by `review_kind`
   (`contracts/README.md`, "Rolling out Dynamic Review"). A previous-release app on the same
   database could hand a Dynamic row to a runner as an untagged Diff job.
2. Roll out the Dynamic runner image and the runner (`compose.dynamic.yml`) and check in its log
   that the self-check passed and `opencode` is advertised.
3. As instance admin open **Admin, Setup, Instance, Dynamic Review**, tick *Allow Dynamic Review on
   this instance*, confirm that step 1 is done and save. The control is server side and admin only;
   it uses the instance settings setter (lock, then cancellation), never raw SQL.
4. Set a project's review kind to Dynamic on its settings page.

Rollback (the full procedure and its reasons are in `contracts/README.md`): switch the gate off
first. That stops new Dynamic jobs and cancels the waiting ones with `dynamic_review_disabled`;
**running jobs finish** on their leases. Before any downgrade of the app, quiesce the runners, check
that no Dynamic engine process is left and that no Dynamic job is `queued` or `running`.

## Capacity: what is measured and what is not

The spike's stock trace (11 model calls, 5.8 s, 596.57 MiB peak RSS of the engine process with fake
model answers) is **not** a capacity figure: it excludes the export's page cache, the proxy, the
runner and helper processes, and it used a tiny repository. Before the Dynamic concurrency is raised
above one, the following has to be measured in the Dynamic image on a documented deployment target,
reading the container's cgroup peak (`memory.peak`), not process RSS:

- a worst-case job at the full export size and the full tool-result envelope;
- an injected OOM kill and an injected engine kill: the previous comment is preserved and no
  process or job temp directory survives;
- the recommended concurrency per GiB, written into this page.

No prices, quality or latency claim is made here; the offline benchmark plan is in the spike
write-up and needs a separately authorised run.

## Not covered

- The firewall of hosted runners (#82) is a separate gate for hosted activation, not a permission
  for unrestricted self-hosted agent egress.
- Running repository code (build, tests) is out of scope (#130 and #82).
- A nested `AGENTS.md` or similar file in the repository can still influence the model. The core
  marks repository content as untrusted data and the engine has no write, execute or general
  network capability, but there is no guarantee of model resistance.
