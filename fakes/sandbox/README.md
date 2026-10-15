# fakes/sandbox

The double of the Sandbox platform for the Sandbox-Launcher (#316, #329). It speaks the port of
`dispatcher/src/launchers/sandbox-service.ts` (a VM is created from a snapshot, a command runs in it, a process has a
stdin pipe, a VM is stopped by its name) and matches it structurally: nothing here imports the Dispatcher, because
`fakes/` is shared by every project. The golden snapshot pipeline (#330) has a separate double with a wider port
(builder VMs, snapshots): `fakes/vercel-sandbox/`. The two do not share state.

| File                 | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service.ts`         | `FakeSandboxService`, in-process. No command runs. `onExec(label or regular expression, answer)` scripts a command, `exitProcess(vm, code)` ends the Worker's `docker run`, `failNextCreate(error)` makes the platform refuse, `holdNextCreate()` keeps a create pending so a test can abort it. A VM that is stopped ends its processes with 137. `stdinOf(vm)` is what went through the pipe; `requestText()` is everything else that was sent (create options, command lines, stops), so a test can prove the credential is in the first and not in the second.       |
| `local.ts`           | `LocalSandboxService`, the local mode. A "VM" is a temporary directory (the working directory and the home of every command in it). `docker` commands run on this machine with `dockerBin` (the real one, or `bin/fake-docker.sh`); `vm-prepare.sh` succeeds without doing anything; other commands are refused (`127`). Stopping a VM force-removes the containers it started and deletes its directory, so nothing of a job is left for the next. There is no `sudo`, no snapshot and no kernel of its own: it proves the container spec end to end, not the platform. |
| `bin/fake-docker.sh` | A stand-in `docker` for hosts with no daemon. It records the arguments, the environment and the working directory of a `docker run` and everything written to its stdin, and ends like a Worker would (`FAKE_DOCKER_RUN_SECONDS`, `FAKE_DOCKER_EXIT`).                                                                                                                                                                                                                                                                                                                   |

Rules: dummy values only; no real token, snapshot id or image id. A real platform call from a test is a bug: the
Dispatcher tests replace `@vercel/sandbox` (`src/index.test.ts`) or hand the adapter a stand-in SDK
(`vercel-sandbox.test.ts`).

Used by `dispatcher/src/launchers/sandbox.test.ts` (service double), `sandbox-local.integration.test.ts` (local mode with
the stand-in `docker`) and `sandbox-local.privileged.test.ts` (local mode with a real daemon and the real Worker image,
`make test-sandbox-local`).
