# SPDX-License-Identifier: Apache-2.0

"""Fixtures of the privileged suite (#197, #244): the production capability set, users and a job.

The suite proves what only root can: the setuid launch, the per-user network rules, the kill of a
user's leftovers and the cleanup of a tree the engine user filled. It runs as root in a network
namespace with nothing but loopback (`scripts/run_privileged_offline.sh` arranges that), in the two
phases of the Dynamic runner's life, selected by `PRIVILEGED_PHASE`:

* `startup` (`tests/privileged/startup`): exactly the capabilities `compose.dynamic.yml` adds,
  including the ones only startup holds (`NET_ADMIN`, `SETPCAP`). The rules and the drop are proven.
* `job`: the process the script started is the Dynamic runner after its startup step, run by the
  production code: static rules installed, `NET_ADMIN` and `SETPCAP` gone from every set and from
  the bounding set. Everything else is proven from there, as a job process would see it.

Anything else is a failure with the fix, never a skip.
"""

import os
import pwd
import re
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    JOB_CAPABILITIES,
    JOB_UID,
    PRODUCTION_CAPABILITIES,
    STRANGER_UID,
    Repo,
)

from code_reviewer_runner.dynamic_review.supervisor import ENGINE_GID_VARIABLE, ENGINE_UID_VARIABLE
from code_reviewer_runner.job_loop.process import JOB_WORKDIR_PREFIX

HERE = Path(__file__).resolve().parent


def _capability_set(status: str, name: str) -> int | None:
    found = re.search(rf"^{name}:\s*([0-9a-f]+)$", status, re.MULTILINE)
    return int(found.group(1), 16) if found else None


@pytest.fixture(scope="session", autouse=True)
def the_production_privileges() -> None:
    if os.geteuid() != 0:
        pytest.fail(
            "the privileged suite runs as root: use scripts/run_privileged_offline.sh "
            "(it needs passwordless sudo and is meant for CI)"
        )
    phase = os.environ.get("PRIVILEGED_PHASE")
    if phase not in ("startup", "job"):
        pytest.fail(
            "PRIVILEGED_PHASE must be startup or job: use scripts/run_privileged_offline.sh"
        )
    held = PRODUCTION_CAPABILITIES if phase == "startup" else JOB_CAPABILITIES
    expected = sum(1 << number for number in held.values())
    status = Path("/proc/self/status").read_text()
    # The phase's set is exactly what the process can use, can pass on (bounding) and holds
    # permitted: in the job phase the bounding set no longer holds NET_ADMIN or SETPCAP either.
    for name in ("CapEff", "CapPrm", "CapBnd"):
        value = _capability_set(status, name)
        if value != expected:
            pytest.fail(
                f"the {phase} phase must run with exactly the capabilities of "
                f"compose.dynamic.yml ({', '.join(held)}); got {name} "
                f"{'unknown' if value is None else f'{value:x}'}, wanted {expected:x}"
            )
    for uid in (ENGINE_UID, STRANGER_UID, JOB_UID):
        try:
            pwd.getpwuid(uid)
        except KeyError:
            pytest.fail(f"user {uid} does not exist: scripts/run_privileged_offline.sh creates it")


@pytest.fixture(scope="session")
def tools() -> Iterator[Path]:
    """A directory every user can read, holding the stub engine."""
    directory = Path(tempfile.mkdtemp(prefix="cr-privileged-tools-"))
    directory.chmod(0o755)
    stub = directory / "stub_engine.py"
    shutil.copyfile(HERE / "stub_engine.py", stub)
    stub.chmod(0o644)
    yield directory
    shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def job_dir() -> Iterator[Path]:
    """The working directory of a job process: root's, mode 0700, named like the loop names it."""
    directory = Path(tempfile.mkdtemp(prefix=JOB_WORKDIR_PREFIX))
    previous = Path.cwd()
    os.chdir(directory)
    yield directory
    os.chdir(previous)
    shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def environment() -> dict[str, str]:
    return {ENGINE_UID_VARIABLE: str(ENGINE_UID), ENGINE_GID_VARIABLE: str(ENGINE_GID)}


@pytest.fixture
def repo(tmp_path: Path) -> Repo:
    return Repo(
        tmp_path / "base.git",
        {"README.md": b"# demo\n", "src/app.py": b"def handler(user):\n    return query(user)\n"},
        {"src/app.py": b"def handler(user):\n    return query(user)  # changed\n"},
    )
