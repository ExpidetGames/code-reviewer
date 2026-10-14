# 0004: The Dynamic runner image and the startup self-check

- **Status:** Accepted
- **Date:** 2026-10-14
- **Deciders:** decided by the project (lead decisions of 2026-10-12 and 2026-10-13 on epic #193)
- **Implemented by:** issue #202 (the shipping slice)
- **Amends:** [0002](0002-dynamic-review-deployment.md), decision 1 (the image of the Dynamic runner
  now exists) and its consequences (the file can now be activated); the rest of 0002 and all of
  [0003](0003-dynamic-engine-boundary.md) stand

## 1. Context

Everything the Dynamic engine needs at run time was decided and built in pieces: the pinned stock
OpenCode, the root supervisor and the engine user (0003), the static nft rules, the gate and the
capability as two switches (0002). What was missing is the image that carries them, the proof at start
that the container really is that boundary, and the instructions to switch it on. Three questions:
one image or two; what the runner proves before it advertises `opencode`; and how an operator on
Docker Compose or Coolify gets the runner.

## 2. Decision

1. **Two images from one Dockerfile, the default one unchanged.** `runner/Dockerfile` has a shared
   `runtime-base` stage (Python, the PR-Agent environment, `tini`, the licence files, user 10001), a
   `dynamic` target that adds the engine, and `runtime` as the last stage so a plain build gives the
   PR-Agent-only runner. The Dynamic image adds the pinned OpenCode (about 186 MB), a pinned `rg`,
   Debian's `nftables` and the engine user 10101. It starts as the unprivileged user 10001 like the
   default; only `compose.dynamic.yml` makes it the root supervisor.
2. **Pins, verified twice.** The engine is installed by the existing pin and fetch
   (`opencode-pin.json`, `fetch_opencode.py`); `rg` by the same mechanism (`ripgrep-pin.json`,
   `fetch_ripgrep.py`), because the engine's grep and glob need one and the stock engine downloads one
   when none is on its path. Both are accepted by size and SHA-256 at build time. The pins travel
   inside the image (`/opt/code-reviewer/pins/`), and the runner hashes the installed files against
   them again at start. `nft` is Debian's signed package and is not pinned: `apt` takes the version the
   repository has at build time (it does not follow the base image digest), like `tini`. Pinning
   `nftables=<version>` was considered and rejected: Debian mirrors drop superseded versions, so the
   pin would break the build at the next point release without making it more reproducible.
3. **A startup self-check decides the advertisement.** After the one-time network setup (0003,
   decision 5) and before the first claim the runner checks, in this order: an engine user and slot
   ports are configured, the process is root, the engine user exists with its own group, the rules were
   installed, `NET_ADMIN` and `SETPCAP` are gone, `opencode` and `rg` are regular, root-owned files that
   nobody else can write and equal their pins, the engine reports the pinned version as the engine
   user, and a probe as the engine user reaches the slot's proxy port and nothing else (the supervisor
   plays the proxy; at start no job exists). Any failure, or any error in the check, leaves `pr-agent`
   only and logs a stable reason (`SelfCheckReason`) without a value. Only a runner with an engine
   user configured, which only `compose.dynamic.yml` sets, can pass; the default runner logs
   `not_a_dynamic_runner` as information.
4. **The loop hands the result on; nothing else can.** The loop sets, for Dynamic job processes only,
   the advertised engines, the verified engine command and the operator's non-secret Dynamic
   variables. The job environment is an allow-list, so an operator's `RUNNER_OPENCODE_COMMAND` never
   reaches a job; the job process refuses a Dynamic job unless it was handed `opencode`.
5. **Built from the checkout, not published.** `compose.dynamic.yml` builds the `dynamic` target
   (`up --build`), like `compose.build.yml` and `compose.coolify.yml` build theirs; the GHCR packages
   are private (#89 is open) and a second published image would be a release decision. Coolify takes
   one Compose file per resource; this decision first shipped `compose.coolify.dynamic.yml` as a
   standalone second resource, which #264 replaced (owner decision of 2026-10-14): the same service is
   now `runner-dynamic` in `compose.coolify.yml`, so the existing resource builds and starts it, and a
   test keeps it equal to `compose.dynamic.yml`. It is untested on a real Coolify and says so.
6. **Provenance in `make check-licenses`.** The two binaries are audited from their pin files (source
   commit, licence, digests, notices) and the Bun-lock runtime closure of OpenCode's pinned commit is a
   committed snapshot judged by the same licence policy, offline.
7. **Capacity stays a manual step.** One slot, at least 1 GiB per slot plus a reserve, 2 GiB limit, no
   swap. The whole-job cgroup and OOM measurements need a real host and are a documented procedure, not
   a CI test; no number is invented.

## 3. Alternatives considered

- **One image with the engine in it.** Rejected: every Diff-only installation would carry an engine, a
  firewall tool and a second user it never uses. Smaller is the smaller attack surface.
- **The advertisement from a file or an environment variable.** Rejected: a flag cannot know that the
  rules are installed, that the capability is gone or that the binary is the pinned one. The check
  reads the facts.
- **Per-job re-hashing of the engine.** Rejected: the files are root-owned and unwritable by anyone
  else, and a process that can write them is already the supervisor; startup is enough. Per job the
  export, the private state and the network are proven, which can change per job.
- **Publishing the image to GHCR now.** Postponed to the release and registry decisions (#89).

## 4. Consequences

- A Diff-only installation is unchanged: same image, no new executable, no new capability.
- The Dynamic image is built where it is deployed (first build downloads about 60 MB, verified).
- A host without `nf_tables`, a platform that strips capabilities or ignores `user: "0:0"`, or an
  arm64 host, is a runner that logs a reason and serves Diff jobs only. It never fails Diff.
- The check is a point-in-time proof. A container restart repeats it (and starts with `NET_ADMIN` again; the
  read-only root filesystem of #249 makes sure it runs the image as built, see 0003). The files it
  trusts are judged with every directory above them up to `/` (a real directory, owned by root, not
  writable by group or others), and the pins like the binaries (#249, from the review of #250).
- `fail_closed_self_check` is gone; the tests that pinned it are replaced by tests of the real check
  that pin the same property (a failure never advertises) and more.

## 5. Open questions

- Publishing the Dynamic image and an arm64 build with its own pins.
- The measured slot count per GiB, and concurrency above one (a pair of ports, a user and a ruleset per
  slot).
- Which Docker and Coolify targets are verified (today only CI's Docker on Linux/amd64).
- The prompt inputs on the production Dynamic path (#201), the hidden-character input (#247) and the
  token calibration (#235).

## 6. Out of scope

The switch-on on any instance, the hosted egress gate (#82), repository code execution (#130) and
benchmarks of quality or cost.
