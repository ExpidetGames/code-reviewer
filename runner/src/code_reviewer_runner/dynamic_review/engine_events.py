# SPDX-License-Identifier: Apache-2.0

"""The reader of the engine's event stream that feeds the tool-part audit (#552).

The engine publishes what happens in its session as server-sent events on its own loopback API
(`GET /event`, scoped to the export like every request). The adapter reads them on a thread of its
own and hands each event to the audit (`tool_part_audit.py`), which counts tool calls, result bytes
and files for the native path, where the proxy counts nothing of the kind.

The reader fails closed. An audit that is not running is not an audit: a stream that does not say
it is connected, one that ends while the run goes on, a line it cannot hold and an event it cannot
read are each the run's failure with a stable code, recorded in the ledger where the adapter's
watch picks it up. The stream is the engine's report and untrusted data; nothing in it is
evaluated, and only the numbers the audit derives are kept.
"""

import contextlib
import json
import threading
from collections.abc import Callable
from typing import Any, Final, Protocol

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

# The longest line of the stream that is held. A result is at most 64 KiB, which JSON escaping can
# multiply by six, so no event of a run within its bounds comes near this; a longer line is an
# event the audit cannot see into, and that is a failure, not something to skip.
MAX_EVENT_BYTES: Final = 8 * 1024 * 1024
CONNECTED_EVENT: Final = "server.connected"
_DATA: Final = b"data:"


class EventStream(Protocol):
    """The part of an open response the reader needs."""

    def readline(self, limit: int = -1, /) -> bytes: ...

    def close(self) -> None: ...


class EventReader:
    """One thread that reads the engine's events into the audit, until it is stopped."""

    def __init__(
        self,
        open_stream: Callable[[], EventStream],
        audit: ToolPartAudit,
        ledger: BudgetLedger,
    ) -> None:
        self._open = open_stream
        self._audit = audit
        self._ledger = ledger
        self._stream: EventStream | None = None
        self._connected = threading.Event()
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, wait_seconds: float) -> None:
        """Open the stream and wait until the engine says it is connected: from then on every
        event of the session reaches the audit. Raises `LimitError` when it does not."""
        self._stream = self._open()
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()
        if not self._connected.wait(wait_seconds):
            self.stop()
            raise LimitError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine's event stream did not connect"
            )

    def stop(self) -> None:
        """End the reader. A stream that ends because of this is not a failure."""
        self._stopping.set()
        stream, self._stream = self._stream, None
        if stream is not None:
            with contextlib.suppress(OSError):  # closing a socket that is gone is the point
                stream.close()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    # -- the thread -----------------------------------------------------------

    def _read(self) -> None:
        stream = self._stream
        if stream is None:
            return
        try:
            self._events(stream)
        except LimitError as error:
            self._ledger.record_failure(error)
        except Exception:  # an audit that broke must stop the run, never be lost
            self._fail(ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the engine's events could not be read")
        else:
            if not self._stopping.is_set():
                self._fail(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine's event stream ended")

    def _fail(self, code: ErrorCode, detail: str) -> None:
        if not self._stopping.is_set():
            self._ledger.record_failure(LimitError(code, detail))

    def _events(self, stream: EventStream) -> None:
        data: list[bytes] = []
        while True:
            line = stream.readline(MAX_EVENT_BYTES + 1)
            if not line:
                return
            if len(line) > MAX_EVENT_BYTES:
                raise LimitError(
                    ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "an engine event is too large to audit"
                )
            line = line.rstrip(b"\r\n")
            if line:
                if line.startswith(_DATA):
                    data.append(line[len(_DATA) :].lstrip(b" "))
                continue  # a comment or another field of the framing: not data
            if data:
                self._event(b"\n".join(data))
                data = []

    def _event(self, payload: bytes) -> None:
        try:
            value: Any = json.loads(payload)
        except (ValueError, RecursionError):
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "an engine event could not be read"
            ) from None
        event = as_object(value)
        if event is None:
            return
        if event.get("type") == CONNECTED_EVENT:
            self._connected.set()
            return
        self._audit.feed(event)
