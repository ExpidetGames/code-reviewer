# SPDX-License-Identifier: Apache-2.0

"""How one model call ended, in words that only come from this module (#312).

The engine reports a turn that ended without a structured answer as `finish=stop,
error=StructuredOutputError`, whatever the model did: wrote prose, sent nothing, or sent a tool call
with broken arguments. The proxy sees what the provider returned, so it notes that: the finish
reason (and the provider's native one), the tools called with whether the structured answer's
arguments are JSON, the size of the text and of the reasoning, the output tokens. Sizes and plain
identifiers only: no model text, no tool argument, no name that is not a short identifier.
"""

import json
import re
from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.dynamic_review.wrap_up import STRUCTURED_OUTPUT_TOOL
from code_reviewer_runner.job_loop.jsonvalues import as_object

_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,39}")
_REASONING_FIELDS = ("reasoning_content", "reasoning")
MAX_TOOLS_NAMED = 4


def _identifier(value: object) -> str:
    return value if isinstance(value, str) and _IDENTIFIER.fullmatch(value) else "other"


def _length(value: object) -> int:
    return len(value) if isinstance(value, str) else 0


def _arguments_are_json(raw: object) -> bool:
    if not isinstance(raw, str):
        return False
    try:
        json.loads(raw)
    except (ValueError, RecursionError):
        return False
    return True


def _tools(message: dict[str, Any]) -> str:
    calls: Any = message.get("tool_calls")
    if not isinstance(calls, list) or not calls:
        return "none"
    entries: list[Any] = calls  # pyright: ignore[reportUnknownVariableType]
    named: list[str] = []
    for call in entries[:MAX_TOOLS_NAMED]:
        entry = as_object(call)
        function = as_object(entry.get("function")) if entry else None
        name = _identifier(function.get("name")) if function else "other"
        if (
            function is not None
            and name == STRUCTURED_OUTPUT_TOOL
            and not _arguments_are_json(function.get("arguments"))
        ):
            name += "(args not json)"
        named.append(name)
    more = len(entries) - MAX_TOOLS_NAMED
    return "+".join(named) + (f"+{more} more" if more > 0 else "")


def describe_call(completion: Mapping[str, Any], *, final: bool) -> str:
    """The note of one provider answer; `final` marks the wrap-up or recovery call."""
    choices: Any = completion.get("choices")
    options: list[Any] = choices if isinstance(choices, list) else []  # pyright: ignore[reportUnknownVariableType]
    first = as_object(options[0]) if options else None
    message = as_object(first.get("message")) if first else None
    if first is None or message is None:
        return "no usable choice" + (", final call" if final else "")
    notes = [f"finish={_identifier(first.get('finish_reason'))}"]
    native: Any = first.get("native_finish_reason")
    if native is not None and native != first.get("finish_reason"):
        notes.append(f"native={_identifier(native)}")
    notes.append(f"tools={_tools(message)}")
    notes.append(f"text={_length(message.get('content'))} chars")
    reasoning = max((_length(message.get(field)) for field in _REASONING_FIELDS), default=0)
    notes.append(f"reasoning={reasoning} chars")
    usage = as_object(completion.get("usage"))
    tokens: Any = usage.get("completion_tokens") if usage else None
    if isinstance(tokens, int) and not isinstance(tokens, bool):
        notes.append(f"output={tokens} tokens")
    if final:
        notes.append("final call")
    return ", ".join(notes)
