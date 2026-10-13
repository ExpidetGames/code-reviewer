# SPDX-License-Identifier: Apache-2.0

"""Who a job process is under a root loop (#197): Diff drops to the job user, Dynamic stays root.

The Dynamic runner's loop runs as root (the supervisor of the Dynamic job needs it); a PR-Agent
job must never run as root, so the launcher drops it to the unprivileged job user with no
supplementary group, in a working directory that user owns.
"""

import asyncio
import json
import os
from pathlib import Path

from privileged_support import JOB_GID, JOB_UID, python3

from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher

REPORT = (
    "import json, os; print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), "
    "'groups': os.getgroups(), 'cwd_owner': os.stat('.').st_uid, "
    "'caps': [l.split()[1] for l in open('/proc/self/status') if l.startswith('CapEff')][0]}))"
)


async def report(run_as: tuple[int, int] | None) -> dict[str, object]:
    spec = ProcessSpec(
        argv=(python3(), "-I", "-c", REPORT),
        env={"PATH": "/usr/bin:/bin"},
        stdin=b"",
        run_as=run_as,
    )
    process = await SubprocessLauncher(terminate_grace=1.0).start(spec)
    outcome = await process.wait()
    assert outcome.exit_code == 0, outcome.stderr
    return json.loads(outcome.stdout)


# #197-T04
def test_a_diff_job_process_is_the_job_user_and_a_dynamic_one_is_the_supervisor(
    tmp_path: Path,
) -> None:
    unprivileged = asyncio.run(report((JOB_UID, JOB_GID)))
    supervisor = asyncio.run(report(None))

    assert unprivileged["uid"] == JOB_UID and unprivileged["gid"] == JOB_GID
    assert unprivileged["groups"] == [JOB_GID]
    assert unprivileged["cwd_owner"] == JOB_UID  # it can use its own working directory
    assert unprivileged["caps"] == "0" * 16
    assert supervisor["uid"] == os.geteuid() == 0
    assert supervisor["cwd_owner"] == 0
