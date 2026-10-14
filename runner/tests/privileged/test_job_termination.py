# SPDX-License-Identifier: Apache-2.0

"""Lease loss, shutdown and timeout end a real job with a real engine user (#197-T07).

The job loop ends a job process with SIGTERM (then SIGKILL after its grace). The engine leads a
process group of its own and runs as another user, so ending only the job process would leave both
behind; the job unwinds on SIGTERM and the backstop kills the engines if that takes too long.
"""

import signal
import subprocess
import sys
import time
from pathlib import Path

from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    Repo,
    free_port,
    listener,
    nft_tables,
    pids_gone,
)

from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch, user_pids
from code_reviewer_runner.dynamic_review.netguard import table_name

JOB_PROCESS = Path(__file__).with_name("job_process.py")


def start_job(job_dir: Path, repo: Repo, tools: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, str(JOB_PROCESS), str(repo.git.path), repo.head, str(tools)],
        cwd=job_dir,
        start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def helper_report(job_dir: Path) -> Path:
    found = list((job_dir / "dynamic").glob("job-*/runtime/scratch/helper.json"))
    return found[0] if found else job_dir / "dynamic" / "no-helper-yet"


def wait_for_helper(job_dir: Path, job: subprocess.Popen[str]) -> Path:
    end = time.monotonic() + 60
    while time.monotonic() < end:
        report = helper_report(job_dir)
        if report.is_file():
            return report
        assert job.poll() is None, job.communicate()
        time.sleep(0.1)
    raise AssertionError("the engine stand-in and its helper did not start")


# #197-T07
def test_sigterm_ends_the_job_its_engine_its_helpers_its_rules_and_its_files(
    repo: Repo, tools: Path, job_dir: Path
) -> None:
    job = start_job(job_dir, repo, tools)
    try:
        wait_for_helper(job_dir, job)
        assert user_pids(ENGINE_UID), "the engine user runs the engine and its helper"
        assert table_name(ENGINE_UID) in nft_tables()

        job.send_signal(signal.SIGTERM)
        job.wait(timeout=20)
    finally:
        if job.poll() is None:
            job.kill()
            job.wait()
        job.communicate()

    # Nothing of the user runs, its rules are gone and the job's files were removed by the unwind.
    assert pids_gone(list(user_pids(ENGINE_UID)))
    assert user_pids(ENGINE_UID) == []
    assert table_name(ENGINE_UID) not in nft_tables()
    assert not list((job_dir / "dynamic").glob("job-*"))


# #197-T07
def test_a_job_killed_without_a_chance_to_clean_up_leaves_processes_the_next_job_clears(
    repo: Repo, tools: Path, job_dir: Path
) -> None:
    job = start_job(job_dir, repo, tools)
    try:
        wait_for_helper(job_dir, job)
        job.send_signal(signal.SIGKILL)  # no handler runs: what an OOM kill leaves behind
        job.wait(timeout=10)
        leftover = user_pids(ENGINE_UID)
        assert leftover, "a killed job leaves its engine user's processes behind"
    finally:
        job.communicate()

    # The next job on this user clears them before anything else (the first confine).
    launch = EngineLaunch(
        uid=ENGINE_UID,
        gid=ENGINE_GID,
        home=str(job_dir),
        tmpdir=str(job_dir),
        config_dir=job_dir,
    )
    with listener() as proxy:
        launch.confine(proxy, free_port())
    launch.close()
    assert pids_gone(leftover)
