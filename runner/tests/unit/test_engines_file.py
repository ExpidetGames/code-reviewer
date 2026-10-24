# SPDX-License-Identifier: LicenseRef-Proprietary

"""The file that holds the engines a container advertised (#324).

The startup of every entry mode writes the verdict of its self-check to a file on the `/run`
tmpfs that only root can read, so that whatever starts Workers in the same container (the
launchers of #334) can read the result of the init self-check instead of repeating it. The file is
the verdict and nothing else: engines and stable reasons, no value of the environment.
"""

import json
import logging
import os
import stat
from pathlib import Path

import pytest

from code_reviewer_runner.engines_file import (
    ENGINES_FILE,
    filesystem_type,
    remove_engines_file,
    write_engines_file,
)
from code_reviewer_runner.verdict import Verdict

BOTH = Verdict(("pr-agent", "opencode"))
DIFF_ONLY = Verdict(("pr-agent",), ("network_rules_not_installed",))

MOUNTINFO = (
    "22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/x\n"
    "30 22 0:25 / /run rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=1024k\n"
    "31 22 0:26 / /tmp rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=524288k\n"
    "32 22 0:27 / /home/runner rw - tmpfs tmpfs rw\n"
    "33 22 0:28 / /srv/with\\040space rw - ext4 /dev/vda rw\n"
)
OVERLAY_ONLY = "22 1 0:21 / / rw,relatime - overlay overlay rw\n"


def as_root() -> int:
    return 0


def as_user() -> int:
    return 1000


def on_overlay() -> str:
    return OVERLAY_ONLY


@pytest.fixture
def target(tmp_path: Path) -> Path:
    # Stands for /run; the mount table the tests hand in says which directory is a tmpfs.
    return tmp_path / "engines.json"


def tmpfs_at(directory: Path) -> str:
    return f"30 22 0:25 / {directory} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1024k\n"


# #324-T06
def test_the_file_is_readable_by_its_owner_only_and_holds_the_verdict(target: Path) -> None:
    skipped = write_engines_file(
        BOTH, target, euid=as_root, mountinfo=lambda: tmpfs_at(target.parent)
    )

    assert skipped is None
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert json.loads(target.read_text(encoding="utf-8")) == {
        "version": 1,
        "engines": ["pr-agent", "opencode"],
        "reasons": [],
    }
    # No temporary file stays next to it.
    assert [entry.name for entry in target.parent.iterdir()] == [target.name]


# #324-T06
def test_the_file_is_not_written_unless_the_directory_is_a_tmpfs(
    target: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="code_reviewer_runner.loop"):
        skipped = write_engines_file(BOTH, target, euid=as_root, mountinfo=on_overlay)

    # A verdict on a disk filesystem would outlive the container start that produced it.
    assert skipped == "not_on_tmpfs"
    assert not target.exists()
    assert "not_on_tmpfs" in caplog.text


# #324-T06
def test_the_file_is_not_written_by_a_process_that_is_not_root(target: Path) -> None:
    skipped = write_engines_file(
        BOTH, target, euid=as_user, mountinfo=lambda: tmpfs_at(target.parent)
    )

    assert skipped == "not_root"
    assert not target.exists()


# #324-T06
def test_every_start_rewrites_the_file_and_never_keeps_an_older_verdict(target: Path) -> None:
    def where() -> str:
        return tmpfs_at(target.parent)

    write_engines_file(BOTH, target, euid=as_root, mountinfo=where)

    write_engines_file(DIFF_ONLY, target, euid=as_root, mountinfo=where)

    document = json.loads(target.read_text(encoding="utf-8"))
    assert document["engines"] == ["pr-agent"]
    assert document["reasons"] == ["network_rules_not_installed"]
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


# #324-T06
def test_the_file_of_an_earlier_start_is_removed_when_this_start_does_not_write_one(
    target: Path,
) -> None:
    target.write_text("{}", encoding="utf-8")

    remove_engines_file(target)
    remove_engines_file(target)  # nothing left to remove is not an error

    assert not target.exists()


# #324-T06
def test_a_link_planted_at_the_path_is_replaced_and_never_followed(
    target: Path, tmp_path: Path
) -> None:
    victim = tmp_path / "victim"
    victim.write_text("keep", encoding="utf-8")
    target.symlink_to(victim)

    write_engines_file(BOTH, target, euid=as_root, mountinfo=lambda: tmpfs_at(target.parent))

    assert victim.read_text(encoding="utf-8") == "keep"
    assert not target.is_symlink()
    assert json.loads(target.read_text(encoding="utf-8"))["engines"] == ["pr-agent", "opencode"]


# #324-T06
def test_a_write_that_fails_is_reported_with_a_stable_reason_and_leaves_no_file(
    tmp_path: Path,
) -> None:
    missing = tmp_path / "no-such-directory" / "engines.json"

    skipped = write_engines_file(
        BOTH, missing, euid=as_root, mountinfo=lambda: tmpfs_at(missing.parent)
    )

    assert skipped == "write_failed"
    assert not missing.exists()


# #324-T06
@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/run/code-reviewer-engines.json", "tmpfs"),
        ("/run", "tmpfs"),
        ("/tmp/job/file", "tmpfs"),
        ("/usr/local/bin/opencode", "overlay"),
        ("/srv/with space/x", "ext4"),
        ("/runner/file", "overlay"),  # /run is a mount point, /runner is not below it
    ],
)
def test_the_filesystem_of_a_path_is_the_one_of_the_deepest_mount_above_it(
    path: str, expected: str
) -> None:
    assert filesystem_type(Path(path), MOUNTINFO) == expected


def test_a_mount_table_that_cannot_be_read_is_no_tmpfs() -> None:
    assert filesystem_type(Path("/run/x"), "") is None
    assert filesystem_type(Path("/run/x"), "garbage\n- - -\n") is None


def test_the_default_location_is_on_the_run_directory() -> None:
    assert ENGINES_FILE.parent == Path("/run")
    assert os.path.isabs(ENGINES_FILE)
