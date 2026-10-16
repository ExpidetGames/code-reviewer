# SPDX-License-Identifier: Apache-2.0

"""The job host tells a real job process that its run was superseded (#396): `SIGUSR1` to the
leader, once, and
never to a process that has ended."""

import asyncio
import sys
from pathlib import Path

import pytest

from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher

pytestmark = pytest.mark.integration

CHILD = """
import signal, sys, time
told = []
signal.signal(signal.SIGUSR1, lambda *_: told.append(1))
sys.stdout.write("ready\\n"); sys.stdout.flush()
deadline = time.monotonic() + 20
while time.monotonic() < deadline and not told:
    time.sleep(0.02)
time.sleep(0.2)
sys.stdout.write("told=%d\\n" % len(told)); sys.stdout.flush()
"""


def spec(code: str) -> ProcessSpec:
    return ProcessSpec(argv=(sys.executable, "-I", "-c", code), env={}, stdin=b"")


# #396-T03
def test_the_leader_of_the_job_process_is_signalled_once_and_ends_by_itself(tmp_path: Path) -> None:
    async def scenario() -> str:
        process = await SubprocessLauncher().start(spec(CHILD))
        await asyncio.sleep(1.0)  # the child has installed its handler
        process.notify_superseded()
        outcome = await asyncio.wait_for(process.wait(), 15)
        assert outcome.exit_code == 0
        return outcome.stdout.decode()

    output = asyncio.run(scenario())

    assert "told=1" in output


# #396-T03
def test_a_process_that_has_ended_is_not_signalled() -> None:
    async def scenario() -> None:
        process = await SubprocessLauncher().start(spec("print('done')"))
        await asyncio.wait_for(process.wait(), 15)
        process.notify_superseded()  # nothing to signal, and no error

    asyncio.run(scenario())
