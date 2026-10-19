# SPDX-License-Identifier: Apache-2.0

"""What a provider of each wire family answers (#546): the generic fakes' shapes.

Four families cover every provider that authenticates with a static key (#544): OpenAI Chat and the
many OpenAI-compatible providers, OpenAI Responses, Anthropic Messages and Google's Generative
Language API. Each family has one JSON answer and one stream of server-sent events, both built from
the same `Turn` (a tool call or a text, optionally with a thought) and a `Usage` that differs from
call to call, so a test can tell which call a number came from.

The shapes follow the providers' documented formats and what the pinned OpenCode's bundled AI SDKs
parse. They are NOT captured from a real provider: that is the live test of #546 and the fixtures of
#551. Where the usage sits is the part the passthrough proxy depends on:

| Family | Answer | Stream |
|---|---|---|
| chat | `usage` | the last data chunk, with `choices: []` (needs `stream_options.include_usage`) |
| responses | `usage` | `response.completed` |
| messages | `usage` | input and cache in `message_start`, cumulative output in `message_delta` |
| google | `usageMetadata` | `usageMetadata` on the last chunk |
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Literal

Family = Literal["chat", "responses", "messages", "google"]
FAMILIES: Final[tuple[Family, ...]] = ("chat", "responses", "messages", "google")

# The header that carries the key. The swap table of the proxy has these three entries.
AUTH_HEADER: Final[dict[Family, str]] = {
    "chat": "authorization",
    "responses": "authorization",
    "messages": "x-api-key",
    "google": "x-goog-api-key",
}


def auth_value(family: Family, key: str) -> str:
    """The value of the auth header for a key: a bearer token, or the bare key."""
    return f"Bearer {key}" if AUTH_HEADER[family] == "authorization" else key


@dataclass(frozen=True)
class Turn:
    """What the scripted model does in one call: ask for one tool, or say something."""

    tool: str | None = None
    args: Mapping[str, Any] = field(default_factory=lambda: {})
    text: str = ""
    thinking: str = ""


@dataclass(frozen=True)
class Usage:
    input: int
    output: int
    cache_read: int
    cache_write_5m: int
    cache_write_1h: int
    reasoning: int


def usage_for(call: int) -> Usage:
    """A usage that is different for every call number, with every field non-zero."""
    return Usage(
        input=1000 + 10 * call,
        output=20 + call,
        cache_read=300 + call,
        cache_write_5m=50 + call,
        cache_write_1h=7 + call,
        reasoning=5 + call,
    )


def request_path(family: Family, model: str, *, streaming: bool = True) -> str:
    """The path of the chat call. Google puts the model and the choice of stream in the path."""
    if family == "chat":
        return "/v1/chat/completions"
    if family == "responses":
        return "/v1/responses"
    if family == "messages":
        return "/v1/messages"
    method = "streamGenerateContent" if streaming else "generateContent"
    return f"/v1beta/models/{model}:{method}"


def request_tool_names(family: Family, body: Mapping[str, Any]) -> list[str]:
    """The names of the tools a request offers, in its order."""
    tools: list[Any] = body.get("tools") or []
    if family == "chat":
        return [tool["function"]["name"] for tool in tools]
    if family in ("responses", "messages"):
        return [tool["name"] for tool in tools]
    return [declared["name"] for tool in tools for declared in tool.get("functionDeclarations", [])]


def is_stream(family: Family, path: str, body: Mapping[str, Any] | None) -> bool:
    """Whether the request asks for a stream: a field of the body, or for Google the method."""
    if family == "google":
        return path.endswith(":streamGenerateContent")
    return bool(body and body.get("stream"))


def error_body(family: Family, status: int) -> dict[str, Any]:
    """The error envelope of a provider for a status (the text is made up)."""
    message = f"fake upstream {status}"
    if family == "messages":
        kind = "rate_limit_error" if status == 429 else "overloaded_error"
        return {"type": "error", "error": {"type": kind, "message": message}}
    if family == "google":
        return {"error": {"code": status, "message": message, "status": "RESOURCE_EXHAUSTED"}}
    return {"error": {"message": message, "type": "fake", "code": str(status)}}


def parse_sse(chunks: list[bytes]) -> list[tuple[str | None, Any]]:
    """The events of a stream as (event name, JSON data); a data line that is no JSON stays text."""
    parsed: list[tuple[str | None, Any]] = []
    for chunk in chunks:
        name: str | None = None
        data = ""
        for line in chunk.decode("utf-8").splitlines():
            if line.startswith("event: "):
                name = line.removeprefix("event: ")
            elif line.startswith("data: "):
                data = line.removeprefix("data: ")
        try:
            parsed.append((name, json.loads(data)))
        except ValueError:
            parsed.append((name, data))
    return parsed


def _sse(events: list[tuple[str | None, Any]]) -> list[bytes]:
    chunks: list[bytes] = []
    for name, data in events:
        payload = data if isinstance(data, str) else json.dumps(data)
        head = f"event: {name}\n" if name else ""
        chunks.append(f"{head}data: {payload}\n\n".encode())
    return chunks


# -- OpenAI Chat ---------------------------------------------------------------------------------


def _chat_usage(call: int) -> dict[str, Any]:
    usage = usage_for(call)
    return {
        "prompt_tokens": usage.input,
        "completion_tokens": usage.output,
        "total_tokens": usage.input + usage.output,
        "prompt_tokens_details": {"cached_tokens": usage.cache_read},
        "completion_tokens_details": {"reasoning_tokens": usage.reasoning},
    }


def _chat_answer(turn: Turn, call: int, model: str) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": turn.text or None}
    if turn.tool:
        message["tool_calls"] = [
            {
                "id": f"call_{call}",
                "type": "function",
                "function": {"name": turn.tool, "arguments": json.dumps(dict(turn.args))},
            }
        ]
    return {
        "id": f"chatcmpl-{call}",
        "object": "chat.completion",
        "created": 1,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if turn.tool else "stop",
            }
        ],
        "usage": _chat_usage(call),
    }


def _chat_stream(turn: Turn, call: int, model: str) -> list[bytes]:
    def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {
            "id": f"chatcmpl-{call}",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    events: list[tuple[str | None, Any]] = [(None, chunk({"role": "assistant"}))]
    if turn.tool:
        arguments = json.dumps(dict(turn.args))
        half = len(arguments) // 2
        opening = {
            "index": 0,
            "id": f"call_{call}",
            "type": "function",
            "function": {"name": turn.tool, "arguments": arguments[:half]},
        }
        events.append((None, chunk({"tool_calls": [opening]})))
        rest = {"index": 0, "function": {"arguments": arguments[half:]}}
        events.append((None, chunk({"tool_calls": [rest]})))
        events.append((None, chunk({}, "tool_calls")))
    else:
        middle = max(1, len(turn.text) // 2)
        events.append((None, chunk({"content": turn.text[:middle]})))
        events.append((None, chunk({"content": turn.text[middle:]})))
        events.append((None, chunk({}, "stop")))
    closing = chunk({})
    closing["choices"] = []
    closing["usage"] = _chat_usage(call)
    events.append((None, closing))
    events.append((None, "[DONE]"))
    return _sse(events)


# -- OpenAI Responses ----------------------------------------------------------------------------


def _responses_usage(call: int) -> dict[str, Any]:
    usage = usage_for(call)
    return {
        "input_tokens": usage.input,
        "input_tokens_details": {"cached_tokens": usage.cache_read},
        "output_tokens": usage.output,
        "output_tokens_details": {"reasoning_tokens": usage.reasoning},
        "total_tokens": usage.input + usage.output,
    }


def _responses_item(turn: Turn, call: int, status: str) -> dict[str, Any]:
    if turn.tool:
        return {
            "type": "function_call",
            "id": f"fc_{call}",
            "call_id": f"call_{call}",
            "name": turn.tool,
            "arguments": json.dumps(dict(turn.args)),
            "status": status,
        }
    return {
        "type": "message",
        "id": f"msg_{call}",
        "role": "assistant",
        "status": status,
        "content": [{"type": "output_text", "text": turn.text, "annotations": []}],
    }


def _responses_answer(turn: Turn, call: int, model: str) -> dict[str, Any]:
    return {
        "id": f"resp_{call}",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "model": model,
        "output": [_responses_item(turn, call, "completed")],
        "usage": _responses_usage(call),
        "incomplete_details": None,
    }


def _responses_stream(turn: Turn, call: int, model: str) -> list[bytes]:
    base = {"id": f"resp_{call}", "created_at": 1, "model": model}
    opening = _responses_item(turn, call, "in_progress")
    if turn.tool:
        opening["arguments"] = ""
    else:
        opening["content"] = []
    events: list[tuple[str | None, Any]] = [
        (
            "response.created",
            {"type": "response.created", "response": {**base, "status": "in_progress"}},
        ),
        (
            "response.output_item.added",
            {"type": "response.output_item.added", "output_index": 0, "item": opening},
        ),
    ]
    if turn.tool:
        events.append(
            (
                "response.function_call_arguments.delta",
                {
                    "type": "response.function_call_arguments.delta",
                    "item_id": f"fc_{call}",
                    "output_index": 0,
                    "delta": json.dumps(dict(turn.args)),
                },
            )
        )
    else:
        part: dict[str, Any] = {"type": "output_text", "text": "", "annotations": []}
        events.append(
            (
                "response.content_part.added",
                {
                    "type": "response.content_part.added",
                    "item_id": f"msg_{call}",
                    "output_index": 0,
                    "content_index": 0,
                    "part": part,
                },
            )
        )
        events.append(
            (
                "response.output_text.delta",
                {
                    "type": "response.output_text.delta",
                    "item_id": f"msg_{call}",
                    "output_index": 0,
                    "content_index": 0,
                    "delta": turn.text,
                },
            )
        )
    events.append(
        (
            "response.output_item.done",
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": _responses_item(turn, call, "completed"),
            },
        )
    )
    completed = {
        **base,
        "status": "completed",
        "incomplete_details": None,
        "usage": _responses_usage(call),
    }
    events.append(("response.completed", {"type": "response.completed", "response": completed}))
    return _sse(events)


# -- Anthropic Messages --------------------------------------------------------------------------


def _messages_usage(call: int) -> dict[str, Any]:
    usage = usage_for(call)
    return {
        "input_tokens": usage.input,
        "output_tokens": usage.output,
        "cache_creation_input_tokens": usage.cache_write_5m + usage.cache_write_1h,
        "cache_read_input_tokens": usage.cache_read,
        "cache_creation": {
            "ephemeral_5m_input_tokens": usage.cache_write_5m,
            "ephemeral_1h_input_tokens": usage.cache_write_1h,
        },
        "service_tier": "standard",
    }


def _messages_content(turn: Turn, call: int) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    if turn.thinking:
        content.append({"type": "thinking", "thinking": turn.thinking, "signature": f"sig-{call}"})
    if turn.tool:
        content.append(
            {"type": "tool_use", "id": f"toolu_{call}", "name": turn.tool, "input": dict(turn.args)}
        )
    else:
        content.append({"type": "text", "text": turn.text})
    return content


def _messages_answer(turn: Turn, call: int, model: str) -> dict[str, Any]:
    return {
        "id": f"msg_{call}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": _messages_content(turn, call),
        "stop_reason": "tool_use" if turn.tool else "end_turn",
        "stop_sequence": None,
        "usage": _messages_usage(call),
    }


def _messages_stream(turn: Turn, call: int, model: str) -> list[bytes]:
    usage = _messages_usage(call)
    message: dict[str, Any] = {
        "id": f"msg_{call}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [],
        "stop_reason": None,
        "stop_sequence": None,
        "usage": {**usage, "output_tokens": 1},
    }
    events: list[tuple[str | None, Any]] = [
        ("message_start", {"type": "message_start", "message": message})
    ]
    for index, block in enumerate(_messages_content(turn, call)):
        opening: dict[str, Any]
        deltas: list[dict[str, Any]]
        if block["type"] == "thinking":
            opening = {"type": "thinking", "thinking": ""}
            deltas = [
                {"type": "thinking_delta", "thinking": block["thinking"]},
                {"type": "signature_delta", "signature": block["signature"]},
            ]
        elif block["type"] == "tool_use":
            opening = {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}
            deltas = [{"type": "input_json_delta", "partial_json": json.dumps(block["input"])}]
        else:
            opening = {"type": "text", "text": ""}
            deltas = [{"type": "text_delta", "text": block["text"]}]
        events.append(
            (
                "content_block_start",
                {"type": "content_block_start", "index": index, "content_block": opening},
            )
        )
        for delta in deltas:
            events.append(
                (
                    "content_block_delta",
                    {"type": "content_block_delta", "index": index, "delta": delta},
                )
            )
        events.append(("content_block_stop", {"type": "content_block_stop", "index": index}))
    events.append(
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {
                    "stop_reason": "tool_use" if turn.tool else "end_turn",
                    "stop_sequence": None,
                },
                "usage": {"output_tokens": usage["output_tokens"]},
            },
        )
    )
    events.append(("message_stop", {"type": "message_stop"}))
    return _sse(events)


# -- Google Generative Language ------------------------------------------------------------------


def _google_usage(call: int) -> dict[str, Any]:
    usage = usage_for(call)
    return {
        "promptTokenCount": usage.input,
        "candidatesTokenCount": usage.output,
        "totalTokenCount": usage.input + usage.output + usage.reasoning,
        "cachedContentTokenCount": usage.cache_read,
        "thoughtsTokenCount": usage.reasoning,
    }


def _google_answer(turn: Turn, call: int, model: str) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    if turn.thinking:
        parts.append({"text": turn.thinking, "thought": True})
    if turn.tool:
        part: dict[str, Any] = {"functionCall": {"name": turn.tool, "args": dict(turn.args)}}
        if turn.thinking:
            part["thoughtSignature"] = f"tsig-{turn.tool}"
        parts.append(part)
    else:
        parts.append({"text": turn.text})
    return {
        "candidates": [
            {
                "content": {"role": "model", "parts": parts},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "usageMetadata": _google_usage(call),
        "modelVersion": model,
        "responseId": f"r{call}",
    }


def _google_stream(turn: Turn, call: int, model: str) -> list[bytes]:
    first = _google_answer(turn, call, model)
    del first["candidates"][0]["finishReason"]
    del first["usageMetadata"]
    last = _google_answer(Turn(text=""), call, model)
    return _sse([(None, first), (None, last)])


def answer(family: Family, turn: Turn, call: int, model: str) -> dict[str, Any]:
    """The whole answer of a non-streaming call."""
    if family == "chat":
        return _chat_answer(turn, call, model)
    if family == "responses":
        return _responses_answer(turn, call, model)
    if family == "messages":
        return _messages_answer(turn, call, model)
    return _google_answer(turn, call, model)


def stream(family: Family, turn: Turn, call: int, model: str) -> list[bytes]:
    """The events of a streaming call, each a complete `event:`/`data:` block with a blank line."""
    if family == "chat":
        return _chat_stream(turn, call, model)
    if family == "responses":
        return _responses_stream(turn, call, model)
    if family == "messages":
        return _messages_stream(turn, call, model)
    return _google_stream(turn, call, model)
