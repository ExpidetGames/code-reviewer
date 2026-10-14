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
    # No answer: the app could not be reached, or the loop did not answer in time.
    UNCONFIRMED = "unconfirmed"


LeaseCheck = Callable[[], LeaseState]


def lease_check_from_environment(environment: Mapping[str, str]) -> LeaseCheck | None:
    """The check over the descriptor the loop named, or None for a process started without one.

    A descriptor that is named but unusable is a loop that wanted the check: it never allows.
    """
    raw = environment.get(LEASE_CHECK_FD_VARIABLE)
    if raw is None:
        return None
    try:
        # Not inherited by anything this process starts (the engine must never hold it).
        os.set_inheritable(int(raw), False)
        channel = socket.socket(fileno=int(raw))
    except (OSError, ValueError):
        return lambda: LeaseState.UNCONFIRMED
    channel.settimeout(ANSWER_SECONDS)

    def check() -> LeaseState:
        try:
            channel.sendall(QUESTION)
            answer = channel.recv(_MAX_ANSWER_BYTES).strip()
            return LeaseState(answer.decode("ascii"))
        except (OSError, ValueError):
            return LeaseState.UNCONFIRMED

    return check
