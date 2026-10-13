# SPDX-License-Identifier: Apache-2.0
"""Bounded packet framing and explicit shallow/blobless wants; no Git client side effects."""

import re
from collections.abc import Generator
from contextlib import closing

from .limits import Budget, CheckoutError, ObjectUnavailable
from .transport import Transport, packet

_SHA = re.compile(rb"[0-9a-f]{40}")


class Packets:
    def __init__(self, source: Generator[bytes], budget: Budget) -> None:
        self.source = source
        self.budget = budget
        self.pending = bytearray()

    def read(self, count: int) -> bytes:
        while len(self.pending) < count:
            self.budget.check()
            try:
                self.pending.extend(next(self.source))
            except StopIteration:
                raise CheckoutError() from None
        result = bytes(self.pending[:count])
        del self.pending[:count]
        return result

    def packets(self) -> Generator[bytes | None]:
        try:
            while True:
                if not self.pending:
                    try:
                        self.pending.extend(next(self.source))
                    except StopIteration:
                        return
                try:
                    size = int(self.read(4), 16)
                except ValueError:
                    raise CheckoutError() from None
                if size == 0:
                    yield None
                    continue
                if not 4 <= size <= 65520:
                    raise CheckoutError()
                yield self.read(size - 4)
        finally:
            self.source.close()


def advertisement(transport: Transport, budget: Budget) -> tuple[dict[str, str], set[str]]:
    refs: dict[str, str] = {}
    capabilities: set[str] = set()
    total = 0
    with closing(Packets(transport.stream(None, budget), budget).packets()) as lines:
        for line in lines:
            if line is None:
                continue
            total += len(line) + 4
            # Protocol v0 advertises every ref in the repository. A busy repository can
            # advertise many megabytes of refs/pull/*/head, so the advertisement is bounded by
            # the same cumulative preparation envelope as the rest of the transfer (the
            # transport charges the raw bytes) rather than the small per-field response cap.
            if total > budget.limits.preparation_bytes:
                raise CheckoutError()
            if line.startswith(b"# service=git-upload-pack"):
                continue
            record, _, caps = line.rstrip(b"\n").partition(b"\0")
            if caps:
                capabilities.update(caps.decode("ascii").split())
            sha, _, name = record.partition(b" ")
            if not _SHA.fullmatch(sha) or not name:
                raise CheckoutError()
            refs[name.decode("utf-8")] = sha.decode()
    if "side-band-64k" not in capabilities:
        raise CheckoutError()
    return refs, capabilities


def fetch_pack(
    transport: Transport,
    sha: str | tuple[str, ...],
    capabilities: set[str],
    budget: Budget,
    *,
    blobs: bool = False,
) -> bytes:
    shas = (sha,) if isinstance(sha, str) else sha
    if not 1 <= len(shas) <= 32 or any(not _SHA.fullmatch(oid.encode()) for oid in shas):
        raise CheckoutError()
    caps = "side-band-64k"
    if "no-progress" in capabilities:
        caps += " no-progress"
    filtered = "filter" in capabilities and not blobs
    if filtered:
        caps += " filter"
    request = packet(f"want {shas[0]} {caps}\n".encode())
    request += b"".join(packet(f"want {oid}\n".encode()) for oid in shas[1:])
    if not blobs:
        request += packet(b"deepen 1\n")
    if filtered:
        request += packet(b"filter blob:none\n")
    request += b"0000" + packet(b"done\n")
    pack = bytearray()
    with closing(Packets(transport.stream(request, budget), budget).packets()) as lines:
        for line in lines:
            budget.check()
            if line is None or line.startswith((b"shallow ", b"unshallow ", b"NAK", b"ACK ")):
                continue
            if line.startswith(
                (b"ERR upload-pack: not our ref ", b"\x03fatal: git upload-pack: not our ref ")
            ):
                raise ObjectUnavailable()
            if line.startswith(b"\x01"):
                pack.extend(line[1:])
            elif not line.startswith(b"\x02"):
                raise CheckoutError()
    if not pack.startswith(b"PACK"):
        raise CheckoutError()
    return bytes(pack)
