# SPDX-License-Identifier: Apache-2.0

"""The streamed form of one buffered chat completion (#197).

The pinned engine always asks for a streamed answer (`stream: true` with `include_usage`). The
proxy does not relay a stream: it asks the provider for the whole answer, bounds, audits and
accounts it, and only then hands the engine the same answer as a short server-sent-event stream.
Nothing reaches the engine before the response byte bound, the usage and the tool-call bound have
passed, which a relayed stream could not promise, and the provider's counters stay authoritative.

The mapping is the plain OpenAI chat-completions one: the complete message becomes one delta chunk
(role, text, reasoning and the tool calls with their stream `index`), the finish reason and the
provider's own usage object become the closing chunk, then `[DONE]`. Nothing is invented: a field
the provider did not send is not sent.
"""

import json
from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object

_COPIED = ("id", "created", "model", "system_fingerprint")
_REASONING_FIELDS = ("reasoning_content", "reasoning")


def _chunk(base: Mapping[str, Any], choice: dict[str, Any], usage: object = None) -> bytes:
    document: dict[str, Any] = {**base, "object": "chat.completion.chunk", "choices": [choice]}
    if usage is not None:
        document["usage"] = usage
    return b"data: " + json.dumps(document).encode("utf-8") + b"\n\n"


def completion_as_stream(completion: Mapping[str, Any]) -> bytes | None:
    """The completion as an event stream, or None when it has no usable first choice."""
    choices: Any = completion.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    entries: list[Any] = choices  # pyright: ignore[reportUnknownVariableType]
    first = as_object(entries[0])
    message = as_object(first.get("message")) if first else None
    if first is None or message is None:
        return None
    base = {key: completion[key] for key in _COPIED if key in completion}
    delta: dict[str, Any] = {"role": "assistant"}
    content: Any = message.get("content")
    if isinstance(content, str):
        delta["content"] = content
    for field in _REASONING_FIELDS:
        reasoning: Any = message.get(field)
        if isinstance(reasoning, str):
            delta[field] = reasoning
    calls: Any = message.get("tool_calls")
    streamed: list[dict[str, Any]] = []
    if isinstance(calls, list):
        entries_calls: list[Any] = calls  # pyright: ignore[reportUnknownVariableType]
        for index, call in enumerate(entries_calls):
            document = as_object(call)
            if document is not None:
                streamed.append({**document, "index": index})
    if streamed:
        delta["tool_calls"] = streamed
    finish: Any = first.get("finish_reason")
    if finish == "stop" and streamed:
        # A provider may say `stop` for a step that asked for tools. The pinned engine takes that
        # for the end of the turn and, with no structured answer yet, fails it (#309), although
        # the step is a tool step. Report what the step is.
        finish = "tool_calls"
    usage: Any = completion.get("usage")
    return (
        _chunk(base, {"index": 0, "delta": delta, "finish_reason": None})
        + _chunk(
            base,
            {
                "index": 0,
                "delta": {},
                "finish_reason": finish if isinstance(finish, str) else "stop",
            },
            usage,
        )
        + b"data: [DONE]\n\n"
    )
