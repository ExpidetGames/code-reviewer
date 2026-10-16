# SPDX-License-Identifier: Apache-2.0

"""Asking the job loop whether the job is still ours (#260).

A Dynamic job process writes the summary comment itself, but it holds neither the lease token nor
the runner token: the job loop does, and it beats the heart. Right before the write the process asks
the loop over one descriptor the launcher handed it (a socket pair, `RUNNER_LEASE_CHECK_FD`). The
question is the line `check`, the answer one line: `held`, `lost` or `unconfirmed`.

Only `held` allows the write. The check is made right before the write and cannot close the window
between the check and the write itself (the app is the authority and rejects a stale result by the
lease token, but the comment is outside its reach); it closes the window of a whole review.
"""

import os
import socket
import time
from collections.abc import Callable, Mapping
from enum import StrEnum

LEASE_CHECK_FD_VARIABLE = "RUNNER_LEASE_CHECK_FD"
QUESTION = b"check\n"
# A request to the app has a timeout of 30 seconds; the process waits a little longer than that.
ANSWER_SECONDS = 45.0
_MAX_ANSWER_BYTES = 32


class LeaseState(StrEnum):
    # The app still has the job running for this lease.
    HELD = "held"
    # The app says the job is not ours: the lease was lost, or the job was cancelled or finished.
    LOST = "lost"
    # A newer push replaced this run (#396): the answer of the app, or what the job host learned
    # from it
    # already. The job is still held, but it must write nothing.
    SUPERSEDED = "superseded"
    # No answer: the app could not be reached, or the loop did not answer in time.
    UNCONFIRMED = "unconfirmed"


LeaseCheck = Callable[[], LeaseState]


def _read_line(channel: socket.socket) -> bytes:
    """The answer up to its newline (without it). A longer line, or a channel that ends first, is
    an error: only a complete, short answer counts."""
    answer = bytearray()
    deadline = time.monotonic() + ANSWER_SECONDS
    while len(answer) <= _MAX_ANSWER_BYTES:
        # One budget for the whole answer, however slowly its bytes come.
        channel.settimeout(max(deadline - time.monotonic(), 0.001))
        byte = channel.recv(1)
        if not byte:
            raise ValueError("the channel ended before the answer did")
        if byte == b"\n":
            return bytes(answer)
        answer += byte
    raise ValueError("the answer is longer than any answer")


def lease_check_from_environment(
    environment: Mapping[str, str], *, required: bool = False
) -> LeaseCheck | None:
    """The check over the descriptor the loop named, or None for a process started without one.

    A descriptor that is named but unusable is a loop that wanted the check: it never allows. So
    does a missing one when the caller `required` it (a Dynamic job is only ever started by the
    loop, which always hands the descriptor over).
    """
    raw = environment.get(LEASE_CHECK_FD_VARIABLE)
    if raw is None:
        return (lambda: LeaseState.UNCONFIRMED) if required else None
    try:
        # Not inherited by anything this process starts (the engine must never hold it).
        os.set_inheritable(int(raw), False)
        channel = socket.socket(fileno=int(raw))
    except (OSError, ValueError):
        return lambda: LeaseState.UNCONFIRMED

    def check() -> LeaseState:
        try:
            channel.settimeout(ANSWER_SECONDS)
            channel.sendall(QUESTION)
            return LeaseState(_read_line(channel).decode("ascii"))
        except (OSError, ValueError):
            return LeaseState.UNCONFIRMED

    return check
