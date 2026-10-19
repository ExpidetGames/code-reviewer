# SPDX-License-Identifier: Apache-2.0

"""A scripted provider for one wire family (#546): strict about the key, the path and the model.

It answers the chat call of the family in `formats.py` (a JSON document, or server-sent events when
the request asks for a stream), taking the next `Turn` of its script for every request that offers
tools and a short text for every other request (a title). It is as strict as the real provider is
about what a passthrough must get right:

- the real key, and only that, in the header of the family (a bearer token in `authorization`, the
  bare key in `x-api-key` or `x-goog-api-key`); the dummy key of the engine is a 401;
- the Messages API wants an `anthropic-version` header (400 without it);
- exactly one path per family, and for Google the model and the choice of stream in that path
  (`/v1beta/models/<model>:streamGenerateContent`); any other path or method is a 404, and so is a
  model other than the one it serves;
- faults of a test's choice: a status for the next requests (`fail_next`), a stream that is cut
  after some events (`cut_streams`), an answer compressed with gzip for a client that accepts it
  (`compress`).

A failed or cut request does not use up a turn of the script, so a retry gets the same answer. Every
request is kept, with its headers and body. Dummy keys only; nothing here leaves loopback.
"""

import gzip
import hashlib
import json
import threading
import zlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import TracebackType
from typing import Any, Self, cast
from urllib.parse import urlsplit

from fakes.wire.formats import (
    AUTH_HEADER,
    Family,
    Turn,
    answer,
    auth_value,
    error_body,
    is_stream,
    request_path,
    request_tool_names,
    stream,
)

Refusal = tuple[int, dict[str, Any]]
# A stricter rule set of a test (for example the Messages API's rules about thinking blocks): the
# refusal of a request, or None; and a hook that sees every answer that was given.
Judge = Callable[[Mapping[str, str], Mapping[str, Any]], Refusal | None]
OnAnswer = Callable[[Mapping[str, Any], Mapping[str, Any]], None]


@dataclass(frozen=True)
class Record:
    """One request as the upstream received it."""

    method: str
    target: str
    headers: dict[str, str]
    body: Any
    sha256: str


def _object(value: object) -> dict[str, Any] | None:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else None


def _invalid(family: Family, status: int, message: str) -> dict[str, Any]:
    if family == "messages":
        kind = "invalid_request_error" if status == 400 else "authentication_error"
        if status == 404:
            kind = "not_found_error"
        return {"type": "error", "error": {"type": kind, "message": message}}
    return {"error": {"message": message, "code": status}}


