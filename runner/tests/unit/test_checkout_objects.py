# SPDX-License-Identifier: Apache-2.0
"""Adversarial packs cannot make expansion or delta copying bypass the preparation quota."""

import hashlib
import struct
import zlib
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review.limits import Budget, CheckoutError, Limits
from code_reviewer_runner.dynamic_review.objects import ObjectStore
from code_reviewer_runner.dynamic_review.protocol import Packets


def pack_objects(entries: list[tuple[int, bytes]]) -> bytes:
    body = bytearray()
    for kind, raw in entries:
        size = len(raw)
        header = bytearray([(kind << 4) | (size & 15)])
        size >>= 4
        while size:
            header[-1] |= 128
            header.append(size & 127)
            size >>= 7
        body += bytes(header) + zlib.compress(raw)
    payload = b"PACK" + struct.pack(">II", 2, len(entries)) + bytes(body)
    return payload + hashlib.sha1(payload).digest()


def packed(raw: bytes, kind: int = 3, declared: int | None = None) -> bytes:
    if declared is None:
        return pack_objects([(kind, raw)])
    size = declared
    header = bytearray([(kind << 4) | (size & 15)])
    size >>= 4
    while size:
        header[-1] |= 128
        header.append(size & 127)
        size >>= 7
    payload = b"PACK" + struct.pack(">II", 2, 1) + bytes(header) + zlib.compress(raw)
    return payload + hashlib.sha1(payload).digest()


# #196-T12
def test_pack_expansion_stops_before_an_oversized_declared_object_is_inflated(
    tmp_path: Path,
) -> None:
    store = ObjectStore(tmp_path / "objects", Budget(Limits(preparation_bytes=8192)))
    with pytest.raises(CheckoutError):
        store.unpack(packed(b"x" * 1_000_000))
    assert not store.objects


# #196-T12
@pytest.mark.parametrize("declared", [0, 1, 100])
def test_a_lying_pack_object_size_is_refused(tmp_path: Path, declared: int) -> None:
    store = ObjectStore(tmp_path / "objects", Budget(Limits()))
    with pytest.raises(CheckoutError):
        store.unpack(packed(b"x" * 1000, declared=declared))
    assert not store.objects


# #196-T12
@pytest.mark.parametrize("pack", [b"PACK", packed(b"hello")[:-1] + b"x", packed(b"hello", kind=5)])
def test_malformed_and_corrupt_packs_are_refused(tmp_path: Path, pack: bytes) -> None:
    with pytest.raises(CheckoutError):
        ObjectStore(tmp_path / "objects", Budget(Limits())).unpack(pack)


# #196-T12
@pytest.mark.parametrize("delta", [b"\x01\x80\x80\x04", b"\x01\x01\x91\x02\x01"])
def test_delta_expansion_and_invalid_copy_ranges_are_bounded(tmp_path: Path, delta: bytes) -> None:
    store = ObjectStore(tmp_path / "objects", Budget(Limits(preparation_bytes=12_288)))
    base_pack = packed(b"a")
    store.unpack(base_pack)
    base_oid = hashlib.sha1(b"blob 1\0a").digest()
    payload = b"PACK" + struct.pack(">II", 2, 1) + bytes([(7 << 4) | len(delta)])
    payload += base_oid + zlib.compress(delta)
    with pytest.raises(CheckoutError):
        store.unpack(payload + hashlib.sha1(payload).digest())


# #296-T04
def test_download_is_not_charged_a_second_time_to_the_expansion_budget(tmp_path: Path) -> None:
    # The wire bytes have their own budget: a pack as large as the whole preparation budget can be
    # received and still expand within it.
    budget = Budget(Limits(preparation_bytes=16_384, transfer_bytes=16_384))
    store = ObjectStore(tmp_path / "objects", budget)
    pack = packed(b"x" * 4096)
    budget.charge_transfer(len(pack))
    store.unpack(pack)
    assert budget.transfer == len(pack)
    assert budget.preparation == 4096 + 4096  # the staging directory and the inflated object
    assert len(store.objects) == 1


# #196-T12
def test_expansion_beyond_the_preparation_budget_is_refused(tmp_path: Path) -> None:
    budget = Budget(Limits(preparation_bytes=8192))
    store = ObjectStore(tmp_path / "objects", budget)
    with pytest.raises(CheckoutError):
        store.unpack(packed(b"x" * 4097))
    assert not store.objects


# #196-T04
@pytest.mark.parametrize("stream", [[b"zzzz"], [b"0003"], [b"0008xx"], [b"ffff"]])
def test_invalid_or_incomplete_protocol_frames_are_refused(stream: list[bytes]) -> None:
    with pytest.raises(CheckoutError):
        list(Packets((part for part in stream), Budget(Limits())).packets())


# #196-T12
@pytest.mark.parametrize("kind", ["ref", "ofs", "forward_ref"])
def test_valid_delta_objects_are_verified_and_resolved(tmp_path: Path, kind: str) -> None:
    store = ObjectStore(tmp_path / "objects", Budget(Limits()))
    base = bytes([0x31]) + zlib.compress(b"a")
    delta = b"\x01\x02\x02ab"
    reference = hashlib.sha1(b"blob 1\0a").digest()
    if kind == "ofs":
        assert len(base) < 128
        delta_entry = bytes([0x60 | len(delta), len(base)]) + zlib.compress(delta)
    else:
        delta_entry = bytes([0x70 | len(delta)]) + reference + zlib.compress(delta)
    entries = delta_entry + base if kind == "forward_ref" else base + delta_entry
    payload = b"PACK" + struct.pack(">II", 2, 2) + entries
    store.unpack(payload + hashlib.sha1(payload).digest())
    oid = hashlib.sha1(b"blob 2\0ab").hexdigest()
    assert store.read(oid, "blob") == b"ab"


# #196-T01 #196-T12
@pytest.mark.parametrize("size", [65_537, 66_000, 100_000, 262_144])
def test_an_object_over_one_inflate_window_keeps_the_next_object_header_aligned(
    tmp_path: Path, size: int
) -> None:
    # A real GitHub pack has many objects, so a blob larger than the 64 KiB inflate window
    # leaves trailing bytes in the same chunk as the next object header.
    entries = [(3, b"before\n"), (3, b"a" * size), (3, b"after\n")]
    store = ObjectStore(tmp_path / "objects", Budget(Limits()))
    store.unpack(pack_objects(entries))
    for _kind, raw in entries:
        oid = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
        assert store.read(oid, "blob") == raw
