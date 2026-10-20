# SPDX-License-Identifier: Apache-2.0

"""The audit of the tool parts the engine reports, on the adapter's side (#552).

On the legacy path the proxy audited the tool results of every request (`audit.py`). The
passthrough proxy (#550) relays a request's bytes and counts nothing of the sort: its body is a
closed schema per wire family, and a tool result in it is only text of the family's tool-exchange
shape. The count and the bounds are enforced here instead, where the adapter sees the parts the
engine reports (`message.part.updated` events of its own session):

- a **tool call** is counted when its part is first seen, in any state (an attempt is an attempt);
- a **result** is counted once per call id, when the part is complete: the UTF-8 bytes of its
  output (or of the error text of a failed tool, which the model is shown too) against the
  per-result and the cumulative bound, and the files it names against the file count;
- a part that is complete but cannot be tied to a call id fails closed.

This is **detective**: an event arrives when the tool finished, and the engine's next request may
already be on its way. What bounds a hostile or mistaken engine regardless is the proxy: no request
carries more than the request byte bound, and the ledger admits no call after a recorded failure.
A result the engine does not report is bounded by that request bound alone.

The events are the engine's report and untrusted data; this module reads them defensively and
stores nothing but numbers and tool names (the call trace, `call_trace.py`).
"""

from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.dynamic_review.audit import normal_path, result_files
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

PART_EVENT = "message.part.updated"
_DONE = ("completed", "error")


class ToolPartAudit:
    """Feeds the tool parts of one session into the ledger. Not thread-safe: one reader feeds it."""

    def __init__(self, ledger: BudgetLedger, session_id: str, *, export_root: str | None = None):
        self._ledger = ledger
        self._session = session_id
        self._root = export_root
        if export_root is not None:
            ledger.trace.set_export_root(export_root)
        self._called: set[str] = set()
        self._resulted: set[str] = set()

    def feed(self, event: Mapping[str, Any]) -> None:
        """Count what one event of the engine's stream reports. Raises `LimitError` at a bound."""
        if event.get("type") != PART_EVENT:
            return
        properties = as_object(event.get("properties"))
        part = as_object(properties.get("part")) if properties else None
        if properties is None or part is None or properties.get("sessionID") != self._session:
            return
        if part.get("type") != "tool":
            return
        state = as_object(part.get("state"))
        status = state.get("status") if state else None
        identity = _identity(part)
        name = part.get("tool")
        name = name if isinstance(name, str) else ""
        if identity is None:
            if status in _DONE:
                raise LimitError(
                    ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "a tool result cannot be tied to a call"
                )
            return
        if identity not in self._called:
            self._called.add(identity)
            self._ledger.count_tool_call(name)
        if state is not None and status in _DONE and identity not in self._resulted:
            self._resulted.add(identity)
            self._result(identity, name, state)

    def _result(self, identity: str, name: str, state: Mapping[str, Any]) -> None:
        raw = state.get("output" if state.get("status") == "completed" else "error")
        text = raw if isinstance(raw, str) else ""
        arguments = as_object(state.get("input")) or {}
        size = len(text.encode("utf-8", errors="replace"))
        self._ledger.add_result_bytes(size)
        self._ledger.trace.tool_called(identity, name, arguments)
        self._ledger.trace.tool_resulted(identity, size)
        for path in result_files(name, arguments, text):
            self._ledger.count_file(normal_path(self._root, path))


def _identity(part: Mapping[str, Any]) -> str | None:
    for key in ("callID", "id"):
        value = part.get(key)
        if isinstance(value, str) and value:
            return value
    return None
