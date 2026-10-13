# SPDX-License-Identifier: Apache-2.0

"""The process-group rules of #202: a group id is only signalled while its leader is not reaped.

A reaped leader frees its pid; once the group is empty an unrelated process may get the same number
as its own group id, and a late `killpg` would end it. The helpers keep the leader (running or a
zombie) until the group is ended, and never signal a leader that was reaped elsewhere.
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from code_reviewer_runner.process_group import end_group, has_exited, wait_for_exit

pytestmark = pytest.mark.integration

LEADER_WITH_HELPER = (
    "import subprocess, sys; "
    "helper = subprocess.Popen(['sleep', '60']); "
    "print(helper.pid, flush=True); "
    "sys.exit({code})"
)


def start_leader(code: int = 0) -> tuple[subprocess.Popen[bytes], int]:
    process = subprocess.Popen(
        [sys.executable, "-c", LEADER_WITH_HELPER.format(code=code)],
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    assert process.stdout is not None
    return process, int(process.stdout.readline())


def gone(pid: int, seconds: float = 5.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.02)
    return False


def test_has_exited_sees_the_end_without_reaping_the_leader() -> None:
    process, helper = start_leader()
    try:
        assert wait_for_exit(process, 5.0)
        assert has_exited(process)
        # Still our child: nothing reaped it, so its id cannot be handed out again.
        assert process.returncode is None
        assert os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    finally:
        end_group(process)
    assert gone(helper)


def test_has_exited_is_false_while_the_leader_runs() -> None:
    process = subprocess.Popen(["sleep", "60"], start_new_session=True)
    try:
        assert not has_exited(process)
        assert not wait_for_exit(process, 0.1)
    finally:
        end_group(process)
    assert process.returncode is not None


def test_end_group_ends_the_helpers_of_a_leader_that_exited_and_then_reaps_it() -> None:
    process, helper = start_leader()
    assert wait_for_exit(process, 5.0)

    end_group(process)

    assert gone(helper)
    assert process.returncode == 0


def test_end_group_ends_a_leader_that_ignores_sigterm(tmp_path: Path) -> None:
    ready = tmp_path / "ready"
    code = (
        "import signal, time, pathlib; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"pathlib.Path({str(ready)!r}).write_text('x'); time.sleep(60)"
    )
    process = subprocess.Popen([sys.executable, "-c", code], start_new_session=True)
    while not ready.exists():
        time.sleep(0.02)

    end_group(process, grace=0.2)

    assert process.returncode == -signal.SIGKILL


def test_end_group_never_signals_a_group_whose_leader_was_reaped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = subprocess.Popen(["true"], start_new_session=True)
    process.wait()
    calls: list[int] = []

    def killpg(pgid: int, sig: int) -> None:
        calls.append(pgid)

    monkeypatch.setattr(os, "killpg", killpg)

    end_group(process)

    assert calls == []


def test_end_group_reaps_the_leader_only_after_the_last_group_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process, helper = start_leader()
    assert wait_for_exit(process, 5.0)
    real_killpg = os.killpg
    unreaped: list[tuple[int, bool]] = []

    def killpg(pgid: int, sig: int) -> None:
        unreaped.append((sig, process.returncode is None and not _is_reaped(process.pid)))
        real_killpg(pgid, sig)

    monkeypatch.setattr(os, "killpg", killpg)

    end_group(process)

    assert gone(helper)
    # Every signal, the final SIGKILL included, went out while the leader still held its id.
    assert unreaped
    assert unreaped[-1][0] == signal.SIGKILL
    assert all(still_ours for _, still_ours in unreaped)


def _is_reaped(pid: int) -> bool:
    try:
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return True
    return False
