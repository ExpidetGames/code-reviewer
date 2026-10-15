# Vercel Sandbox double

An in-process stand-in for the Vercel Sandbox platform (`service.ts`), for tests that must never reach the real one.
First user: the golden snapshot pipeline (#330, `dispatcher/src/snapshot/`). The Sandbox-Launcher (#329) does not
use it: it has its own double, `fakes/sandbox/` (see below). It imports nothing from the Dispatcher: it matches the port `dispatcher/src/snapshot/service.ts`
structurally, so a Dispatcher test passes it where the port is expected and the type checker proves the match.

It runs **no command**. A command's result is scripted; the double only records what was asked.

```ts
const fake = new FakeSandboxService();
fake.onExec("inspect_image", { stdout: "sha256:..." }); // by the step label of the command
fake.onExec(/docker run/, ({ vm }) => ({ exitCode: 1 })); // or by a regular expression over its script
fake.onExec("probe", { stdout: "..." }, { on: "clone", times: 1 }); // only on a VM made from a snapshot, once
fake.failNextCreate(new Error("capacity")); // the next createVm rejects
fake.failNextSnapshot(new Error("quota"));
fake.setNextSnapshotStatus("failed");
fake.failDestroyOf("some-vm"); // deleting this VM fails
fake.seedBuilder("name-prefix-...", createdAtMs, withSnapshot); // a builder left by an earlier run
```

| What it models                                                                       | How a test sees it                                                                                                               |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `createVm`: a unique name (a taken name rejects), a snapshot source that must exist  | `vms` (options, kind `builder` or `clone`, state, files written), `events`                                                       |
| `run`: scripted by label or script; unscripted ends with exit 0 and no output        | `calls` (label, script, `sudo`, `env`, VM), `callsFor(label)`                                                                    |
| `writeFile`                                                                          | `vms.get(name).files`, `events` (`write:<path>`)                                                                                 |
| `snapshot`: a new id, status and regions (default `fra1`), the VM stops              | `snapshots`, `liveSnapshotIds()`, `events` (`snapshot:<id>`)                                                                     |
| `destroy` with or without the snapshots the VM owns; `deleteBuilder`; `listBuilders` | `liveVmNames()`, `events` (`destroy:<name>`)                                                                                     |
| Everything sent                                                                      | `requestText()`: scripts, environment, file contents, create options, as one text, to prove that a secret never left the process |

## For the Sandbox-Launcher (#329)

The Sandbox-Launcher has its own double, `fakes/sandbox/`, behind its own port (`dispatcher/src/launchers/sandbox-service.ts`):
the per-job calls (create from a snapshot, a command as an argument vector, a process with a stdin pipe, stop by name) are
not the builder calls of this port (scripts, files, snapshots, deletion), and the local mode that runs the rendered
`docker run` lives there too. This double is for the golden snapshot pipeline only. If the two ports should become one,
that is a change of both, see `fakes/sandbox/README.md`.

The double is wider than the platform in one place: the pipeline's `SandboxVm.run` has a `label`, which the real
adapter drops. A Launcher test should address a command by its label the same way.
