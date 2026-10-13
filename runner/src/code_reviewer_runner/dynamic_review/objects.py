# SPDX-License-Identifier: Apache-2.0
"""Verify and expand upload-pack objects under hard cumulative bounds.

Git index-pack is deliberately not invoked: its expansion precedes post-fetch quota checks.
No checkout, filters, textconv, submodules, LFS, hooks or promisor remotes exist here.
"""

import hashlib
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

from .limits import Budget, CheckoutError, ObjectUnavailable

_TYPES = {1: "commit", 2: "tree", 3: "blob", 4: "tag"}


@dataclass(frozen=True)
class Object:
    kind: str
    path: Path
    size: int


class ObjectStore:
    def __init__(self, path: Path, budget: Budget) -> None:
        self.path = path
        self.budget = budget
        self.objects: dict[str, Object] = {}
        budget.charge(4096)
        path.mkdir(mode=0o700)

    def put(self, kind: str, raw: bytes) -> str:
        oid = hashlib.sha1(f"{kind} {len(raw)}\0".encode() + raw).hexdigest()
        if oid not in self.objects:
            # Include file allocation rounding in the disk envelope, before the write.
            self.budget.charge((4096 - len(raw) % 4096) % 4096)
            path = self.path / oid
            path.write_bytes(raw)
            self.objects[oid] = Object(kind, path, len(raw))
        return oid

    def read(self, oid: str, kind: str) -> bytes:
        self.budget.check()
        obj = self.objects.get(oid)
        if obj is None:
            raise ObjectUnavailable()
        if obj.kind != kind:
            raise CheckoutError()
        return obj.path.read_bytes()

    def unpack(self, pack: bytes) -> None:
        self.budget.check()
        if len(pack) < 32 or pack[:4] != b"PACK" or hashlib.sha1(pack[:-20]).digest() != pack[-20:]:
            raise CheckoutError()
        version, count = struct.unpack(">II", pack[4:12])
        if version not in (2, 3) or count > self.budget.limits.entries * 4:
            raise CheckoutError()
        position = 12
        offsets: dict[int, str] = {}
        pending: list[tuple[int, str | int, bytes]] = []
        for _ in range(count):
            self.budget.check()
            start = position
            byte, position = _byte(pack, position)
            kind = (byte >> 4) & 7
            size = byte & 15
            shift = 4
            while byte & 128:
                byte, position = _byte(pack, position)
                size |= (byte & 127) << shift
                shift += 7
                if shift > 63:
                    raise CheckoutError()
            if size > self.budget.limits.preparation_bytes - self.budget.preparation:
                raise CheckoutError()
            base: str | int = ""
            if kind == 6:
                byte, position = _byte(pack, position)
                offset = byte & 127
                while byte & 128:
                    byte, position = _byte(pack, position)
                    offset = ((offset + 1) << 7) | (byte & 127)
                    if offset > start:
                        raise CheckoutError()
                base = start - offset
            elif kind == 7:
                base = pack[position : position + 20].hex()
                position += 20
            elif kind not in _TYPES:
                raise CheckoutError()
            raw, position = self._inflate(pack, position, size)
            if kind in _TYPES:
                offsets[start] = self.put(_TYPES[kind], raw)
            else:
                pending.append((start, base, raw))
        if position != len(pack) - 20:
            raise CheckoutError()
        # The server can send REF_DELTA bases later in the pack. Resolve bounded chains.
        for _ in range(64):
            if not pending:
                return
            next_pending: list[tuple[int, str | int, bytes]] = []
            for start, base, delta in pending:
                self.budget.check()
                oid = offsets.get(base) if isinstance(base, int) else base
                obj = self.objects.get(oid or "")
                if obj is None:
                    next_pending.append((start, base, delta))
                    continue
                raw = self._delta(obj.path.read_bytes(), delta)
                offsets[start] = self.put(obj.kind, raw)
            if len(next_pending) == len(pending):
                raise CheckoutError()
            pending = next_pending
        if pending:
            raise CheckoutError()

    def _inflate(self, pack: bytes, position: int, size: int) -> tuple[bytes, int]:
        decoder = zlib.decompressobj()
        raw = bytearray()
        try:
            while not decoder.eof:
                self.budget.check()
                chunk = pack[position : min(position + 16 * 1024, len(pack) - 20)]
                if not chunk:
                    raise CheckoutError()
                inflated = decoder.decompress(chunk, min(64 * 1024, size - len(raw) + 1))
                # At end of stream the trailing bytes of `chunk` appear in both `unused_data`
                # and (when max_length stopped output exactly at the stream end) in
                # `unconsumed_tail`; subtracting both double-counts them and lands `position`
                # before the next object header. `unused_data` alone is authoritative then.
                consumed = (
                    len(chunk) - len(decoder.unused_data)
                    if decoder.eof
                    else len(chunk) - len(decoder.unconsumed_tail)
                )
                position += consumed
                self.budget.charge(len(inflated))
                raw.extend(inflated)
                if len(raw) > size:
                    raise CheckoutError()
        except zlib.error:
            raise CheckoutError() from None
        if len(raw) != size:
            raise CheckoutError()
        return bytes(raw), position

    def _delta(self, base: bytes, delta: bytes) -> bytes:
        base_size, position = _varint(delta, 0)
        size, position = _varint(delta, position)
        if (
            base_size != len(base)
            or size > self.budget.limits.preparation_bytes - self.budget.preparation
        ):
            raise CheckoutError()
        self.budget.charge(size)
        result = bytearray()
        while position < len(delta):
            self.budget.check()
            command, position = _byte(delta, position)
            if command & 128:
                offset = 0
                length = 0
                for i in range(4):
                    if command & (1 << i):
                        byte, position = _byte(delta, position)
                        offset |= byte << (8 * i)
                for i in range(3):
                    if command & (1 << (4 + i)):
                        byte, position = _byte(delta, position)
                        length |= byte << (8 * i)
                length = length or 0x10000
                if offset + length > len(base) or len(result) + length > size:
                    raise CheckoutError()
                result.extend(base[offset : offset + length])
            elif command and position + command <= len(delta):
                if len(result) + command > size:
                    raise CheckoutError()
                result.extend(delta[position : position + command])
                position += command
            else:
                raise CheckoutError()
        if len(result) != size:
            raise CheckoutError()
        return bytes(result)


def _byte(raw: bytes, position: int) -> tuple[int, int]:
    if position >= len(raw):
        raise CheckoutError()
    return raw[position], position + 1


def _varint(raw: bytes, position: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        byte, position = _byte(raw, position)
        value |= (byte & 127) << shift
        shift += 7
        if shift > 63:
            raise CheckoutError()
        if not byte & 128:
            return value, position
