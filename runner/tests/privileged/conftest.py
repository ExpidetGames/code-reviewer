# SPDX-License-Identifier: Apache-2.0

"""Fixtures of the privileged suite (#197): the production capability set, users and a job.

The suite proves what only root can: the setuid launch, the per-user network rules, the kill of a
user's leftovers and the cleanup of a tree the engine user filled. It must run as root with exactly
the capabilities of `compose.dynamic.yml` (`scripts/run_privileged_offline.sh` arranges that, in a
network namespace with nothing but loopback); anything else is a failure with the fix, never a skip.
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
    JOB_UID,
    PRODUCTION_CAPABILITIES,
    STRANGER_UID,
    Repo,
)

from code_reviewer_runner.dynamic_review.supervisor import ENGINE_GID_VARIABLE, ENGINE_UID_VARIABLE
from code_reviewer_runner.job_loop.process import JOB_WORKDIR_PREFIX

HERE = Path(__file__).resolve().parent


@pytest.fixture(scope="session", autouse=True)
def the_production_privileges() -> None:
    if os.geteuid() != 0:
        pytest.fail(
            "the privileged suite runs as root: use scripts/run_privileged_offline.sh "
            "(it needs passwordless sudo and is meant for CI)"
        )
    status = Path("/proc/self/status").read_text()
    effective = re.search(r"^CapEff:\s*([0-9a-f]+)$", status, re.MULTILINE)
    expected = sum(1 << number for number in PRODUCTION_CAPABILITIES.values())
    if effective is None or int(effective.group(1), 16) != expected:
        pytest.fail(
            f"the suite must run with exactly the capabilities of compose.dynamic.yml "
            f"({', '.join(PRODUCTION_CAPABILITIES)}); got CapEff "
            f"{effective.group(1) if effective else 'unknown'}, wanted {expected:x}"
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
