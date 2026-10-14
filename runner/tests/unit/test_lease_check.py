# SPDX-License-Identifier: Apache-2.0

"""The process's side of the lease question (#260): only a clear `held` allows the write."""

import socket

import pytest

from code_reviewer_runner.lease_check import (
    LEASE_CHECK_FD_VARIABLE,
    LeaseState,
    lease_check_from_environment,
)


def asking(answer: bytes | None) -> LeaseState:
    """Ask once; the loop's end answers `answer` (None: closes without an answer)."""
    process_end, loop_end = socket.socketpair()
    with loop_end:
        check = lease_check_from_environment({LEASE_CHECK_FD_VARIABLE: str(process_end.detach())})
        assert check is not None
        if answer is None:
            loop_end.close()
        else:
            loop_end.sendall(answer)
        return check()


def test_a_process_started_without_a_channel_has_no_check() -> None:
    assert lease_check_from_environment({}) is None


@pytest.mark.parametrize(
    ("answer", "state"),
    [
        (b"held\n", LeaseState.HELD),
        (b"lost\n", LeaseState.LOST),
        (b"unconfirmed\n", LeaseState.UNCONFIRMED),
        # Everything that is not a clear answer is no permission.
        (b"\n", LeaseState.UNCONFIRMED),
        (b"HELD!\n", LeaseState.UNCONFIRMED),
        (b"yes\n", LeaseState.UNCONFIRMED),
        (None, LeaseState.UNCONFIRMED),
    ],
)
def test_only_a_clear_answer_is_taken_for_one(answer: bytes | None, state: LeaseState) -> None:
    assert asking(answer) is state


@pytest.mark.parametrize("descriptor", ["not-a-number", "-1", "999999"])
def test_a_channel_that_is_named_but_unusable_never_allows(descriptor: str) -> None:
    check = lease_check_from_environment({LEASE_CHECK_FD_VARIABLE: descriptor})

    assert check is not None
    assert check() is LeaseState.UNCONFIRMED
