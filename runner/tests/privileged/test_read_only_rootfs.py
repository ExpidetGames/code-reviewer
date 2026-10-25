# SPDX-License-Identifier: LicenseRef-Proprietary

"""The root filesystem is read-only; only the tmpfs are writable (#249, ADR 0003 decision 5).

The container restarts with `NET_ADMIN` (`restart: unless-stopped`), so whatever a compromised root
supervisor could change in the image (`nft`, `tini`, the runner source) would run with it. The
Dynamic runner therefore runs with `read_only: true` and three private tmpfs (`compose.dynamic.yml`,
pinned by `app/src/ci/compose-dynamic.test.ts`). `scripts/run_privileged_offline.sh` builds the same
layout in its mount namespace (every disk filesystem read-only, a tmpfs on `/tmp` and `/run` with
the options of the compose file), so the whole suite runs on it: that the other tests pass is the
proof that the job directories, the leases, the export and the engine's home need nothing else.
These tests judge the layout itself, as the supervisor (root with the job capabilities, among them
`DAC_OVERRIDE` and `CHOWN`) and as the engine user.
"""

import errno
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path

import pytest
from privileged_support import ENGINE_GID, ENGINE_UID

import code_reviewer_runner

RUNNER_SOURCE = Path(code_reviewer_runner.__file__).resolve()


def mounts() -> dict[str, tuple[set[str], set[str]]]:
    """Mount point -> (mount options, superblock options); the top mount of a point wins."""
    found: dict[str, tuple[set[str], set[str]]] = {}
    for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
        before, _, after = line.partition(" - ")
        fields = before.split()
        super_options = after.split()[2].split(",") if len(after.split()) > 2 else []
        found[fields[4]] = (set(fields[5].split(",")), set(super_options))
    return found


def the_files_that_run_with_the_startup_capabilities() -> list[Path]:
    """What a restart would run with `NET_ADMIN`: the rule tool, the runner source, the system."""
    nft = shutil.which("nft", path="/usr/sbin:/sbin:/usr/bin:/bin")
    assert nft is not None, "nft is not installed"
    return [Path(nft).resolve(), RUNNER_SOURCE, Path("/etc/passwd"), Path("/usr/bin/env").resolve()]


def refused_as_read_only(action: str, call: Callable[[], object]) -> None:
    with pytest.raises(OSError) as caught:
        call()
    assert caught.value.errno == errno.EROFS, f"{action}: {caught.value}"


# #249-T01
def test_the_root_filesystem_is_mounted_read_only() -> None:
    root_options, _ = mounts()["/"]

    assert "ro" in root_options
    for path in the_files_that_run_with_the_startup_capabilities():
        assert os.statvfs(path).f_flag & os.ST_RDONLY, f"{path} is on a writable filesystem"


# #249-T01: root with DAC_OVERRIDE, CHOWN and FOWNER, the strongest process of a job.
@pytest.mark.parametrize("index", range(4))
def test_the_supervisor_cannot_change_what_a_restart_would_run_with_net_admin(index: int) -> None:
    path = the_files_that_run_with_the_startup_capabilities()[index]
    sibling = path.with_name(path.name + ".planted")
    before = path.stat()
    # The attempts below would damage a writable system: they only run on a read-only one.
    assert os.statvfs(path).f_flag & os.ST_RDONLY, f"{path} is on a writable filesystem"

    refused_as_read_only("open for writing", lambda: os.close(os.open(path, os.O_WRONLY)))
    refused_as_read_only("append", lambda: path.open("ab").close())
    refused_as_read_only("chmod", lambda: os.chmod(path, 0o777))
    refused_as_read_only("chown", lambda: os.chown(path, ENGINE_UID, ENGINE_GID))
    refused_as_read_only("unlink", lambda: os.unlink(path))
    refused_as_read_only("rename", lambda: os.rename(path, sibling))
    refused_as_read_only(
        "create next to it", lambda: os.close(os.open(sibling, os.O_CREAT | os.O_WRONLY))
    )
    assert not sibling.exists()
    assert path.stat().st_mtime_ns == before.st_mtime_ns
    assert path.stat().st_mode == before.st_mode


# #249-T01: no capability to make it writable again (no SYS_ADMIN in the set).
def test_the_supervisor_cannot_remount_the_root_filesystem_writable() -> None:
    for options in ("remount,rw", "remount,bind,rw"):
        done = subprocess.run(
            ["mount", "-o", options, "/"], capture_output=True, text=True, timeout=30, check=False
        )

        assert done.returncode != 0, "the root filesystem was made writable"
        assert mounts()["/"][0] >= {"ro"}


# #249-T01: what must still work (the job directories, the leases) is exactly the tmpfs.
def test_the_tmpfs_are_writable_for_root_and_locked_down() -> None:
    table = mounts()
    for path in ("/tmp", "/run"):
        options, super_options = table[path]
        assert {"rw", "noexec", "nosuid", "nodev"} <= options, path
        assert any(option.startswith("size=") for option in super_options), path
        probe = Path(tempfile.mkdtemp(dir=path, prefix="cr-probe-"))
        try:
            (probe / "file").write_text("written", encoding="utf-8")
            script = probe / "script.sh"
            script.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            script.chmod(0o755)
            # noexec: nothing written here can be run, not even by root.
            with pytest.raises(PermissionError):
                subprocess.run([str(script)], check=False)
        finally:
            shutil.rmtree(probe)
    assert os.stat("/tmp").st_mode & 0o7777 == 0o1777
    # /run is the leases of the checkout: root only.
    assert os.stat("/run").st_mode & 0o7777 == 0o755


# #249-T01: the engine user gains no write path from the layout. On the read-only root it can write
# nowhere (find asks the kernel with access(2), which also answers for a read-only mount); the one
# place on the mounts it can use is /tmp, world-writable with the sticky bit as in the image before.
# The CI host's disk is large, so the search is bounded in depth; that the whole mount is read-only
# is the first test, and the image smoke test walks the real container filesystem completely.
def test_the_engine_user_cannot_write_anywhere_but_tmp() -> None:
    def writable_as_engine(*arguments: str) -> list[str]:
        done = subprocess.run(
            ["find", *arguments, "-writable"],
            user=ENGINE_UID,
            group=ENGINE_GID,
            extra_groups=(),
            cwd="/",
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        return sorted(done.stdout.splitlines())

    # -xdev: the root filesystem, whose mount points are listed but not entered.
    assert writable_as_engine("/", "-xdev", "-maxdepth", "3") == ["/tmp"]
    assert (
        writable_as_engine("/var/tmp", "/usr/local", "/opt", "/etc", "-xdev", "-maxdepth", "2")
        == []
    )
    # The other tmpfs: its own contents are root's.
    assert writable_as_engine("/run", "-maxdepth", "0") == []
    assert writable_as_engine("/tmp", "-maxdepth", "0") == ["/tmp"]
