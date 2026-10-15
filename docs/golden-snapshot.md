# Golden snapshot (hosted deployment)

The hosted deployment (#316) runs every review job in a fresh Vercel Sandbox VM that is a clone of one **golden
snapshot**: a VM image with a pinned Docker installed, the cgroup preparation script in place and the Worker image
already built. This document is the runbook for that snapshot: how it is made, what proves it, how to rebuild it, roll
back to the previous one and what happens to old ones. The code is `dispatcher/src/snapshot/`; the workflow is
`.github/workflows/golden-snapshot.yml`; the Sandbox double the tests use is `fakes/sandbox/`.

## What the pipeline does

`pnpm --dir dispatcher snapshot:build --context <tgz> --vm-prepare <sh> --out <json> [options]` (the workflow runs it).
In order:

| #   | Step (label in the logs)                                      | What happens                                                                                                                                                                                                          | Failure code (`SNAPSHOT_ERROR_CODES`)                             |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `create_builder`                                              | A persistent builder VM in `fra1` (2 vCPU / 4 GB) from the platform's default image. Named `code-reviewer-golden-builder-<UTC time>`.                                                                                 | `builder_create_failed`                                           |
| 2   | `install_docker`                                              | `apt-get install docker.io=<pinned>* docker-buildx=<pinned>*`; the installed `docker.io` must start with the pinned version.                                                                                          | `docker_install_failed`, `docker_version_mismatch`                |
| 3   | `write_daemon_config`, `install_host_scripts`, `start_daemon` | `/etc/docker/daemon.json` (IPv6 off), `docker/sandbox/vm-prepare.sh` into `/usr/local/sbin/vm-prepare.sh`, and a run of it: the same cgroup fix and `dockerd` start the Sandbox-Launcher (#329) runs on every job VM. | `daemon_config_failed`, `host_prepare_failed`                     |
| 4   | `build_image`                                                 | The commit's tarball (`git archive`, tracked files only) is uploaded and `docker build --target <target>` runs in the VM. About 70 s in the spike. **No registry and no registry credential is involved.**            | `context_upload_failed`, `image_build_failed`                     |
| 5   | `inspect_image`, `clean_builder`                              | The image id (`sha256:<64 hex>`, `docker image inspect --format '{{.Id}}'`) is read and becomes `imageDigest`. Build cache and staged files are removed.                                                              | `image_digest_invalid`                                            |
| 6   | `check_no_containers`, `stop_daemon`                          | `docker ps -aq` must be empty (no container, running or not), then `dockerd` gets SIGTERM and the step waits until it, containerd and the shims are gone. Never SIGKILL.                                              | `containers_present`, `daemon_not_stopped`, `daemon_query_failed` |
| 7   | `snapshot`                                                    | `snapshot({expiration: 0})`: **no expiry**. It must be `created` and available in `fra1`.                                                                                                                             | `snapshot_failed`, `snapshot_region_mismatch`                     |
| 8   | `create_check_vm`                                             | A VM `code-reviewer-golden-check-<UTC time>`, **created from the new snapshot** with `persistent: false`, the way a job VM is.                                                                                        | `check_vm_failed`                                                 |
| 9   | `scan_filesystem`                                             | No secret and no job data in the restored snapshot (below).                                                                                                                                                           | `scan_findings`, `scan_unreadable`                                |
| 10  | `start_daemon_check`, `inspect_restored_image`                | `vm-prepare.sh` brings the daemon up; the image id must equal step 5.                                                                                                                                                 | `host_prepare_failed`, `image_digest_mismatch`                    |
| 11  | `probe`                                                       | The image runs in `probe` mode (#324) with the hardened container flags plus the IPv6 sysctls; its verdict must advertise every engine in `requiredEngines` (`pr-agent`, `opencode`).                                 | `probe_failed`, `probe_unreadable`, `engine_missing`              |
| 12  | record, retention                                             | The record is returned and written; older builders are removed (below); the check VM is deleted.                                                                                                                      | `record_invalid`; retention only warns                            |

**Fail closed.** If any step fails after the snapshot exists, the builder is deleted **with** its snapshots, so a bad
snapshot is withdrawn and the run leaves no record. The record file named by `--out` is deleted when the run starts, so
a failed run cannot leave the last good record looking current. If a VM or snapshot cannot be deleted, the error names
it (`cleanupFailures`) and the operator removes it. A snapshot whose Dynamic self-check does not advertise `opencode` is
never recorded.

**What the pipeline never has.** It runs no job code, receives no job credential and no registry credential. The
Vercel token is read from the environment, handed to the platform client and to nothing else (no VM command, file or
environment, no argument, no log line: every log line is masked). The VMs hold no secret.

## The record

```json
{
  "version": 1,
  "snapshotId": "snap_...",
  "imageDigest": "sha256:<64 hex>",
  "builtAt": "2026-10-15T18:00:00.000Z",
  "region": "fra1",
  "target": "sandbox",
  "commit": "<sha>"
}
```

`snapshotId` and `imageDigest` are what the Sandbox-Launcher (#329) is configured with. The Launcher creates job VMs
from `snapshotId` in `fra1` and refuses to run when `docker image inspect` in the VM reports another id than
`imageDigest`. The workflow keeps the record as the artifact `golden-snapshot-record` (90 days) and shows it in the run
summary. Nothing in the pipeline changes a deployment: **marking a snapshot current is a manual step**, see below.

## Running it

Once, in the repository settings: an environment `hosted-snapshot` (add a required reviewer if wanted) with the secrets
`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` of the Dispatcher's Vercel project. A run then starts with
_Actions > Golden snapshot > Run workflow_ (inputs: `target`, default `sandbox`; `pinned_snapshot`, the snapshot id the
Dispatcher uses now). To rebuild automatically on every release, set the repository variable
`GOLDEN_SNAPSHOT_ENABLED` to `true`: a push to `main` then runs it. Without it the push does nothing. It never runs for a
pull request. Locally the same command works with the three variables exported and `--context` made with
`git archive --format=tar.gz --output /tmp/context.tgz HEAD` (never run it against a platform account you do not mean
to change).

Options of the command: `--target`, `--dockerfile`, `--image-tag`, `--docker-version`, `--buildx-version`, `--commit`,
`--keep` (default 2), `--pin-snapshot` (repeatable). Without `VERCEL_TOKEN` the platform client uses the OIDC token of
the environment. Exit status: 0 the record was written, 1 the run failed (the log line `golden_snapshot_failed` has the
code and, for a failed command, its exit status and the last lines of its error output), 2 wrong use, nothing created.

## Rebuild

A snapshot is rebuilt **on every image release** (a stale snapshot means a stale Worker image: the Launcher's digest
check refuses it, and the fix is a rebuild). Also rebuild when the pinned Docker version changes
(`dockerVersion`/`buildxVersion` in `dispatcher/src/snapshot/config.ts`, or `--docker-version`), when
`docker/sandbox/vm-prepare.sh` changes, or when the platform's base image changes (the install step then fails with
`docker_version_mismatch` instead of snapshotting something nobody tested: update the pin, re-run the checks of spike
#317 on the new base).

1. Run the workflow, passing the snapshot id in use as `pinned_snapshot`.
2. Read the record from the summary or the artifact.
3. Run the canary (#331) on the new snapshot. Only when it passes, configure the Dispatcher project with the new
   `snapshotId` and `imageDigest` and redeploy it.
4. The previous snapshot stays until the next build's retention removes it.

## Roll back to the previous snapshot

The previous snapshot is kept by retention (the newest two builders, plus any `--pin-snapshot`). To go back: take its
record (the artifact of that run, or the builder `code-reviewer-golden-builder-<time>` whose time you want; its snapshot id
is the builder's current snapshot) and put its `snapshotId` and `imageDigest` back into the Dispatcher configuration.
The digest must go with the snapshot: they were checked together. Then pin the snapshot in use in the next run so
retention does not remove it while a newer, failed build exists.

## Expiry and retention

- **Snapshots do not expire** (`expiration: 0`). The platform's default of 30 days applies to automatic snapshots of
  persistent VMs, not to this one; if retention stops running, snapshots stay (and are billed as storage).
- **Retention** runs after a new snapshot passed every check. It keeps the newest `--keep` builders (default 2: the
  current one and one previous) and every `--pin-snapshot`, and deletes the other builders **with** their snapshots
  (`deleteOrphanSnapshots`). It only touches builders whose name starts with `code-reviewer-golden-builder-`.
- A failed retention step is a warning (`retention_failed` in the log): the new record is valid. Delete the named
  builders by hand.
- A builder whose snapshot the platform did not report is never deleted automatically (warning
  `builder_without_snapshot`). A run that was killed leaves a builder without a snapshot behind: it is a VM that ends at
  its timeout; delete it by hand once it is stopped.
- Snapshots are **region-bound to `fra1`**: no failover. If the region is unavailable, new jobs cannot start; there is
  no snapshot elsewhere to fall back on.

## The final scan (T06)

The scan runs in the VM created from the snapshot (what a job VM will see), as root, and reads files only. It reports
`FINDING <kind> <path>` and never a content; the run fails on any finding, and fails if the scan does not end with its
marker. Looked at: `/root`, `/home`, `/etc`, `/opt`, `/usr/local`, `/var/tmp`, `/var/log` and the container and volume
directories of Docker.

| Kind          | Finding                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret_file` | `.env`, `.env.*` (not `.env.example`), `.netrc`, `.git-credentials`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`                           |
| `history`     | shell, Python and Node history files                                                                                                        |
| `docker_auth` | a `.docker/config.json` with a non-empty `auth`, `identitytoken` or `registrytoken`                                                         |
| `private_key` | a `-----BEGIN ... PRIVATE KEY-----` header (the distribution's snake-oil key is allowed)                                                    |
| `token`       | the shapes of GitHub, OpenRouter, Anthropic, AWS and Slack tokens, the per-job credential, `_authToken=`, `RUNNER_TOKEN=`-style assignments |
| `job_data`    | any entry in Docker's `containers` or `volumes` directory (except Docker's own `metadata.db`)                                               |

The shapes are deliberately few and exact: a false finding stops a release. The layers of the Worker image are not
read: they come from the tracked files of the commit and the pinned downloads of the Dockerfile. A **manual** check of the
first real snapshot, before the first Dynamic activation, is still the sign-off of #330-T06: create a VM from it, run
`sudo docker images`, `sudo docker ps -a`, `sudo find / -xdev -newer /usr/local/sbin/vm-prepare.sh -type f` and look at
anything that is not an apt, Docker or build artifact.

## Failure codes

| Code                                                              | Meaning and what to do                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_invalid`                                           | An option was refused; the log names it.                                                                                                                                                                                                 |
| `builder_create_failed`, `check_vm_failed`                        | The platform refused a VM (credentials, quota, region). Check the token, the project and the quota; run again.                                                                                                                           |
| `docker_install_failed`, `docker_version_mismatch`                | apt could not install the pinned versions. The base image has other versions: update the pin deliberately.                                                                                                                               |
| `daemon_config_failed`, `host_prepare_failed`                     | `daemon.json` or `vm-prepare.sh` failed (the cgroup layout of the base image may have changed: see spike #317, finding F1).                                                                                                              |
| `context_upload_failed`, `image_build_failed`                     | The build failed; the log carries the last 20 lines of its error output.                                                                                                                                                                 |
| `image_digest_invalid`, `image_digest_mismatch`                   | The image id is not one `sha256` digest, or the restored snapshot holds another image than the one built. Do not publish.                                                                                                                |
| `containers_present`, `daemon_not_stopped`, `daemon_query_failed` | A container existed, the engine would not stop, or it could not be asked, at snapshot time. Nothing was snapshotted.                                                                                                                     |
| `snapshot_failed`, `snapshot_region_mismatch`                     | The platform did not create the snapshot, or not in `fra1`.                                                                                                                                                                              |
| `scan_findings`, `scan_unreadable`                                | The scan found something (kind and path are in the log) or did not finish. The snapshot was deleted.                                                                                                                                     |
| `probe_failed`, `probe_unreadable`, `engine_missing`              | The image's own self-check failed or answered nonsense, or did not advertise a required engine (the stable reasons are listed). Dynamic stays unavailable; fix the cause (for example the nf_tables fallback of #345, the IPv6 sysctls). |
| `unexpected_error`                                                | A failure in the pipeline's own code (a bug): no snapshot is kept. Report it with the log.                                                                                                                                               |
| `cancelled`                                                       | The run was interrupted; whatever it created was deleted.                                                                                                                                                                                |

## Not verified yet

The pipeline is tested against `fakes/sandbox` only; no test calls the platform. The first real run needs the
maintainer's token and has to confirm: the apt versions pinned in `config.ts` on the current base image; that
`snapshot()` of a persistent builder keeps the snapshot after the builder is stopped and reports it as the builder's
`currentSnapshotId` (retention relies on it); that the `sandbox` target (#324) builds and answers `probe` with
`opencode` on the platform kernel (with the egress fallback of #345); that the scan has no false finding on the real
base image. See the follow-ups of #330.
