# SPDX-License-Identifier: Apache-2.0

"""The loopback server of the passthrough proxy (#550): `PassthroughProxy.handle` on a socket.

Reaching the port is not enough: only the holder of the job's capability gets an answer. The server
reads nothing for a caller that proved nothing and nothing beyond the measured length for the rest,
hands the answer on as it arrives (a stream chunk by chunk), and drops the connection, without the
terminator of a complete answer, when the proxy aborts a call. It never logs a request line.

The engine is the untrusted side of this socket, so every wait on it is bounded: a connection that
says nothing is closed after `first_request_timeout` (a served one may idle for `idle_timeout`);
reading a request body and writing an answer each wait at most `io_timeout`, and never longer than
the job has left; and no more than `max_connections` are served at once (a connection over the
bound is closed at once, as the thread it would take is not there to give). Without these a
stalled engine holds the one call the job may have, and a flood of connections holds a thread
each.
"""

import contextlib
import socket
import threading
from collections.abc import Callable, Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final, cast

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy
from code_reviewer_runner.dynamic_review.passthrough.sink import ClientGone
from code_reviewer_runner.result import ErrorCode

# A new connection has to send its first request line at once; one that has been served may idle.
FIRST_REQUEST_TIMEOUT_SECONDS: Final = 5.0
IDLE_TIMEOUT_SECONDS: Final = 30.0
IO_TIMEOUT_SECONDS: Final = 60.0
# The engine keeps a few connections alive; nothing legitimate needs more than this at once.
MAX_CONNECTIONS: Final = 16
# 0 would make a socket non-blocking, so no wait is shorter than this.
_SHORTEST_WAIT: Final = 0.05


def bounded_wait(remaining: float, limit: float) -> float:
    """How long one wait on the engine's socket may last: `limit`, or what the job has left."""
    return max(min(limit, remaining), _SHORTEST_WAIT)


class _Sink:
    def __init__(
        self, handler: BaseHTTPRequestHandler, time_left: Callable[[], float], io_limit: float
    ) -> None:
        self._handler = handler
        self._time_left = time_left
        self._io_limit = io_limit
        self._chunked = False

    def _bound(self) -> None:
        self._handler.connection.settimeout(bounded_wait(self._time_left(), self._io_limit))

    def start(self, status: int, headers: Sequence[tuple[str, str]], length: int | None) -> None:
        handler = self._handler
        self._chunked = length is None
        try:
            self._bound()
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
            self._bound()
            if self._chunked:
                data = f"{len(data):x}\r\n".encode() + data + b"\r\n"
            self._handler.wfile.write(data)
            self._handler.wfile.flush()
        except OSError:
            raise ClientGone from None

    def end(self) -> None:
        try:
            self._bound()
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
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        proxy: PassthroughProxy,
        *,
        max_connections: int,
        first_request_timeout: float,
        idle_timeout: float,
        io_timeout: float,
    ) -> None:
        self.proxy = proxy
        self.first_request_timeout = first_request_timeout
        self.idle_timeout = idle_timeout
        self.io_timeout = io_timeout
        self._slots = threading.BoundedSemaphore(max_connections)
        super().__init__(address, _Handler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        # A connection the engine reset is not news, and the default prints the traceback to stderr.
        return

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class _Handler(BaseHTTPRequestHandler):
    server_version = "code-reviewer-proxy/1"
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        # The wait for a request line and its headers (and for the next request of a connection).
        super().setup()
        self.connection.settimeout(cast(_Server, self.server).first_request_timeout)

    def _handle(self) -> None:
        server = cast(_Server, self.server)
        proxy = server.proxy
        read: list[int] = []

        def read_body(length: int) -> bytes:
            read.append(length)
            self.connection.settimeout(
                bounded_wait(proxy.ledger.remaining_seconds(), server.io_timeout)
            )
            try:
                data = self.rfile.read(length)
            except OSError:  # includes the timeout of a body that stalls
                raise ClientGone from None
            if len(data) != length:
                raise ClientGone
            return data

        sink = _Sink(self, proxy.ledger.remaining_seconds, server.io_timeout)
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
        # Back to the wait for the next request of this connection.
        with contextlib.suppress(OSError):
            self.connection.settimeout(server.idle_timeout)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _handle

    def log_message(self, format: str, *args: Any) -> None:
        return  # never write a request line (it could carry data) anywhere


class PassthroughServer:
    """A running loopback proxy. `url` is what the engine's provider is pointed at."""

    def __init__(
        self,
        proxy: PassthroughProxy,
        host: str,
        port: int,
        *,
        max_connections: int = MAX_CONNECTIONS,
        first_request_timeout: float = FIRST_REQUEST_TIMEOUT_SECONDS,
        idle_timeout: float = IDLE_TIMEOUT_SECONDS,
        io_timeout: float = IO_TIMEOUT_SECONDS,
    ) -> None:
        self._proxy = proxy
        self._server = _Server(
            (host, port),
            proxy,
            max_connections=max_connections,
            first_request_timeout=first_request_timeout,
            idle_timeout=idle_timeout,
            io_timeout=io_timeout,
        )
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
