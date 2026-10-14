# 0003: The engine boundary of Dynamic Review

- **Status:** Accepted
- **Date:** 2026-10-13
- **Deciders:** decided by the project (lead decisions of 2026-10-12 on epic #193); the mechanism
  is the answer to the open question of [0002](0002-dynamic-review-deployment.md), section 5
- **Implemented by:** issue #197 (part 2b), with #202; decision 5 amended by issue #244
- **Amends:** [0002](0002-dynamic-review-deployment.md), decision 2 ("no capability"): the Dynamic
  runner now holds the short list of section 2 below; the rest of 0002 stands

## 1. Context

The lead decisions fix the boundary as "the runner container plus a dedicated unprivileged OS user for
the OpenCode process, a read-only per-job export, no credentials in the agent's reach, network only to
the runner-owned model proxy", without bubblewrap, user namespaces or host-specific kernel settings.
Three mechanisms had to be chosen: how the engine gets its user, how its network is confined, and what
the container is allowed to hold for that.

## 2. Decision

1. **A root supervisor with `setuid()`.** The Dynamic job process runs as root in the Dynamic runner
   container and starts the engine with `Popen(user=, group=, extra_groups=[])`. No `sudo`, no setuid
   helper: `no-new-privileges` stays on and the engine user can never regain a capability. The runner
   loop is root too, and drops every Diff job to uid 10001 (`RUNNER_DIFF_JOB_USER`), so PR-Agent is not
   run as root.
2. **A short capability list instead of `cap_drop: ALL` alone:** `SETUID`, `SETGID` (launch), `KILL`
   (end the engine's group and leftovers), `CHOWN` (seal the export), `DAC_OVERRIDE` and `FOWNER`
   (remove the sealed export and what the engine user created). These are held for the life of the
   container. Two more, `NET_ADMIN` (the rules below) and `SETPCAP` (what allows dropping a capability
   from the bounding set), are held **during startup only** (decision 5). The privileged test suite
   runs with exactly the created-with set in its startup phase and the job set in its job phase, and a
   test keeps both equal to `compose.dynamic.yml`.
3. **Static per-user nftables rules, proven before every engine starts.** With one Dynamic slot the
   engine user and its two loopback ports are fixed (`RUNNER_DYNAMIC_PROXY_PORT`, default 10180, and
   `RUNNER_DYNAMIC_ENGINE_PORT`, default 10181, both below the ephemeral range). The runner installs
   output rules for the engine user's uid once, when the container starts: new connections only to the
   proxy port and the engine's own server port on `127.0.0.1`, everything else rejected. Nothing is
   installed or removed per job. The probe that proves them runs as the engine user before every
   engine; without `NET_ADMIN` not even the supervisor can list the ruleset, so the probe is the
   verification. The rules, not a namespace, are the boundary against other jobs' loopback services
   and any external host. Nothing is accepted by connection state alone: the only rule on tracked flows accepts the
   replies of the engine's own server port (`tcp sport <engine port>`). A broader
   `ct state established` rule would let the engine user send on a flow another process opened and
   closed (the supervisor's DNS lookup keeps a tracked UDP flow for a while, and the same source port
   is free again), which is an exfiltration channel; the review of #239 found it.
4. **The dedicated user is the unit of cleanup.** After the group kill, a `kill(-1, SIGKILL)` run as
   the engine user ends whatever that user still runs. The same sweep runs as the first step of every
   job, right after the lease on the user is taken and before anything of the job exists (what a killed
   predecessor left must not read the new export or config), and in the job loop (root, with `KILL`)
   after every Dynamic job process has ended, however it ended. A sweep that cannot finish is never
   ignored: the nft table then stays (no process of that user is left unconfined), and the next job
   refuses to start (`dynamic_isolation_self_check_failed`).
5. **`NET_ADMIN` only during startup (#244, amending the first version of this decision, which kept it
   for the life of the container).** A root supervisor with `NET_ADMIN` has the nf_tables, tc and xfrm
   kernel attack surface that is otherwise only reachable through unprivileged user namespaces; a bug
   in the supervisor's Git or HTTP handling would reach it. The container is created with `NET_ADMIN`
   and `SETPCAP` (`cap_add`: the capabilities of a container are fixed when it starts), and the
   runner's entry point, before its event loop and before any other thread exists, installs the static
   rules (decision 3) and then drops both capabilities from the bounding set (`prctl(PR_CAPBSET_DROP)`)
   and from its own permitted, effective and inheritable sets (`capset`), reading `/proc/self/status`
   back to confirm. Every process the loop starts afterwards (job processes, the engine) inherits the
   smaller bounding set, so none of them, root included, can touch the rules. Each Dynamic job checks
   that its own process holds neither capability, then runs the probe. Failure behaviour: a drop that
   cannot be confirmed stops the runner from starting; rules that cannot be installed (no `nft`, no
   `nf_tables`) still end with the drop, and every Dynamic job then fails its probe with
   `dynamic_isolation_self_check_failed` while Diff jobs keep being served. The only process that
   keeps the two capabilities is PID 1 (`tini`), which runs nothing of a job and cannot be reached
   by the engine user. The alternatives are worse (a per-job network namespace needs `SYS_ADMIN`; a
   user namespace or slirp is excluded by the lead decisions; a separate container cannot tell the
   supervisor from the engine).
6. **Nothing is mounted and nothing is shared (AF_UNIX).** The rules cover TCP, UDP and IPv6 of the
   engine user, not unix sockets. A unix socket cannot leave the container, and nothing in the
   container listens on one today. To keep that gap empty, `compose.dynamic.yml` has no `volumes`,
   `network_mode`, `pid`, `ipc` or Docker socket (a file test fails otherwise), and the privileged
   suite reads `/proc/net/unix` as the engine user while an engine runs, asserting that no listener
   other than its own exists and that no Docker socket is present.

## 3. Alternatives considered

- **A network namespace per job.** Needs `SYS_ADMIN` (or a user namespace, which the lead decisions
  exclude) and a way to reach the proxy across the namespace.
- **Container-level egress control only** (an internal Docker network, a sidecar proxy). It cannot tell
  the supervisor, which must reach GitHub and the model upstream, from the engine in the same
  container, and it does not separate the engine from other loopback services. It remains the
  hosted-only gate #82.
- **`sudo` or a setuid launcher.** Needs privilege escalation, so `no-new-privileges` would have to go.
- **Landlock network rules, seccomp.** Port-only or address-blind, and a kernel prerequisite the lead
  decisions rule out.
- **Fewer capabilities with a scrub-as-the-engine-user cleanup** instead of `DAC_OVERRIDE`/`FOWNER`.
  Possible, but #196's sealed export (`0550`, root-owned) already needs `DAC_OVERRIDE` to be removed.

## 4. Consequences

- The Dynamic runner image needs the engine binary, `nft`, ripgrep and the engine user `10101:10101`
  (#202); the host kernel needs `nf_tables`. When it is missing, the proof fails and no engine starts.
- The supervisor, a larger process than the engine, runs as root with six capabilities (the container
  starts with eight, see decision 5). It handles
  untrusted Git objects while preparing the export (#196) and the model proxy's HTTP; keeping that code
  small and free of repository-chosen commands is part of reviewing it.
- Unix sockets of the shared network namespace (abstract or on a path) are not filtered by the rules;
  decision 6 keeps the set of reachable ones empty.
- The ports of the slot are fixed: a stranger that holds one makes the job fail closed
  (`dynamic_isolation_self_check_failed` for the proxy port, `dynamic_engine_unavailable` for the
  engine port) instead of moving to another port. Concurrency above one needs a pair of ports and a
  uid per slot, and one ruleset each.
- The engine config is owned by the supervisor (root) with the engine's group and mode 0440: the
  engine reads it but can neither rewrite nor chmod it.
- The engine user must differ from the Diff-job user (`RUNNER_DIFF_JOB_USER`) in uid and gid; the job
  loop refuses to start otherwise.
- One engine user per concurrent slot. The default is one slot.

## 5. Open questions

- Splitting the root part into a smaller process.
- The Docker/Coolify targets whose kernel provides `nf_tables` for container root with `NET_ADMIN`.

## 6. Out of scope

The startup self-check that advertises `opencode`, the image installation and the supply-chain audit
(#202), the token cap (#231), neutralising `<system-reminder>` wrappers (#232), the hosted egress gate
(#82).
