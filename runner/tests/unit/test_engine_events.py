# SPDX-License-Identifier: Apache-2.0

"""The reader of the engine's event stream that feeds the tool-part audit (#552).

The reader is the adapter's only source for the audit of the native path, so it fails closed: no
stream, a stream that ends while the run goes on, an event it cannot read or cannot hold is an
audit that is not running, and that ends the run with a stable code.
"""

import json
import queue
import time
from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.adapter import EngineError
from code_reviewer_runner.dynamic_review.budget import (
    MAX_TOOL_RESULT_BYTES,
    BudgetLedger,
    DynamicLimits,
    LimitError,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.engine_events import MAX_EVENT_BYTES, EventReader
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.result import ErrorCode

SESSION = "ses_1"
EOF_MARK = b""


class ScriptedStream:
    """An event stream a test feeds line by line; `close` ends it, as a closed socket does."""

    def __init__(self) -> None:
        self.lines: queue.Queue[bytes | None] = queue.Queue()
        self.closed = False

    def send(self, event: dict[str, Any]) -> None:
        self.lines.put(f"data: {json.dumps(event)}\n".encode())
        self.lines.put(b"\n")

    def send_raw(self, line: bytes) -> None:
        self.lines.put(line)

    def go_silent(self) -> None:
        """What a socket whose read timeout ran out does: the next read raises."""
        self.lines.put(None)

    def readline(self, limit: int = -1) -> bytes:
        line = self.lines.get(timeout=5)
        if line is None:
            raise TimeoutError("timed out")
        return line[:limit] if limit >= 0 else line

    def end(self) -> None:
        self.lines.put(EOF_MARK)

    def close(self) -> None:
        self.closed = True
        self.end()


def tool_done(call: str, output: str) -> dict[str, Any]:
    return {
        "type": "message.part.updated",
        "properties": {
            "sessionID": SESSION,
            "part": {
                "type": "tool",
                "tool": "read",
                "callID": call,
                "state": {"status": "completed", "input": {}, "output": output},
            },
        },
    }


CONNECTED: dict[str, Any] = {"type": "server.connected", "properties": {}}


def reader(stream: ScriptedStream) -> tuple[EventReader, BudgetLedger]:
    ledger = BudgetLedger(
        DynamicLimits(),
        unit_costs=UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4)),
    )
    return EventReader(lambda: stream, ToolPartAudit(ledger, SESSION), ledger), ledger


def wait_for(condition: Any, seconds: float = 5.0) -> None:
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("the condition did not become true")


# #552-T09
def test_tool_parts_of_the_stream_are_counted_in_the_ledger() -> None:
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    stream.send(tool_done("c1", "hello"))
    stream.send(tool_done("c2", "world!"))
    wait_for(lambda: ledger.tool_calls == 2)
    events.stop()

    assert ledger.returned_bytes == len(b"hello") + len(b"world!")
    assert ledger.failure is None


# #552-T09: the audit is not running until the stream says it is connected
def test_a_stream_that_never_says_it_is_connected_fails_the_start() -> None:
    stream = ScriptedStream()
    events, _ = reader(stream)

    with pytest.raises(LimitError) as raised:
        events.start(0.1)

    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert stream.closed


# #552-T09: the first event of a stream that does not open is not an audit either
def test_a_stream_that_cannot_be_opened_fails_the_start() -> None:
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UnitCosts(Decimal(1), Decimal(4)))

    def refuse() -> ScriptedStream:
        raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine is not reachable")

    with pytest.raises(EngineError) as raised:
        EventReader(refuse, ToolPartAudit(ledger, SESSION), ledger).start(0.1)

    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE


# #552-T09
def test_a_result_over_the_bound_in_the_stream_is_the_failure_of_the_run() -> None:
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    stream.send(tool_done("c1", "x" * (MAX_TOOL_RESULT_BYTES + 1)))
    wait_for(lambda: ledger.failure is not None)
    events.stop()

    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #552-T09: a stream that ends while the run goes on is an audit that stopped
def test_a_stream_that_ends_unasked_is_the_failure_of_the_run() -> None:
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    stream.end()
    wait_for(lambda: ledger.failure is not None)

    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE


# #552-T09: ending the reader ourselves is not a failure
def test_stopping_the_reader_is_not_a_failure() -> None:
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    events.stop()
    time.sleep(0.05)

    assert stream.closed
    assert ledger.failure is None


# #552-T09: framing the engine did not promise is skipped, an event that cannot be read or held is
# not: the audit would be blind to it
def test_comments_other_fields_and_other_events_are_skipped_and_a_hostile_line_is_a_failure() -> (
    None
):
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    stream.send_raw(b": a comment\n")
    stream.send_raw(b"event: whatever\n")
    stream.send_raw(b"data: [1, 2]\n")  # JSON, but no event
    stream.send_raw(b"\n")
    stream.send({"type": "session.idle", "properties": {"sessionID": SESSION}})
    stream.send(tool_done("c1", "ok"))
    wait_for(lambda: ledger.tool_calls == 1)
    assert ledger.failure is None

    stream.send_raw(b"data: {not json\n")
    stream.send_raw(b"\n")
    wait_for(lambda: ledger.failure is not None)
    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #552-T09
def test_an_event_too_large_to_audit_is_the_failure_of_the_run() -> None:
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    stream.send_raw(b"data: " + b"x" * (MAX_EVENT_BYTES + 1))
    wait_for(lambda: ledger.failure is not None)

    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #552-S4: the data lines of ONE event are bounded together, not only line by line
def test_the_data_lines_of_one_event_are_bounded_by_their_sum() -> None:
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    megabyte = b"data: " + b"a" * (1024 * 1024) + b"\n"
    for _ in range(MAX_EVENT_BYTES // (1024 * 1024) + 1):  # no blank line ends the event
        stream.send_raw(megabyte)
    wait_for(lambda: ledger.failure is not None, 2.0)

    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    events.stop()


# #552-N3, #552-S4: a stream that stays open and goes quiet is an audit that stopped
def test_a_stream_that_goes_silent_is_the_failure_of_the_run() -> None:
    stream = ScriptedStream()
    events, ledger = reader(stream)
    stream.send(CONNECTED)
    events.start(5.0)

    stream.go_silent()
    wait_for(lambda: ledger.failure is not None, 2.0)

    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    events.stop()
