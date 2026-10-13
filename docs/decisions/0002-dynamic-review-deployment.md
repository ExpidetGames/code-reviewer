# 0002: How Dynamic Review is deployed and switched on

- **Status:** Accepted
- **Date:** 2026-10-13
- **Deciders:** decided by the project (lead decisions of 2026-10-12 and 2026-10-13 on epic #193)
- **Implemented by:** issue #202 (this record covers the first slice), with #197

## 1. Context

Epic #193 adds Dynamic Review next to Diff Review. The binding decisions are already made: stock
OpenCode v1.19.0 without a fork or patch, no bubblewrap or user-namespace sandbox, the runner container
plus a dedicated unprivileged engine user as the boundary, a runner-owned model proxy with hard limits,
and an instance-level rollout gate that is off by default. What this record adds is how an operator
runs and switches it on. Three forces shape it:

- The runner image will become larger and more privileged-looking (an engine binary, a second user).
  A Diff-only installation must not pay for that, and a failed Dynamic prerequisite must never take
  Diff reviews down.
- Nobody has measured the whole-job memory of a Dynamic job. The spike sampled the engine's RSS only.
- The gate protects against a previous-release app seeing a Dynamic row, so it is an *app and database*
  property. The capability is a *runner* property proven by its own self-check. They must not be
  merged into one switch.

## 2. Decision

1. **A separate, opt-in Dynamic runner.** `compose.dynamic.yml` is an override file that adds the
   service `runner-dynamic`; `compose.yml`, `compose.coolify.yml` and `compose.large.yml` do not know
   it. The Diff runner stays PR-Agent-only and never advertises `opencode`. The Dynamic runner has its
   own image variable (`RUNNER_DYNAMIC_IMAGE`) because the engine will only be in that image.
2. **One Dynamic slot to start.** The Dynamic runner runs one job at a time
   (`RUNNER_DYNAMIC_CONCURRENCY=1`), with a 2 GiB limit and 1.5 GiB reservation (at least 1 GiB per
   slot plus the runner and proxy reserve, the spike's conservative and unvalidated proposal), no swap,
   no capability, `no-new-privileges` and a process limit. Raising the concurrency requires the
   worst-case whole-job cgroup and OOM measurements of `docs/dynamic-review.md`.
3. **The gate and the capability stay two switches.** The gate is the instance setting
   `dynamic_review`, changed only by the instance admin in the portal (`PUT /api/admin/settings`,
   server side) through the instance settings setter, which takes the gate lock and cancels waiting
   Dynamic jobs. The capability is advertised by the runner after its self-check. Turning the gate on
   does not make a runner capable and a capable runner does not turn the gate on; a gate that is on
   with no capable runner ends in `no_capable_runner`, not in a Diff review.
4. **The portal, not a CLI.** The admin CLI is a SQLite-only helper that imports no application code;
   the setter needs the Kysely repositories and (for Postgres) the advisory lock order of
   `contracts/README.md`. The portal control also asks the admin to confirm the rollout order before it
   turns the gate on.
5. **Process-group ids are never signalled after their leader was reaped.** The engine and the git
   helpers lead their own process group, identified by the leader's pid. The runner now observes a
   leader's exit with `waitid(WNOWAIT)`, ends the group while the leader (a zombie at worst) still
   holds the id, and reaps it last (`runner/src/code_reviewer_runner/process_group.py`). A reused id
   cannot be signalled because it is never free while the runner signals it.

## 3. Alternatives considered

- **One runner that becomes capable when it can.** Rejected: a failed Dynamic prerequisite and the
  Dynamic memory profile would then affect the Diff runner, and the Diff-only option would need a
  different image anyway.
- **A compose profile in `compose.yml`.** Rejected: the existing guards require identical services in
  the compose files, a profile can be enabled by a stray flag, and the file must not suggest that
  Dynamic Review can be activated yet.
- **`pidfd_send_signal` for the group.** It signals one process, not a group, so it cannot replace
  `killpg`. A dedicated cgroup or uid kill (the other option named in #202) needs the dedicated-uid
  launch of the second half of #197 and stays on the follow-up list; the rule above is enough until
  then.
- **A gate CLI.** See decision 4.

## 4. Consequences

- A Diff-only installation is unchanged; Dynamic Review is a conscious file and a conscious gate.
- Two services have to be sized and updated. The Dynamic runner serves Diff jobs too, which costs it
  capacity.
- The deployment file can be reviewed and tested now, but it cannot be activated: the engine, the
  isolation self-check and the proof tests land with #197 part 2 and the rest of #202.

## 5. Open questions

- How the engine's network is confined to the job's proxy (a network namespace per job, or an owner
  based filter for the engine user) and which capability the runner then needs; `cap_drop: ALL` in
  `compose.dynamic.yml` is revisited with it.
- The Coolify variant of the Dynamic runner and the supported Docker/Coolify target list.
- The measured concurrency per GiB.

## 6. Out of scope

The engine adapter and its proof suite (#197), the hosted egress gate (#82), repository code
execution (#130) and benchmarks of quality or cost.
