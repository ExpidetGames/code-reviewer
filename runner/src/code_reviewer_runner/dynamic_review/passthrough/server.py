# SPDX-License-Identifier: Apache-2.0

"""The loopback server of the passthrough proxy (#550): `PassthroughProxy.handle` on a socket.

Reaching the port is not enough: only the holder of the job's capability gets an answer. The server
reads nothing for a caller that proved nothing and nothing beyond the measured length for the rest,
hands the answer on as it arrives (a stream chunk by chunk), and drops the connection, without the
terminator of a complete answer, when the proxy aborts a call. It never logs a request line.
"""

import contextlib
import socket
import threading
from collections.abc import Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy
from code_reviewer_runner.dynamic_review.passthrough.sink import ClientGone
from code_reviewer_runner.result import ErrorCode


class _Sink:
    def __init__(self, handler: BaseHTTPRequestHandler) -> None:
        self._handler = handler
        self._chunked = False

    def start(self, status: int, headers: Sequence[tuple[str, str]], length: int | None) -> None:
        handler = self._handler
        self._chunked = length is None
        try:
            handler.send_response(status)
            for name, value in headers:
                handler.send_header(name, value)
            if length is None:
                handler.send_header("Transfer-Encoding", "chunked")
            else:
                handler.send_header("Content-Length", str(length))
            handler.end_headers()
            handler.wfile.flush()
        except OSError:
            raise ClientGone from None

    def write(self, data: bytes) -> None:
        if not data:
            return
        try:
            if self._chunked:
                data = f"{len(data):x}\r\n".encode() + data + b"\r\n"
            self._handler.wfile.write(data)
            self._handler.wfile.flush()
        except OSError:
            raise ClientGone from None

    def end(self) -> None:
        try:
            if self._chunked:
                self._handler.wfile.write(b"0\r\n\r\n")
            self._handler.wfile.flush()
        except OSError:
            self._handler.close_connection = True

    def abort(self) -> None:
        self._handler.close_connection = True
        with contextlib.suppress(OSError):
            self._handler.connection.shutdown(socket.SHUT_RDWR)


class _Server(ThreadingHTTPServer):
    proxy: PassthroughProxy


class _Handler(BaseHTTPRequestHandler):
    server_version = "code-reviewer-proxy/1"
    protocol_version = "HTTP/1.1"

    def _handle(self) -> None:
        proxy = cast(_Server, self.server).proxy
        read: list[int] = []

        def read_body(length: int) -> bytes:
            read.append(length)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ClientGone
            return data

        sink = _Sink(self)
        try:
            proxy.handle(self.command, self.path, list(self.headers.items()), read_body, sink)
        except ClientGone:
            self.close_connection = True
        except Exception:
            # Nothing may leave here as text: the engine only sees the connection end, the run
            # ends with a code.
            proxy.ledger.record_failure(
                LimitError(ErrorCode.RUNNER_ERROR, "the model proxy could not answer a request")
            )
            self.close_connection = True
        # A body that was not read is still in the socket: the next request would start inside it.
        if not read and (self.headers.get("Content-Length") or "0") != "0":
            self.close_connection = True
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _handle

    def log_message(self, format: str, *args: Any) -> None:
        return  # never write a request line (it could carry data) anywhere


class PassthroughServer:
    """A running loopback proxy. `url` is what the engine's provider is pointed at."""

    def __init__(self, proxy: PassthroughProxy, host: str, port: int) -> None:
        self._proxy = proxy
        self._server = _Server((host, port), _Handler)
        self._server.daemon_threads = True
        self._server.proxy = proxy
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> "PassthroughServer":
        self._thread.start()
        return self

    def stop(self, drain_seconds: float = 0.0) -> None:
        """Stop serving. With `drain_seconds` the requests already being answered finish first (a
        superseded run: their cost is measured and must be in the result)."""
        if drain_seconds > 0:
            self._proxy.wait_idle(drain_seconds)
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)
