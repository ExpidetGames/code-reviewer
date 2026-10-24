# SPDX-License-Identifier: LicenseRef-Proprietary
"""Credential-private Git smart HTTP v0, and an offline file:// upload-pack seam.

No credential subprocess, token URL, inherited proxy/config or implicit lazy fetch. The
installation credential is held only by the trusted HTTP client, never written to disk.
"""

import base64
import http.client
import io
import os
import re
import select
import socket
import subprocess
from collections.abc import Generator
from pathlib import Path
from typing import BinaryIO, Protocol, cast
from urllib.parse import urlsplit

from code_reviewer_runner.process_group import end_group, exited_with_zero, wait_for_exit
from code_reviewer_runner.result import ErrorCode

from .limits import Budget, CheckoutError, CheckoutReason


class Transport(Protocol):
    def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]: ...


def packet(data: bytes) -> bytes:
    if len(data) > 65516:
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    return f"{len(data) + 4:04x}".encode() + data


class _BudgetReader(io.BufferedIOBase):
    """Bound the raw HTTP input, including status, headers and chunk framing."""

    def __init__(self, stream: BinaryIO, budget: Budget, sock: socket.socket | None = None) -> None:
        self.stream = stream
        self.sock = sock
        self.budget = budget
        self.headers = True
        self.header_bytes = 0
        super().__init__()

    def _size(self, size: int) -> int:
        self.budget.check()
        if self.sock is not None:
            self.sock.settimeout(self.budget.remaining())
        available = self.budget.limits.transfer_bytes - self.budget.transfer
        if self.headers:
            available = min(available, self.budget.limits.response_bytes - self.header_bytes)
        if available <= 0:
            raise CheckoutError(CheckoutReason.BUDGET_TRANSFER)
        return min(available, size if size >= 0 else 16 * 1024)

    def _charge(self, data: bytes) -> bytes:
        self.budget.charge_transfer(len(data))
        if self.headers:
            self.header_bytes += len(data)
        return data

    def readline(self, size: int | None = -1, /) -> bytes:
        if size == 0:
            return b""
        bound = self._size(-1 if size is None else size)
        line = bytearray()
        # Buffered readline can reset an idle timeout indefinitely while a peer dribbles.
        # Read one available byte at a time so every step checks the absolute deadline.
        while len(line) < bound:
            self._size(1)
            chunk = self._charge(cast(io.BufferedReader, self.stream).read1(1))
            if not chunk:
                break
            line.extend(chunk)
            if chunk == b"\n":
                return bytes(line)
        if len(line) == bound:
            raise CheckoutError(CheckoutReason.BUDGET_TRANSFER)
        return bytes(line)

    def read(self, size: int | None = -1, /) -> bytes:
        if size == 0:
            return b""
        wanted = -1 if size is None else size
        result = bytearray()
        # HTTP chunk terminators also use fixed-length reads; progressing partial input
        # must not reset the deadline while BufferedReader waits to fill the request.
        while wanted < 0 or len(result) < wanted:
            request = 16 * 1024 if wanted < 0 else min(16 * 1024, wanted - len(result))
            chunk = self._charge(cast(io.BufferedReader, self.stream).read1(self._size(request)))
            if not chunk:
                break
            result.extend(chunk)
        return bytes(result)

    def read1(self, size: int = -1, /) -> bytes:
        # HTTPResponse's underlying file is a socket BufferedReader.
        return self._charge(cast(io.BufferedReader, self.stream).read1(self._size(size)))

    def close(self) -> None:
        self.stream.close()
        super().close()