class ScriptedUpstream:
    def __init__(
        self,
        family: Family,
        script: Sequence[Turn],
        model: str,
        *,
        real_key: str,
        judge: Judge | None = None,
        on_answer: OnAnswer | None = None,
    ) -> None:
        self.family: Family = family
        self.model = model
        self.records: list[Record] = []
        self.compress = False
        self._script = list(script)
        self._real_key = real_key
        self._judge = judge
        self._on_answer = on_answer
        self._served = 0
        self._failures: list[int] = []
        self._cut_after: int | None = None
        self._cuts_left = 0
        self._lock = threading.Lock()
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle_any(self) -> None:
                upstream._handle(self)

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

    # -- faults ---------------------------------------------------------------------------------

    def fail_next(self, *statuses: int) -> None:
        """Answer the next requests with these statuses (429 and 503 carry `retry-after: 0`)."""
        with self._lock:
            self._failures.extend(statuses)

    def cut_streams(self, *, after_events: int, times: int = 1) -> None:
        """Drop the connection of the next `times` streams after `after_events` events."""
        with self._lock:
            self._cut_after, self._cuts_left = after_events, times

    # -- one request ----------------------------------------------------------------------------

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
        record = Record(
            handler.command, handler.path, headers, body, hashlib.sha256(raw).hexdigest()
        )
        with self._lock:
            self.records.append(record)
            index = len(self.records)
            failure = self._failures.pop(0) if self._failures else None
        refusal = self._refusal(record, failure)
        if refusal is not None:
            extra = {"retry-after": "0"} if refusal[0] in (429, 503) else {}
            self._send_json(handler, refusal[0], refusal[1], extra)
            return
        document: Mapping[str, Any] = body
        tools = request_tool_names(self.family, document)
        path = urlsplit(handler.path).path
        with self._lock:
            served = self._served
        turn = self._script[min(served, len(self._script) - 1)] if tools else Turn(text="A title")
        call = served + 1 if tools else 100 + index
        if self._on_answer is not None and not is_stream(self.family, path, document):
            self._on_answer(document, answer(self.family, turn, call, self.model))
        if not is_stream(self.family, path, document):
            self._send_json(handler, 200, answer(self.family, turn, call, self.model))
            self._served_one(bool(tools))
            return
        if self._on_answer is not None:
            self._on_answer(document, answer(self.family, turn, call, self.model))
        if self._send_stream(handler, stream(self.family, turn, call, self.model)):
            self._served_one(bool(tools))

    def _served_one(self, with_tools: bool) -> None:
        if with_tools:
            with self._lock:
                self._served += 1

    def _refusal(self, record: Record, failure: int | None) -> Refusal | None:
        family = self.family
        if record.headers.get(AUTH_HEADER[family]) != auth_value(family, self._real_key):
            return 401, _invalid(family, 401, "invalid key")
        if family == "messages" and "anthropic-version" not in record.headers:
            return 400, _invalid(family, 400, "anthropic-version: header is required")
        path = urlsplit(record.target).path
        body = _object(record.body)
        streaming = is_stream(family, path, body)
        if record.method != "POST" or path != request_path(family, self.model, streaming=streaming):
            return 404, _invalid(family, 404, f"no route for {record.method} {path}")
        if family != "google" and (body is None or body.get("model") != self.model):
            return 404, _invalid(family, 404, "model not found")
        if failure:
            return failure, error_body(family, failure)
        if self._judge is not None and body is not None:
            return self._judge(record.headers, body)
        return None

    def _send_json(
        self,
        handler: BaseHTTPRequestHandler,
        status: int,
        document: Mapping[str, Any],
        extra: Mapping[str, str] | None = None,
    ) -> None:
        payload = json.dumps(document).encode()
        encoded = self._accepts_gzip(handler)
        if encoded:
            payload = gzip.compress(payload)
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        if encoded:
            handler.send_header("Content-Encoding", "gzip")
        handler.send_header("Content-Length", str(len(payload)))
        for name, value in (extra or {}).items():
            handler.send_header(name, value)
        handler.end_headers()
        handler.wfile.write(payload)

    def _accepts_gzip(self, handler: BaseHTTPRequestHandler) -> bool:
        return self.compress and "gzip" in (handler.headers.get("Accept-Encoding") or "")

    def _send_stream(self, handler: BaseHTTPRequestHandler, events: list[bytes]) -> bool:
        """Send the events as a chunked stream. False when the connection was cut on purpose."""
        encoder = zlib.compressobj(wbits=31) if self._accepts_gzip(handler) else None
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        if encoder is not None:
            handler.send_header("Content-Encoding", "gzip")
        handler.end_headers()
        with self._lock:
            cut_after = self._cut_after if self._cuts_left > 0 else None
        for position, event in enumerate(events):
            if cut_after is not None and position >= cut_after:
                with self._lock:
                    self._cuts_left -= 1
                handler.wfile.flush()
                handler.close_connection = True
                handler.connection.shutdown(2)
                return False
            data = event
            if encoder is not None:
                data = encoder.compress(event) + encoder.flush(zlib.Z_SYNC_FLUSH)
            handler.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            handler.wfile.flush()
        if encoder is not None:
            tail = encoder.flush()
            if tail:
                handler.wfile.write(f"{len(tail):x}\r\n".encode() + tail + b"\r\n")
        handler.wfile.write(b"0\r\n\r\n")
        return True
