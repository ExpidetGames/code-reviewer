# SPDX-License-Identifier: Apache-2.0

"""#233: the job loop ends a job's process group only while the leader is still unreaped.

asyncio reaps a subprocess on its own as soon as it exits. A group signal sent after that goes to a
group id that may have been given to an unrelated process; the rules of `process_group.py` (#202)
keep the leader, running or a zombie, until the group is ended. Each test records every group
signal and whether the leader still held its id when it went out.
"""

import asyncio
import os
import signal
import sys
import time
from pathlib import Path

import pytest
from process_support import gone

from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher

pytestmark = pytest.mark.integration

# A leader that starts a helper, tells where it is, and does `tail`.
LEADER = (
    "import pathlib, signal, subprocess, sys, time; "
    "signal.signal(signal.SIGTERM, {term}); "
    "null = subprocess.DEVNULL; "
    "helper = subprocess.Popen(['sleep', '60'], stdin=null, stdout=null, stderr=null); "
    "pathlib.Path(sys.argv[1]).write_text(str(helper.pid)); "
    "{tail}"
)


def spec(directory: Path, *, term: str, tail: str) -> ProcessSpec:
    code = LEADER.format(term=term, tail=tail)
    return ProcessSpec(
        (sys.executable, "-c", code, str(directory / "helper.pid")), {"PATH": os.defpath}, b""
    )


def held(pgid: int) -> bool:
    """True while the leader is still our child (running or a zombie): its id is reserved."""
    try:
        os.waitid(os.P_PID, pgid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return False
    return True


def record_group_signals(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, bool]]:
    real_killpg = os.killpg
    calls: list[tuple[int, bool]] = []

    def killpg(pgid: int, sig: int) -> None:
        calls.append((sig, held(pgid)))
        real_killpg(pgid, sig)

    monkeypatch.setattr(os, "killpg", killpg)
    return calls


def wait_for_file(path: Path) -> int:
    end = time.monotonic() + 10
    while time.monotonic() < end:
        if path.exists() and path.read_text():
            return int(path.read_text())
        time.sleep(0.02)
    raise AssertionError(f"{path} never appeared")


# #233-T01
def test_a_leader_that_exited_alone_is_never_signalled_after_it_was_reaped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = record_group_signals(monkeypatch)

    async def go() -> int:
        job = await SubprocessLauncher(1.0).start(
            spec(tmp_path, term="signal.SIG_DFL", tail="sys.exit(0)")
        )
        return (await job.wait()).exit_code

    assert asyncio.run(go()) == 0

    # The helper outlived the leader; the group was ended while the leader still held its id.
    assert gone(wait_for_file(tmp_path / "helper.pid"))
    assert calls and calls[-1][0] == signal.SIGKILL
    assert all(still_ours for _, still_ours in calls)


# #233-T02
@pytest.mark.parametrize("term", ["signal.SIG_DFL", "signal.SIG_IGN"])
def test_a_terminated_job_is_ended_with_its_helper_while_the_leader_is_unreaped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, term: str
) -> None:
    calls = record_group_signals(monkeypatch)

    async def go() -> int:
        job = await SubprocessLauncher(0.3).start(spec(tmp_path, term=term, tail="time.sleep(60)"))
        await asyncio.to_thread(wait_for_file, tmp_path / "helper.pid")
        await job.terminate()
        return (await job.wait()).exit_code

    exit_code = asyncio.run(go())

    assert exit_code == (-signal.SIGKILL if term == "signal.SIG_IGN" else -signal.SIGTERM)
    assert gone(int((tmp_path / "helper.pid").read_text()))
    assert calls[0][0] == signal.SIGTERM
    assert calls[-1][0] == signal.SIGKILL
    assert all(still_ours for _, still_ours in calls)


# #233-T03
def test_terminating_a_job_that_already_ended_signals_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def go() -> list[tuple[int, bool]]:
        job = await SubprocessLauncher(0.3).start(
            spec(tmp_path, term="signal.SIG_DFL", tail="sys.exit(0)")
        )
        await job.wait()
        calls = record_group_signals(monkeypatch)
        await job.terminate()
        return calls

    assert asyncio.run(go()) == []


# #233-T04
def test_a_helper_that_keeps_the_pipes_open_does_not_hold_the_finished_job_up(
    tmp_path: Path,
) -> None:
    holder = (
        "import subprocess, sys; "
        "subprocess.Popen(['sleep', '60']); "
        "print('result', flush=True); sys.exit(0)"
    )

    async def go() -> tuple[int, bytes, float]:
        started = time.monotonic()
        job = await SubprocessLauncher(1.0).start(
            ProcessSpec((sys.executable, "-c", holder), {"PATH": os.defpath}, b"")
        )
        outcome = await job.wait()
        return outcome.exit_code, outcome.stdout, time.monotonic() - started

    exit_code, stdout, seconds = asyncio.run(go())

    assert (exit_code, stdout) == (0, b"result\n")
    assert seconds < 10
