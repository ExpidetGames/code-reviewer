# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job host tells a real job process that its run was superseded (#396): `SIGUSR1` to the
leader, once, and never to a process that has ended. A signal that comes before the process has
its handler is held, not fatal."""

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
# The host starts the process with the signal blocked; it unblocks it once it has a handler.
signal.pthread_sigmask(signal.SIG_UNBLOCK, [signal.SIGUSR1])
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


# A job process that is slow to start: the host tells it at once, a second before the handler
# exists. It reports whether it started with the signal blocked and whether the signal waited.
LATE_HANDLER = """
import signal, sys, time
blocked = signal.SIGUSR1 in signal.pthread_sigmask(signal.SIG_BLOCK, [])
sys.stdout.write("ready\\n"); sys.stdout.flush()
time.sleep(1.0)
pending = signal.SIGUSR1 in signal.sigpending()
from code_reviewer_runner.supersede import PROCESS_SIGNAL, handling_the_signal
with handling_the_signal():
    time.sleep(0.2)
    told = PROCESS_SIGNAL.is_set()
    sys.stdout.write("blocked=%s pending=%s told=%s\\n" % (blocked, pending, told))
"""


# #396-T03
def test_a_signal_before_the_handler_exists_is_held_and_delivered_when_it_does() -> None:
    async def scenario() -> tuple[int, str]:
        process = await SubprocessLauncher().start(spec(LATE_HANDLER))
        process.notify_superseded()  # at once: the child is still starting
        outcome = await asyncio.wait_for(process.wait(), 20)
        return outcome.exit_code, outcome.stdout.decode()

    exit_code, output = asyncio.run(scenario())

    assert exit_code == 0, output  # the default action would have ended it with -SIGUSR1
    assert "blocked=True pending=True told=True" in output


# #396-T03
def test_the_loop_itself_keeps_its_signal_mask_after_it_started_a_process() -> None:
    import signal

    async def scenario() -> None:
        before = signal.pthread_sigmask(signal.SIG_BLOCK, [])
        process = await SubprocessLauncher().start(spec("print('done')"))
        await asyncio.wait_for(process.wait(), 15)
        assert signal.pthread_sigmask(signal.SIG_BLOCK, []) == before
        assert signal.SIGUSR1 not in before

    asyncio.run(scenario())


# #396-T03
def test_notify_superseded_says_whether_the_signal_was_sent() -> None:
    async def scenario() -> tuple[bool, bool]:
        running = await SubprocessLauncher().start(spec(CHILD))
        await asyncio.sleep(1.0)
        sent = running.notify_superseded()
        await asyncio.wait_for(running.wait(), 15)
        ended = await SubprocessLauncher().start(spec("print('done')"))
        await asyncio.wait_for(ended.wait(), 15)
        return sent, ended.notify_superseded()

    sent, after_the_end = asyncio.run(scenario())

    assert sent is True
    assert after_the_end is False
