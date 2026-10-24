# SPDX-License-Identifier: LicenseRef-Proprietary

"""The per-call trace of one Dynamic Review (#541): what each model call and each tool call was,
as numbers and stable names, never as content.

A run that stopped at its cost limit or cost more than expected could not be explained after the
fact: the stored result only had the totals. The trace records, for each model call, when it
started, the tokens it used (prompt, cache read, cache write, completion), its cost, why it ended,
whether it was the final call and which tools it asked for, and for each tool call the tool, the
size of the result it got and whether the same call had run before in this job.

**Privacy.** Nothing the repository, the pull request or the model wrote is stored: no path, no
argument, no result, no model text. Tool names are the engine's own (`TRACE_TOOL_NAMES`); any other
name is stored as `other`, because a name is a string the model chose. A finish reason outside the
protocol's is `other` for the same reason. Whether a call is a repeat is decided from the tool name
and its normalised arguments in memory, as a digest that is never written out. The trace is
observability only: nothing in the run reads it back.

**Bound.** At most `MAX_TRACE_ENTRIES` model calls and as many tool calls are kept (the first
ones); `truncated` says that more happened. The run itself is not limited by this.
"""

import hashlib
import json
import math
import posixpath
import threading
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object

MAX_TRACE_ENTRIES = 100
# The engine's tools (`config.ALLOWED_TOOLS`); every other name is `other`.
TRACE_TOOL_NAMES = ("read", "grep", "glob", "StructuredOutput")
OTHER_TOOL = "other"
# The finish reasons of the chat protocol; every other one is `other`.
FINISH_REASONS = ("stop", "tool_calls", "length", "content_filter")
OTHER_FINISH = "other"
# The arguments that name a path: spelled absolute or relative, they are one file.
_PATH_ARGUMENTS = frozenset({"filePath", "path"})


def tool_label(name: object) -> str:
    return name if isinstance(name, str) and name in TRACE_TOOL_NAMES else OTHER_TOOL


def _count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _cost(value: Decimal | None) -> float | None:
    if value is None or not value.is_finite() or value < 0:
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _finish(value: object) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) and value in FINISH_REASONS else OTHER_FINISH


def answer_tool_names(completion: Mapping[str, Any]) -> list[str]:
    """The names of the tools one provider answer asked for, in order, as the model wrote them."""
    choices: Any = completion.get("choices")
    if not isinstance(choices, list) or not choices:
        return []
    entries: list[Any] = choices  # pyright: ignore[reportUnknownVariableType]
    first = as_object(entries[0])
    message = as_object(first.get("message")) if first else None
    calls: Any = message.get("tool_calls") if message else None
    if not isinstance(calls, list):
        return []
    names: list[str] = []
    items: list[Any] = calls  # pyright: ignore[reportUnknownVariableType]
    for item in items:
        call = as_object(item)
        function = as_object(call.get("function")) if call else None
        name: Any = function.get("name") if function else None
        names.append(name if isinstance(name, str) else "")
    return names


def answer_finish_reason(completion: Mapping[str, Any]) -> str | None:
    """Why the first choice of a provider answer ended, as the provider wrote it."""
    choices: Any = completion.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    entries: list[Any] = choices  # pyright: ignore[reportUnknownVariableType]
    first = as_object(entries[0])
    reason: Any = first.get("finish_reason") if first else None
    return reason if isinstance(reason, str) else None


