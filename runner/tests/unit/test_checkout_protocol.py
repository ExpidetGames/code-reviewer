# SPDX-License-Identifier: Apache-2.0
"""Bounded smart HTTP framing: large ref advertisements stay within the preparation envelope."""

from collections.abc import Generator

import pytest

from code_reviewer_runner.dynamic_review.limits import Budget, CheckoutError, Limits
from code_reviewer_runner.dynamic_review.protocol import advertisement
from code_reviewer_runner.dynamic_review.transport import packet

_SHA = "a" * 40


def _advertisement(refs: int) -> bytes:
    lines = [packet(b"# service=git-upload-pack\n"), b"0000"]
    lines.append(packet(f"{_SHA} refs/pull/1/head\x00side-band-64k\n".encode()))
    lines.extend(
        packet(f"{_SHA} refs/pull/{number}/head\n".encode()) for number in range(2, refs + 2)
    )
    lines.append(b"0000")
    return b"".join(lines)


class OneShot:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
        budget.charge_transfer(len(self.data))
        yield self.data


# #196-T01 #196-T04
def test_a_large_ref_advertisement_is_bounded_by_the_transfer_budget() -> None:
    data = _advertisement(20_000)
    assert len(data) > Limits().response_bytes
    refs, capabilities = advertisement(OneShot(data), Budget(Limits()))
    assert refs["refs/pull/1/head"] == _SHA
    assert len(refs) == 20_001
    assert "side-band-64k" in capabilities


# #196-T04
def test_an_advertisement_beyond_the_transfer_budget_is_refused() -> None:
    data = _advertisement(20_000)

    class Uncharged:
        def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
            yield data

    with pytest.raises(CheckoutError):
        advertisement(Uncharged(), Budget(Limits(transfer_bytes=len(data) // 2)))
