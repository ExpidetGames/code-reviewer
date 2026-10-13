# SPDX-License-Identifier: Apache-2.0
"""Progressing HTTP headers must not extend the absolute preparation deadline."""

import io
from collections.abc import Buffer
from typing import BinaryIO, cast

import pytest

from code_reviewer_runner.dynamic_review.limits import Budget, CheckoutError, Limits

# Exercise the internal HTTP input boundary without a socket or wall-clock sleeps.
from code_reviewer_runner.dynamic_review.transport import _BudgetReader  # pyright: ignore[reportPrivateUsage]


# #196-T08 #196-T12
def test_a_dribbling_header_stops_at_the_absolute_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    now = 0.0
    reads = 0
    monkeypatch.setattr("code_reviewer_runner.dynamic_review.limits.time.monotonic", lambda: now)

    class DribblingInput(io.RawIOBase):
        def readable(self) -> bool:
            return True

        def readinto(self, buffer: Buffer, /) -> int:
            nonlocal now, reads
            reads += 1
            now += 1
            memoryview(buffer)[0] = ord("x")
            return 1

    with io.BufferedReader(DribblingInput()) as stream:
        reader = _BudgetReader(cast(BinaryIO, stream), Budget(Limits(seconds=2)))
        with pytest.raises(CheckoutError, match="timeout"):
            reader.readline(65_537)
    assert reads <= 2
