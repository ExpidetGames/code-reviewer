# SPDX-License-Identifier: Apache-2.0
"""Credential-private Git smart HTTP v0, and an offline file:// upload-pack seam.

No credential subprocess, token URL, inherited proxy/config or implicit lazy fetch. The
installation credential is held only by the trusted HTTP client, never written to disk.
"""

import base64
import contextlib
import http.client
import io
import os
import re
import select
import signal
import socket
import subprocess
from collections.abc import Generator
from pathlib import Path
from typing import BinaryIO, Protocol, cast
from urllib.parse import urlsplit

from code_reviewer_runner.result import ErrorCode

from .limits import Budget, CheckoutError


class Transport(Protocol):
    def stream(self, request: bytes | None, budget: Budget) -> Generator[bytes]: ...


def packet(data: bytes) -> bytes:
    if len(data) > 65516:
        raise CheckoutError()
    return f"{len(data) + 4:04x}".encode() + data


class _BudgetReader(io.BufferedIOBase):
    """Bound the raw HTTP input, including status, headers and chunk framing."""

    def __init__(self, stream: BinaryIO, budget: Budget) -> None:
        self.stream = stream
        self.budget = budget
        self.headers = True
        self.header_bytes = 0
        super().__init__()

    def _size(self, size: int) -> int:
        self.budget.check()
        available = self.budget.limits.preparation_bytes - self.budget.preparation
        if self.headers:
            available = min(available, self.budget.limits.response_bytes - self.header_bytes)
        if available <= 0:
            raise CheckoutError()
        return min(available, size if size >= 0 else 16 * 1024)

    def _charge(self, data: bytes) -> bytes:
        self.budget.charge(len(data))
        if self.headers:
            self.header_bytes += len(data)
        return data

    def readline(self, size: int | None = -1, /) -> bytes:
        return self._charge(self.stream.readline(self._size(-1 if size is None else size)))

    def read(self, size: int | None = -1, /) -> bytes:
        return self._charge(self.stream.read(self._size(-1 if size is None else size)))

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
            raise CheckoutError()
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
                self.reader = _BudgetReader(self.fp, budget)
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
                raise CheckoutError(code)
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
            raise CheckoutError(ErrorCode.GIT_UNAVAILABLE) from None
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
                available = budget.limits.preparation_bytes - budget.preparation
                if available <= 0:
                    raise CheckoutError()
                chunk = os.read(process.stdout.fileno(), min(16 * 1024, available))
                if not chunk:
                    break
                budget.charge(len(chunk))
                yield chunk
            if process.wait(timeout=budget.remaining()) != 0:
                raise CheckoutError(ErrorCode.GIT_UNAVAILABLE)
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            if process.stdin is not None:
                process.stdin.close()
            if process.stdout is not None:
                process.stdout.close()


def repository_url(repository: str, api_url: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise CheckoutError()
    if any(part in (".", "..") for part in repository.split("/")):
        raise CheckoutError()
    api = urlsplit(api_url)
    host = "github.com" if api.hostname == "api.github.com" else api.netloc
    return f"{api.scheme}://{host}/{repository}.git"
