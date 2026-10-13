# 0003: The engine boundary of Dynamic Review

- **Status:** Accepted
- **Date:** 2026-10-13
- **Deciders:** decided by the project (lead decisions of 2026-10-12 on epic #193); the mechanism
  is the answer to the open question of [0002](0002-dynamic-review-deployment.md), section 5
- **Implemented by:** issue #197 (part 2b), with #202
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
   (remove the sealed export and what the engine user created), `NET_ADMIN` (the rules below). The
   privileged test suite runs with exactly this set and a test keeps it equal to `compose.dynamic.yml`.
3. **Per-user nftables rules, proven before the engine starts.** The supervisor installs output rules
   for the engine user's uid: new connections only to this job's proxy port and the engine's own server
   port on `127.0.0.1`, everything else rejected. The probe that proves them runs as the engine user.
   The rules, not a namespace, are the boundary against other jobs' loopback services and any external
   host.
4. **The dedicated user is the unit of cleanup.** After the group kill, a `kill(-1, SIGKILL)` run as
   the engine user ends whatever that user still runs; the same runs when a job starts, for what a
   killed predecessor left.

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
- The supervisor, a larger process than the engine, runs as root with seven capabilities. It handles
  untrusted Git objects while preparing the export (#196) and the model proxy's HTTP; keeping that code
  small and free of repository-chosen commands is part of reviewing it.
- Abstract Unix sockets of the shared network namespace are not filtered.
- One engine user per concurrent slot. The default is one slot.

## 5. Open questions

- Whether the supervisor can drop `NET_ADMIN` after the rules are in place (they are replaced when a
  start is retried on another engine port) or split the root part into a smaller process.
- The Docker/Coolify targets whose kernel provides `nf_tables` for container root with `NET_ADMIN`.

## 6. Out of scope

The startup self-check that advertises `opencode`, the image installation and the supply-chain audit
(#202), the token cap (#231), neutralising `<system-reminder>` wrappers (#232), the hosted egress gate
(#82).
