# SPDX-License-Identifier: Apache-2.0

"""Proxy-side audit of the engine's tool loop (#197).

The tool, file and result-byte bounds of the epic are enforced where the engine cannot get around
them: at the runner-owned model proxy. Every model request the engine makes carries the whole
history of the conversation, including the tool calls the model asked for and the results the
engine gave back, so the proxy sees both sides of the loop without trusting the engine's session
state or its events (the stored message list of the pinned server is not even readable, see #85).

- **Tool calls** are counted when the provider's answer arrives, before the answer reaches the
  engine. The call that would exceed the bound is never handed to the engine, so it never runs.
  Unknown and denied tools count too: an attempt is an attempt.
- **Results** are audited in the next request, before it is forwarded: each result is checked
  against the per-result bound and added to the cumulative bound, and the distinct content-bearing
  files it names are added to the file bound. A request that would cross a bound is refused, so
  neither the provider nor the model ever sees the offending content, and the run fails.
- **Reminder wrappers** (#232) are neutralised first, in the same pass: the engine's
  `<system-reminder>` attachment is dropped and literal tag text is escaped (`reminders.py`). The
  bounds then count the text the model is actually shown, and the request is forwarded in that form.

Each call and each result is audited once, by the id the provider gave the call: the history is
resent on every request and must not be counted again. The audit cannot undo a read the engine
already did; the read-only export and the default-deny permissions are what limit what a read can
reach, and the byte bounds what the model can be shown.

The file counting reads the three result shapes of the pinned `read`, `grep` and `glob` tools. A
result in a shape it does not know contributes bytes, but no files: the tool and byte bounds stay
exact, and a change of the pinned format shows up in the engine suite, not silently in production.
"""

import json
import posixpath
from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError
from code_reviewer_runner.dynamic_review.reminders import neutralize_content
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

# How far into a read result the type marker may appear. The tool writes it in its first lines;
# a file whose own text contains the marker must not turn a directory listing into a file.
_READ_HEADER_CHARS = 1024