class CallTrace:
    """Collects the trace of one run. Thread-safe: the proxy serves from a threaded server."""

    def __init__(self, export_root: str | None = None) -> None:
        self._lock = threading.Lock()
        self._root = posixpath.normpath(export_root) if export_root else None
        self._model_calls: list[dict[str, Any]] = []
        self._tool_calls: list[dict[str, Any]] = []
        self._open: dict[str, dict[str, Any]] = {}
        self._seen: set[bytes] = set()
        self._model_total = 0
        self._tool_total = 0

    def set_export_root(self, root: str) -> None:
        """Spell paths relative to the export once it exists, as the audit does."""
        with self._lock:
            self._root = posixpath.normpath(root)

    # -- model calls ----------------------------------------------------------

    def model_call(
        self,
        *,
        t_ms: int,
        prompt_tokens: int | None,
        cache_read: int | None,
        cache_write: int | None,
        completion_tokens: int | None,
        cost: Decimal | None,
        finish_reason: str | None,
        final: bool,
        tool_names: Sequence[str],
    ) -> None:
        counts: dict[str, int] = {}
        for name in tool_names:
            label = tool_label(name)
            counts[label] = counts.get(label, 0) + 1
        with self._lock:
            index = self._model_total
            self._model_total += 1
            if len(self._model_calls) >= MAX_TRACE_ENTRIES:
                return
            self._model_calls.append(
                {
                    "index": index,
                    "tMs": max(int(t_ms), 0),
                    "promptTokens": _count(prompt_tokens),
                    "cacheRead": _count(cache_read),
                    "cacheWrite": _count(cache_write),
                    "completionTokens": _count(completion_tokens),
                    "costUsd": _cost(cost),
                    "finishReason": _finish(finish_reason),
                    "final": final,
                    "tools": [{"name": name, "count": count} for name, count in counts.items()],
                }
            )

    # -- tool calls -----------------------------------------------------------

    def tool_called(self, identity: str, name: str, arguments: Mapping[str, Any]) -> None:
        """A tool call the model asked for, noted once (the audit passes each call id once)."""
        with self._lock:
            digest = self._digest(name, arguments)
            repeat = digest in self._seen
            self._seen.add(digest)
            index = self._tool_total
            self._tool_total += 1
            if len(self._tool_calls) >= MAX_TRACE_ENTRIES:
                return
            entry: dict[str, Any] = {
                "index": index,
                "name": tool_label(name),
                "resultBytes": None,
                "isRepeat": repeat,
            }
            self._tool_calls.append(entry)
            self._open[identity] = entry

    def tool_resulted(self, identity: str, result_bytes: int) -> None:
        """The size of the result the model was shown for a call; a call that was not kept is
        ignored."""
        with self._lock:
            entry = self._open.pop(identity, None)
            if entry is not None:
                entry["resultBytes"] = _count(result_bytes)

    def _digest(self, name: str, arguments: Mapping[str, Any]) -> bytes:
        normal = {
            key: self._normal(value) if key in _PATH_ARGUMENTS and isinstance(value, str) else value
            for key, value in arguments.items()
        }
        text = json.dumps([name, normal], sort_keys=True, default=str, ensure_ascii=True)
        return hashlib.sha256(text.encode("utf-8", errors="replace")).digest()

    def _normal(self, path: str) -> str:
        root = self._root
        if root is not None and not path.startswith("/"):
            path = posixpath.join(root, path)
        path = posixpath.normpath(path)
        if root is not None and (path == root or path.startswith(f"{root}/")):
            return path[len(root) :].lstrip("/") or "."
        return path

    # -- the result -----------------------------------------------------------

    def to_json(self) -> dict[str, Any] | None:
        """The trace for `usage.callTrace`, or None for a run that made no model call."""
        with self._lock:
            if self._model_total == 0 and self._tool_total == 0:
                return None
            return {
                "truncated": self._model_total > MAX_TRACE_ENTRIES
                or self._tool_total > MAX_TRACE_ENTRIES,
                "modelCalls": [dict(call) for call in self._model_calls],
                "toolCalls": [dict(call) for call in self._tool_calls],
            }


# -- the same shape, read back -------------------------------------------------------------------
# The job process prints the trace and the loop sends it on. The loop does not trust what a process
# printed: it passes on a trace that is exactly the contract's (`RunnerCallTrace` in
# `contracts/runner-api.v1.json`, which the app checks the same way) or none at all.

