# SPDX-License-Identifier: LicenseRef-Proprietary

"""No execve gives back NET_ADMIN or SETPCAP: file capabilities, setuid (#250, #249).

After the startup step the bounding set of every process of the container no longer holds
`NET_ADMIN` and `SETPCAP`. The bounding set caps what an `execve` can grant: the permitted set of
the new program is `(inheritable & file inheritable) | (file permitted & bounding)`, so neither a
file capability nor a setuid root binary can bring the two back, for root and for anybody else.
`no-new-privileges` would stop a gain as well, which is exactly why this phase runs WITHOUT it
(`scripts/run_privileged_offline.sh`): the bounding set is what is under test, as the second line of
defence. The probes are copies of `cat` that the script prepares before the drop on a tmpfs without
`nosuid` and `noexec` (the container's own tmpfs have both, so nothing a job writes could play this
role): one with the file capabilities `cap_net_admin,cap_setpcap+ip`, one with the same plus the
effective flag (which the kernel answers with a refused `execve` when the permitted capabilities are
not all available, a safe outcome too), one setuid root. A job cannot create any of them, it holds
neither `SETFCAP` nor a mount.
"""

import os
import re
import subprocess
from pathlib import Path

import pytest
from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    JOB_CAPABILITIES,
    JOB_GID,
    JOB_UID,
    STARTUP_CAPABILITIES,
)

JOB_SET = sum(1 << number for number in JOB_CAPABILITIES.values())
STARTUP_SET = sum(1 << number for number in STARTUP_CAPABILITIES.values())
SETS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")
WHO = [(0, 0), (JOB_UID, JOB_GID), (ENGINE_UID, ENGINE_GID)]


@pytest.fixture(scope="module")
def probes() -> Path:
    directory = os.environ.get("CR_PROBE_DIR")
    if not directory:
        pytest.fail("CR_PROBE_DIR is not set: use scripts/run_privileged_offline.sh")
    assert "NoNewPrivs:\t0" in Path("/proc/self/status").read_text(), (
        "this phase must run without no-new-privileges, or it would not test the bounding set"
    )
    return Path(directory)


def capability_sets(binary: Path, uid: int, gid: int) -> tuple[dict[str, int], int]:
    """The capability sets and the effective uid a probe has, after `execve` as another user.

    Raises `PermissionError` when the kernel refuses the `execve` itself.
    """
    done = subprocess.run(
        [str(binary), "/proc/self/status"],
        user=uid,
        group=gid,
        extra_groups=(),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    found = {
        name: int(match.group(1), 16)
        for name in SETS
        if (match := re.search(rf"^{name}:\s*([0-9a-f]+)$", done.stdout, re.MULTILINE))
    }
    euid = re.search(r"^Uid:\s*\d+\s+(\d+)", done.stdout, re.MULTILINE)
    assert set(found) == set(SETS) and euid is not None, done.stdout
    return found, int(euid.group(1))


# #249-T05: the probes are what they say, so the tests below are not vacuous.
def test_the_probes_carry_a_file_capability_and_a_setuid_bit(probes: Path) -> None:
    for name, effective in (("cap-cat", False), ("cap-cat-effective", True)):
        capability = os.getxattr(probes / name, "security.capability")
        assert capability, f"{name} has no file capability"
        # vfs_cap_data: magic_etc (revision and the effective flag), then the permitted and
        # inheritable sets as two 32-bit words each; both startup bits are below bit 32.
        assert bool(int.from_bytes(capability[0:4], "little") & 1) is effective
        permitted = int.from_bytes(capability[4:8], "little")
        inheritable = int.from_bytes(capability[8:12], "little")
        assert permitted & STARTUP_SET == STARTUP_SET
        assert inheritable & STARTUP_SET == STARTUP_SET
    assert (probes / "suid-cat").stat().st_mode & 0o4000
    assert (probes / "suid-cat").stat().st_uid == 0


@pytest.mark.parametrize(("uid", "gid"), WHO, ids=["root", "job-user", "engine-user"])
@pytest.mark.parametrize("probe", ["cap-cat", "cap-cat-effective", "suid-cat"])
def test_no_execve_gives_back_net_admin_or_setpcap(
    probes: Path, probe: str, uid: int, gid: int
) -> None:
    try:
        sets, _ = capability_sets(probes / probe, uid, gid)
    except PermissionError:
        # Refused outright: nothing was gained either. Only the effective-flag probe may be.
        assert probe == "cap-cat-effective"
        return

    for name, value in sets.items():
        assert value & STARTUP_SET == 0, f"{probe} as {uid} has NET_ADMIN or SETPCAP in {name}"
        assert value & ~JOB_SET == 0, f"{probe} as {uid} has a capability outside the job set"


# The setuid probe really changed the identity, and the file-capability probe really got
# capabilities: the bounding set is what left them without the two, not the absence of a gain.
def test_the_setuid_probe_does_become_root_and_is_held_to_the_bounding_set(probes: Path) -> None:
    sets, euid = capability_sets(probes / "suid-cat", JOB_UID, JOB_GID)

    assert euid == 0
    assert sets["CapEff"] == JOB_SET
    assert sets["CapBnd"] == JOB_SET


def test_the_file_capability_probe_is_held_to_the_bounding_set(probes: Path) -> None:
    sets, _ = capability_sets(probes / "cap-cat", ENGINE_UID, ENGINE_GID)

    # file permitted (NET_ADMIN, SETPCAP) & bounding (the job set) is empty for a non-root user.
    assert sets["CapPrm"] == 0
    assert sets["CapEff"] == 0