class ToolAudit:
    """Counts tool calls, files and result bytes from what passes through the proxy."""

    def __init__(self, ledger: BudgetLedger, *, export_root: str | None = None) -> None:
        self._ledger = ledger
        self._root = posixpath.normpath(export_root) if export_root else None
        if self._root is not None:
            ledger.trace.set_export_root(self._root)
        self._calls: dict[str, tuple[str, dict[str, Any]]] = {}
        self._resulted: set[str] = set()
        self._anonymous = 0

    def set_export_root(self, root: str) -> None:
        """Name files relative to the export once it exists (the proxy is built before it)."""
        self._root = posixpath.normpath(root)
        self._ledger.trace.set_export_root(self._root)

    # -- the provider's answer ------------------------------------------------

    def calls_in_answer(self, completion: Mapping[str, Any]) -> None:
        """Count the tool calls of one provider answer before the engine gets it."""
        choices: Any = completion.get("choices")
        if not isinstance(choices, list) or not choices:
            return
        entries: list[Any] = choices  # pyright: ignore[reportUnknownVariableType]
        first = as_object(entries[0])
        message = as_object(first.get("message")) if first else None
        if message is None:
            return
        for call in _tool_calls(message):
            self._note_call(call)

    # -- the engine's request -------------------------------------------------

    def results_in_request(self, messages: object) -> Any:
        """Audit the tool results of a request's history; return the history to forward.

        The result is a new list in which every tool result is neutralised (`reminders.py`); the
        caller's messages are untouched. Counting is done on the neutralised text.
        """
        if not isinstance(messages, list):
            return messages
        entries: list[Any] = messages  # pyright: ignore[reportUnknownVariableType]
        forwarded: list[Any] = []
        for item in entries:
            message = as_object(item)
            if message is None:
                forwarded.append(item)
                continue
            role = message.get("role")
            if role == "assistant":
                for call in _tool_calls(message):
                    self._note_call(call)
            elif role == "tool":
                message = self._note_result(message)
            forwarded.append(message)
        return forwarded

    # -- internals ------------------------------------------------------------

    def _note_call(self, call: Mapping[str, Any]) -> None:
        identity: Any = call.get("id")
        if not isinstance(identity, str) or not identity:
            self._anonymous += 1
            identity = f"anonymous-{self._anonymous}"
        if identity in self._calls:
            return
        function = as_object(call.get("function"))
        name: Any = function.get("name") if function else None
        self._ledger.count_tool_call(name if isinstance(name, str) else "")
        arguments: Any = function.get("arguments") if function else None
        self._calls[identity] = (name if isinstance(name, str) else "", _arguments(arguments))
        self._ledger.trace.tool_called(identity, self._calls[identity][0], self._calls[identity][1])

    def _note_result(self, message: Mapping[str, Any]) -> dict[str, Any]:
        identity: Any = message.get("tool_call_id")
        if not isinstance(identity, str) or not identity:
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "a tool result cannot be tied to a call"
            )
        name, arguments = self._calls.get(identity, ("", {}))
        if "content" not in message:
            neutral = dict(message)
            content = None
        else:
            content = neutralize_content(name, message["content"])
            neutral = {**message, "content": content}
        if identity in self._resulted:
            return neutral
        self._resulted.add(identity)
        text = _content_text(content)
        size = len(text.encode("utf-8", errors="replace"))
        self._ledger.add_result_bytes(size)
        self._ledger.trace.tool_resulted(identity, size)
        for path in _result_files(name, arguments, text):
            self._ledger.count_file(self._normal(path))
        return neutral

    def _normal(self, path: str) -> str:
        """One identity per file: relative to the export when it is inside, however it was named."""
        root = self._root
        if root is not None and not path.startswith("/"):
            path = posixpath.join(root, path)
        path = posixpath.normpath(path)
        if root is not None and (path == root or path.startswith(f"{root}/")):
            return path[len(root) :].lstrip("/") or "."
        return path


def _tool_calls(message: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw: Any = message.get("tool_calls")
    if not isinstance(raw, list):
        return []
    calls: list[Mapping[str, Any]] = []
    entries: list[Any] = raw  # pyright: ignore[reportUnknownVariableType]
    for item in entries:
        call = as_object(item)
        if call is not None:
            calls.append(call)
    return calls


def _arguments(raw: object) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw  # pyright: ignore[reportUnknownVariableType]
    if not isinstance(raw, str):
        return {}
    try:
        value: Any = json.loads(raw)
    except ValueError:
        return {}
    return as_object(value) or {}


def _content_text(content: object) -> str:
    """Everything the model is shown for one result, as text: a string or its text parts."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts: list[str] = []
        entries: list[Any] = content  # pyright: ignore[reportUnknownVariableType]
        for part in entries:
            block = as_object(part)
            text: Any = block.get("text") if block else None
            texts.append(text if isinstance(text, str) else json.dumps(part, ensure_ascii=False))
        return "".join(texts)
    return json.dumps(content, ensure_ascii=False)


def _result_files(name: str, arguments: Mapping[str, Any], text: str) -> list[str]:
    """The distinct content-bearing files one result names. Only the pinned tool shapes count."""
    if name == "read":
        path: Any = arguments.get("filePath")
        header = text[:_READ_HEADER_CHARS]
        if (
            isinstance(path, str)
            and path
            and header.startswith("<path>")
            and ("<type>file</type>" in header)
        ):
            return [path]
        return []
    if name == "grep":
        # `Found N matches`, then for each file `<path>:` and its indented `Line n: text` rows.
        return [
            line[:-1] for line in text.split("\n") if line.startswith("/") and line.endswith(":")
        ]
    if name == "glob":
        return [line for line in text.split("\n") if line.startswith("/")]
    return []