_MAX_COUNT = 1_000_000_000
_MAX_MS = 604_800_000
_MODEL_CALL_KEYS = frozenset(
    {
        "index",
        "tMs",
        "promptTokens",
        "cacheRead",
        "cacheWrite",
        "completionTokens",
        "costUsd",
        "finishReason",
        "final",
        "tools",
    }
)
_TOOL_CALL_KEYS = frozenset({"index", "name", "resultBytes", "isRepeat"})
_TOOL_COUNT_KEYS = frozenset({"name", "count"})
_MAX_TOOL_RESULT_BYTES = 64 * 1024 * 1024


def _whole(value: object, maximum: int, *, nullable: bool = False) -> bool:
    if value is None:
        return nullable
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum


def _model_call_is_valid(value: object) -> bool:
    call = as_object(value)
    if call is None or call.keys() != _MODEL_CALL_KEYS:
        return False
    cost: Any = call["costUsd"]
    cost_ok = cost is None or (
        isinstance(cost, (int, float))
        and not isinstance(cost, bool)
        and math.isfinite(cost)
        and cost >= 0
    )
    finish: Any = call["finishReason"]
    tools: Any = call["tools"]
    if not isinstance(tools, list) or len(tools) > len(TRACE_TOOL_NAMES) + 1:  # pyright: ignore[reportUnknownArgumentType]
        return False
    tool_items: list[Any] = tools  # pyright: ignore[reportUnknownVariableType]
    for item in tool_items:
        entry = as_object(item)
        if (
            entry is None
            or entry.keys() != _TOOL_COUNT_KEYS
            or entry["name"] not in (*TRACE_TOOL_NAMES, OTHER_TOOL)
            or not _whole(entry["count"], _MAX_COUNT)
            or entry["count"] < 1
        ):
            return False
    return (
        _whole(call["index"], _MAX_COUNT)
        and _whole(call["tMs"], _MAX_MS)
        and all(
            _whole(call[name], _MAX_COUNT, nullable=True)
            for name in ("promptTokens", "cacheRead", "cacheWrite", "completionTokens")
        )
        and cost_ok
        and (finish is None or finish in (*FINISH_REASONS, OTHER_FINISH))
        and isinstance(call["final"], bool)
    )


def _tool_call_is_valid(value: object) -> bool:
    call = as_object(value)
    return (
        call is not None
        and call.keys() == _TOOL_CALL_KEYS
        and _whole(call["index"], _MAX_COUNT)
        and call["name"] in (*TRACE_TOOL_NAMES, OTHER_TOOL)
        and _whole(call["resultBytes"], _MAX_TOOL_RESULT_BYTES, nullable=True)
        and isinstance(call["isRepeat"], bool)
    )


def valid_call_trace(value: object) -> dict[str, Any] | None:
    """The trace exactly as the contract has it, or None when it is not. Nothing is repaired."""
    trace = as_object(value)
    if trace is None or trace.keys() != {"truncated", "modelCalls", "toolCalls"}:
        return None
    model_calls: Any = trace["modelCalls"]
    tool_calls: Any = trace["toolCalls"]
    if (
        not isinstance(trace["truncated"], bool)
        or not isinstance(model_calls, list)
        or not isinstance(tool_calls, list)
        or len(model_calls) > MAX_TRACE_ENTRIES  # pyright: ignore[reportUnknownArgumentType]
        or len(tool_calls) > MAX_TRACE_ENTRIES  # pyright: ignore[reportUnknownArgumentType]
    ):
        return None
    models: list[Any] = model_calls  # pyright: ignore[reportUnknownVariableType]
    tools: list[Any] = tool_calls  # pyright: ignore[reportUnknownVariableType]
    if not all(_model_call_is_valid(call) for call in models):
        return None
    if not all(_tool_call_is_valid(call) for call in tools):
        return None
    return trace
