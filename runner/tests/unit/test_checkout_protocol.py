# SPDX-License-Identifier: LicenseRef-Proprietary
"""Bounded smart HTTP framing: large ref advertisements stay within the preparation envelope."""

from collections.abc import Generator

import pytest

from code_reviewer_runner.dynamic_review.limits import Budget, CheckoutError, Limits
from code_reviewer_runner.dynamic_review.protocol import advertisement, fetch_pack
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


class Recording:
    """Answers every fetch with an empty pack and keeps the request it was sent."""

    def __init__(self) -> None:
        self.requests: list[bytes] = []

    def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
        assert request is not None
        self.requests.append(request)
        import hashlib
        import struct

        pack = b"PACK" + struct.pack(">II", 2, 0)
        pack += hashlib.sha1(pack).digest()
        yield packet(b"NAK\n") + packet(b"\x01" + pack) + b"0000"


_CAPABILITIES = {"side-band-64k", "filter"}


def _lines(request: bytes) -> list[str]:
    lines: list[str] = []
    position = 0
    while position < len(request):
        size = int(request[position : position + 4], 16)
        if size == 0:
            position += 4
            continue
        lines.append(request[position + 4 : position + size].decode().rstrip("\n"))
        position += size
    return lines


# #296-T03
def test_a_commit_fetch_asks_the_server_to_leave_out_blobs_above_the_limit() -> None:
    transport = Recording()
    fetch_pack(transport, _SHA, _CAPABILITIES, Budget(Limits()), blob_limit=524_289)
    lines = _lines(transport.requests[0])
    assert "filter blob:limit=524289" in lines
    assert "deepen 1" in lines
    assert "filter blob:none" not in lines
    # Only the commit is wanted: a blob wanted by name would ignore the filter.
    assert [line.split()[0] for line in lines if line.startswith("want ")] == ["want"]


# #296-T03
def test_the_ancestry_walk_stays_commits_only() -> None:
    transport = Recording()
    fetch_pack(transport, _SHA, _CAPABILITIES, Budget(Limits()), history=64)
    lines = _lines(transport.requests[0])
    assert "filter tree:0" in lines and "deepen 64" in lines
    assert not any("blob:" in line for line in lines)


# #296-T03
def test_without_the_filter_capability_no_filter_is_requested() -> None:
    transport = Recording()
    fetch_pack(transport, _SHA, {"side-band-64k"}, Budget(Limits()), blob_limit=100)
    assert not any(line.startswith("filter") for line in _lines(transport.requests[0]))


# #296-T03
@pytest.mark.parametrize("limit", [0, -1])
def test_a_blob_limit_must_be_positive(limit: int) -> None:
    with pytest.raises(CheckoutError):
        fetch_pack(Recording(), _SHA, _CAPABILITIES, Budget(Limits()), blob_limit=limit)
