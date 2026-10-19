# SPDX-License-Identifier: Apache-2.0

"""The smallest passthrough that fits #544: swap the key, relay the bytes, keep a copy (#546).

An engine that holds a dummy key talks to this relay as if it were the provider; the relay checks
the dummy under the header of the family, replaces it with the real key, forwards the request to
the one upstream it was built for and hands the answer back as it arrives, byte for byte. That is
the whole job of the production passthrough proxy of #550, minus the allow-list, the limits and the
usage parser, which are not what the spike measures. It exists so that the engine tests of #546
can show what a pure passthrough sees and changes (nothing but the key), and so that #550 and
#551 have a reference to build against. It is a test double, not the proxy.

What it keeps for the tests: every request as the engine sent it (the key shown as `<dummy>` or
`<other>`, never as a value), a hash of the body to compare with what the upstream received, and the
answer as it was streamed back (the tee a usage parser will read).

One choice is the lesson of the spike: the engine says `accept-encoding: gzip, deflate, br, zstd`.
A provider may compress the answer for that, and a tee that has to read the usage then reads
compressed bytes. The relay therefore asks the upstream for `identity` (`force_identity`, on by
default); a proxy that forwards the header as it is must decode before it parses.
"""

import hashlib
import http.client
import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import TracebackType
from typing import Any, Self
from urllib.parse import urlsplit

from fakes.wire.formats import AUTH_HEADER, Family, auth_value

# Hop-by-hop headers and the ones the relay sets itself.
_NOT_FORWARDED = frozenset(
    {
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-authorization",
        "proxy-connection",
        "host",
        "content-length",
    }
)
_NOT_RETURNED = _NOT_FORWARDED | {"date", "server"}


@dataclass
class Seen:
    """One request as the engine sent it, and the answer as the relay streamed it back."""

    method: str
    target: str
    headers: dict[str, str]
    body: Any
    sha256: str
    status: int = 0
    response_headers: dict[str, str] = field(default_factory=lambda: {})
    response_bytes: bytes = b""


class KeySwapRelay:
    def __init__(
        self,
        family: Family,
        upstream_url: str,
        *,
        dummy_key: str,
        real_key: str,
        force_identity: bool = True,
    ) -> None:
        self.family: Family = family
        self.seen: list[Seen] = []
        self._upstream = urlsplit(upstream_url)
        self._dummy_key = dummy_key
        self._real_key = real_key
        self._force_identity = force_identity
        relay = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle_any(self) -> None:
                relay._handle(self)

            do_GET = do_POST = do_PUT = do_DELETE = handle_any

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self) -> Self:
        self._thread.start()
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        trace: TracebackType | None,
    ) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        headers = {name.lower(): value for name, value in handler.headers.items()}
        body: Any = None
        if raw:
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw.decode("utf-8", "replace")
        key_header = AUTH_HEADER[self.family]
        is_dummy = headers.get(key_header) == auth_value(self.family, self._dummy_key)
        shown = dict(headers)
        if key_header in shown:
            shown[key_header] = "<dummy>" if is_dummy else "<other>"
        seen = Seen(handler.command, handler.path, shown, body, hashlib.sha256(raw).hexdigest())
        self.seen.append(seen)
        if not is_dummy:
            seen.status = 401
            self._refuse(handler)
            return
        forwarded = {k: v for k, v in headers.items() if k not in _NOT_FORWARDED}
        forwarded[key_header] = auth_value(self.family, self._real_key)
        if self._force_identity:
            forwarded["accept-encoding"] = "identity"
        connection = http.client.HTTPConnection(
            self._upstream.hostname or "127.0.0.1", self._upstream.port, timeout=60
        )
        try:
            connection.request(handler.command, handler.path, body=raw or None, headers=forwarded)
            response = connection.getresponse()
            seen.status = response.status
            seen.response_headers = {k.lower(): v for k, v in response.getheaders()}
            self._relay_answer(handler, response, seen)
        except OSError:
            seen.status = 502
            handler.close_connection = True
        finally:
            connection.close()

    @staticmethod
    def _refuse(handler: BaseHTTPRequestHandler) -> None:
        payload = b'{"error":{"message":"not the capability of this job"}}'
        handler.send_response(401)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)

    @staticmethod
    def _relay_answer(
        handler: BaseHTTPRequestHandler, response: http.client.HTTPResponse, seen: Seen
    ) -> None:
        chunked = response.getheader("Transfer-Encoding") == "chunked"
        handler.send_response(response.status)
        for name, value in response.getheaders():
            if name.lower() not in _NOT_RETURNED:
                handler.send_header(name, value)
        if chunked:
            handler.send_header("Transfer-Encoding", "chunked")
        else:
            handler.send_header("Content-Length", response.getheader("Content-Length") or "0")
        handler.end_headers()
        try:
            while True:
                data = response.read1(65536)
                if not data:
                    break
                seen.response_bytes += data
                if chunked:
                    handler.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                else:
                    handler.wfile.write(data)
                handler.wfile.flush()
            if chunked:
                handler.wfile.write(b"0\r\n\r\n")
        except (http.client.IncompleteRead, ConnectionError):
            # The upstream dropped mid-answer: drop the engine's connection the same way, without
            # the chunk terminator, so the engine sees a cut stream and not a short, complete one.
            handler.close_connection = True
            handler.connection.shutdown(2)
