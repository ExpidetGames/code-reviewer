# SPDX-License-Identifier: LicenseRef-Proprietary

"""#233: the job loop ends a job's process group only while the leader is still unreaped.

asyncio reaps a subprocess on its own as soon as it exits. A group signal sent after that goes to a
group id that may have been given to an unrelated process; the rules of `process_group.py` (#202)
keep the leader, running or a zombie, until the group is ended. Each test records every group
signal and whether the leader still held its id when it went out.
"""

import asyncio
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, cast

import pytest
from process_support import gone

from code_reviewer_runner.job_loop import process as job_process
from code_reviewer_runner.job_loop.process import (
    JOB_WORKDIR_PREFIX,
    ProcessSpec,
    SubprocessLauncher,
)

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
    # The helper sleeps far longer than the drain and far longer than any bound asserted here, so
    # the job can only be fast when the group is ended with the leader.
    holder = (
        "import subprocess, sys; "
        "subprocess.Popen(['sleep', '30']); "
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
    assert seconds < 5


# #233-T05
def test_terminate_and_the_exit_watcher_never_end_the_group_at_the_same_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both would pass the unreaped check; one must not reap before the other signals."""
    real_end_group = job_process.end_group
    state = threading.Lock()
    running = 0
    overlap = 0

    def slow_end_group(process: object, grace: float = 5.0) -> None:
        nonlocal running, overlap
        with state:
            running += 1
            overlap = max(overlap, running)
        # Long enough for the other caller to arrive while this one is inside.
        time.sleep(0.4)
        try:
            real_end_group(process, grace)  # type: ignore[arg-type]
        finally:
            with state:
                running -= 1

    monkeypatch.setattr(job_process, "end_group", slow_end_group)

    async def go() -> None:
        job = await SubprocessLauncher(0.3).start(
            spec(tmp_path, term="signal.SIG_DFL", tail="sys.exit(0)")
        )
        await job.terminate()
        await job.wait()

    asyncio.run(go())

    assert overlap == 1


class _OpenedPipes:
    """Records the Popen objects a launcher start creates."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.processes: list[subprocess.Popen[bytes]] = []
        real_popen = subprocess.Popen
        opened = self.processes

        def popen(*args: Any, **kwargs: Any) -> subprocess.Popen[bytes]:  # Popen's own signature
            process = cast("subprocess.Popen[bytes]", real_popen(*args, **kwargs))
            opened.append(process)
            return process

        monkeypatch.setattr(job_process.subprocess, "Popen", popen)

    def all_closed(self) -> bool:
        return all(
            pipe is not None and pipe.closed
            for process in self.processes
            for pipe in (process.stdin, process.stdout, process.stderr)
        )


# #233-T06
def test_a_start_that_fails_while_connecting_the_pipes_closes_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened = _OpenedPipes(monkeypatch)

    async def broken_writer(*_: object) -> object:
        raise OSError("no stdin pipe")

    monkeypatch.setattr(job_process, "_connect_writer", broken_writer)

    async def go() -> None:
        with pytest.raises(OSError, match="no stdin pipe"):
            await SubprocessLauncher(0.3).start(
                spec(tmp_path, term="signal.SIG_DFL", tail="time.sleep(60)")
            )

    asyncio.run(go())

    assert len(opened.processes) == 1
    assert opened.all_closed()
    assert opened.processes[0].returncode is not None


# #233-T07
def test_the_workdir_is_removed_when_the_start_is_cancelled_twice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_end_group = job_process.end_group
    workdirs: list[Path] = []
    real_mkdtemp = job_process.tempfile.mkdtemp

    def mkdtemp(*, prefix: str) -> str:
        path = real_mkdtemp(prefix=prefix)
        workdirs.append(Path(path))
        return path

    def slow_end_group(process: object, grace: float = 5.0) -> None:
        time.sleep(0.3)  # the second cancellation arrives while the group is being ended
        real_end_group(process, grace)  # type: ignore[arg-type]

    async def hanging_reader(*_: object) -> object:
        await asyncio.Event().wait()

    monkeypatch.setattr(job_process.tempfile, "mkdtemp", mkdtemp)
    monkeypatch.setattr(job_process, "end_group", slow_end_group)
    monkeypatch.setattr(job_process, "_connect_reader", hanging_reader)

    async def go() -> None:
        task = asyncio.create_task(
            SubprocessLauncher(0.3).start(
                spec(tmp_path, term="signal.SIG_DFL", tail="time.sleep(60)")
            )
        )
        await asyncio.sleep(0.2)
        task.cancel()
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(go())

    assert len(workdirs) == 1
    assert workdirs[0].name.startswith(JOB_WORKDIR_PREFIX)
    assert not workdirs[0].exists()