class HttpTransport:
    def __init__(self, url: str, token: str) -> None:
        parts = urlsplit(url)
        if (
            parts.scheme not in ("https", "http")
            or not parts.hostname
            or (parts.scheme == "http" and parts.hostname not in ("127.0.0.1", "localhost", "::1"))
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise CheckoutError(CheckoutReason.INVALID_REQUEST)
        self._parts = parts
        self._authorization = (
            "Basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()
        )

    def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
        parts = self._parts
        connection_type = (
            http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        )
        connection = connection_type(parts.hostname or "", parts.port, timeout=budget.remaining())

        class BoundedResponse(http.client.HTTPResponse):
            def __init__(
                self,
                sock: socket.socket,
                debuglevel: int = 0,
                method: str | None = None,
                url: str | None = None,
            ) -> None:
                super().__init__(sock, debuglevel, method, url)
                assert self.fp is not None
                self.reader = _BudgetReader(self.fp, budget, sock)
                # HTTPResponse uses only read/read1/readline/close on its buffered socket file.
                self.fp = cast(io.BufferedReader, self.reader)

            def begin(self) -> None:
                super().begin()
                self.reader.headers = False

        connection.response_class = BoundedResponse

        route = "/info/refs?service=git-upload-pack" if request is None else "/git-upload-pack"
        headers = {
            "Authorization": self._authorization,
            "Accept": "application/x-git-upload-pack-result",
        }
        if request is not None:
            headers["Content-Type"] = "application/x-git-upload-pack-request"
        try:
            connection.connect()
            sock = connection.sock
            connection.request(
                "GET" if request is None else "POST",
                parts.path.rstrip("/") + route,
                request,
                headers,
            )
            response = connection.getresponse()
            if response.status != 200:
                code = {
                    401: ErrorCode.GIT_AUTH,
                    403: ErrorCode.GIT_FORBIDDEN,
                    404: ErrorCode.PR_NOT_FOUND,
                    429: ErrorCode.GIT_RATE_LIMIT,
                }.get(response.status, ErrorCode.GIT_UNAVAILABLE)
                raise CheckoutError(CheckoutReason.TRANSPORT, code)
            # read1 returns available bytes, so a peer dribbling data cannot reset the deadline.
            while not response.isclosed():
                budget.check()
                if sock is not None:
                    sock.settimeout(budget.remaining())
                chunk = response.read1(16 * 1024)
                if not chunk:
                    break
                yield chunk
        except (OSError, http.client.HTTPException):
            budget.check()
            raise CheckoutError(CheckoutReason.TRANSPORT, ErrorCode.GIT_UNAVAILABLE) from None
        finally:
            connection.close()


class LocalTransport:
    """Real Git file transport for hermetic tests; never derived from a PR clone URL."""

    def __init__(self, repository: Path) -> None:
        self.repository = repository.resolve(strict=True)

    def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]:
        args = [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "uploadpack.allowAnySHA1InWant=true",
            "upload-pack",
            "--stateless-rpc",
        ]
        if request is None:
            args.append("--advertise-refs")
        args.append(str(self.repository))
        process = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                "PATH": os.defpath,
                "HOME": "/nonexistent",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
            },
            start_new_session=True,
        )
        try:
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(request or b"")
            process.stdin.close()
            while True:
                budget.check()
                ready, _, _ = select.select([process.stdout], [], [], min(0.05, budget.remaining()))
                if not ready:
                    continue
                available = budget.limits.transfer_bytes - budget.transfer
                if available <= 0:
                    raise CheckoutError(CheckoutReason.BUDGET_TRANSFER)
                chunk = os.read(process.stdout.fileno(), min(16 * 1024, available))
                if not chunk:
                    break
                budget.charge_transfer(len(chunk))
                yield chunk
            # Observe the exit without reaping: the group id stays ours until it is ended below.
            if not wait_for_exit(process, budget.remaining()):
                budget.check()
                raise CheckoutError(CheckoutReason.TIMEOUT, ErrorCode.TIMEOUT)
            if not exited_with_zero(process):
                raise CheckoutError(CheckoutReason.TRANSPORT, ErrorCode.GIT_UNAVAILABLE)
        finally:
            end_group(process, grace=0)
            if process.stdin is not None:
                process.stdin.close()
            if process.stdout is not None:
                process.stdout.close()


def repository_url(repository: str, api_url: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    if any(part in (".", "..") for part in repository.split("/")):
        raise CheckoutError(CheckoutReason.INVALID_REQUEST)
    api = urlsplit(api_url)
    host = "github.com" if api.hostname == "api.github.com" else api.netloc
    return f"{api.scheme}://{host}/{repository}.git"
