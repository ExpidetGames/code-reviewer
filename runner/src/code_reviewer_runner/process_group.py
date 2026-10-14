# SPDX-License-Identifier: Apache-2.0

"""Ending a process group without ever signalling a group id that is no longer ours (#202).

A process that leads its own group (`start_new_session=True`) is identified by its pid. Once the
leader is reaped its pid is free again, and when the group is empty an unrelated process may be
given the same number as its own group id: a late `killpg` would end that process. Two rules
prevent it:

* Look at the leader with `waitid(WNOWAIT)`, which reports that it ended but leaves it unreaped.
  `Popen.poll()` and `wait()` reap it, so nothing that only asks "is it still running?" may use
  them.
* End the group while the leader (running or a zombie) still holds its pid, and reap it last. A
  zombie leader keeps the group id reserved, so the group signals of `end_group` cannot reach
  anybody else.
"""

import contextlib
import os
import signal
import subprocess
import time

# How often a leader that was signalled is looked at while waiting for it to end.
_POLL_SECONDS = 0.01
# How long a leader that was sent SIGKILL may take to be reaped (it cannot ignore the signal).
_REAP_SECONDS = 5.0


def has_exited(process: subprocess.Popen[bytes]) -> bool:
    """True once the leader ended (or was reaped elsewhere). Never reaps it."""
    if process.returncode is not None:
        return True
    try:
        return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return True


def exited_with_zero(process: subprocess.Popen[bytes]) -> bool:
    """True when the leader ended by itself with exit status 0. Never reaps it."""
    if process.returncode is not None:
        return process.returncode == 0
    try:
        info = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return False
    return info is not None and info.si_code == os.CLD_EXITED and info.si_status == 0


def wait_for_exit(process: subprocess.Popen[bytes], timeout: float) -> bool:
    """Wait up to `timeout` seconds for the leader to end, without reaping it."""
    end = time.monotonic() + timeout
    while not has_exited(process):
        if time.monotonic() >= end:
            return False
        time.sleep(_POLL_SECONDS)
    return True


def _signal_group(process: subprocess.Popen[bytes], sig: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, sig)


def end_group(process: subprocess.Popen[bytes], grace: float = 5.0) -> None:
    """End the leader's whole group and reap the leader.

    SIGTERM first and SIGKILL after `grace` seconds; a `grace` of 0 sends SIGKILL at once. Does
    nothing when the leader was already reaped: its id may belong to somebody else.
    """
    if process.returncode is not None:
        return
    try:
        os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return
    if grace > 0:
        _signal_group(process, signal.SIGTERM)
    if not wait_for_exit(process, grace):
        _signal_group(process, signal.SIGKILL)
        wait_for_exit(process, _REAP_SECONDS)
    # A helper that ignored SIGTERM goes too; the leader is still unreaped, so the id is still ours.
    _signal_group(process, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=_REAP_SECONDS)
