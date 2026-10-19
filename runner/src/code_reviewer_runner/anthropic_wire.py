# SPDX-License-Identifier: Apache-2.0

"""The wire between the Dynamic proxy and the Claude Messages API (#511).

The engine speaks the OpenAI chat protocol to the proxy and the proxy has already checked, bounded
and audited the request. Anthropic's own endpoint (`POST /v1/messages`) is a different protocol, so
this wire translates the request on the way out and the answer on the way back. The Messages API is
used and not Anthropic's OpenAI-compatible endpoint, which Anthropic documents as not meant for
production, ignores `response_format`, `strict` and prompt caching, and reports no cache tokens: the
cost of a call would not be exact.

**What is sent.** The body is built field by field; nothing the engine put in the request is passed
on as it is. `temperature` and `top_p` follow the flags of the model in the list (a 400 from Opus
4.7 on), never both, never for a model the list does not know. Thinking is switched off for the
models that accept it (the chat history of the engine cannot carry thinking blocks back), and the
prompt is cached (below), so a tool loop pays the read price for what it repeats.

**What is cached (#539).** Three explicit breakpoints, never more than four and never two on one
block, all of the provider's default lifetime of five minutes: the end of the static prefix (the
last system block, which covers the tools in front of it; the last tool when there is no system
prompt), the end of the latest turn (what the next call reads) and the end of the turn before it of
the same side (what the previous call wrote, so a read never depends on how far the provider's
look-back of 20 blocks reaches). The top-level automatic mark is not used: it takes one of the four
slots and marks the last block a second time. A mark the engine put on a message (the pinned
OpenCode marks its system message and its last two messages when the model is a Claude) is not
copied, because the body is built field by field; the marks here come from the structure of the
request, never from its text.

**What is refused.** A request whose meaning the provider cannot keep is refused with a stable code
before anything is sent, never downgraded: a forced tool choice for a model that rejects it, content
that is not text, a structured response format, a tool call that is not valid.

**What comes back.** Text, tool calls with their arguments as JSON text, the finish reason, and a
`usage` whose counts the provider's cost rule reads: `prompt_tokens` holds the cache tokens, which
are also named on their own, and what changes a price (tier, speed, region, server tools) is passed
on so the rule can refuse to price what it does not know. Thinking blocks never reach the engine.
"""

import json
import math
from typing import Any, Final

from code_reviewer_runner.anthropic_models import ClaudeModel, model_for
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

ANTHROPIC_VERSION: Final = "2023-06-01"
# The one breakpoint every mark is made of: the provider's default lifetime of five minutes. Every
# read renews the entry for free and a tool loop calls the model every few seconds, so it never
# expires inside a run; a one hour write costs 2x instead of 1.25x and could only pay if the same
# prefix were read again after more than five minutes, which a conversation is not (#539).
CACHE_CONTROL: Final = {"type": "ephemeral"}
# Blocks the provider refuses a breakpoint on.
_UNMARKABLE_BLOCKS: Final = frozenset({"thinking", "redacted_thinking"})

_FINISH_REASONS: Final = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "tool_use": "tool_calls",
    "max_tokens": "length",
    "model_context_window_exceeded": "length",
    "refusal": "content_filter",
    "pause_turn": "stop",
}
# Fields of a usage the translation reads and states again in LiteLLM's names. Any other field is
# passed on as it is for the cost rule (`service_tier`, `speed`, `server_tool_use`, a charge that is
# new): it may decide the price, and the rule refuses to price what it does not know.
_TRANSLATED_FIELDS: Final = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation",
)
_SYSTEM_ROLES: Final = ("system", "developer")


def _policy(detail: str) -> LimitError:
    return LimitError(ErrorCode.DYNAMIC_POLICY_VIOLATION, detail)


def _unsupported(detail: str) -> LimitError:
    return LimitError(ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED, detail)


def _invalid_answer(detail: str) -> LimitError:
    return LimitError(ErrorCode.DYNAMIC_ACCOUNTING_FAILED, detail)


def _text_parts(content: object) -> list[str]:
    """The text pieces of a message content (a string, or a list of text parts); anything else is
    refused, because a part that is not text cannot be carried and must not vanish."""
    if content is None:
        return []
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        raise _policy("the message content is neither text nor a list of parts")
    pieces: list[str] = []
    parts: list[Any] = content  # pyright: ignore[reportUnknownVariableType]
    for part in parts:
        entry = as_object(part)
        text = entry.get("text") if entry is not None else None
        if entry is None or entry.get("type") != "text" or not isinstance(text, str):
            raise _policy("the message holds content that is not text")
        pieces.append(text)
    return pieces


def _visible(text: str) -> bool:
    """The API answers 400 to a text block that is empty or only whitespace, so neither is sent."""
    return bool(text.strip())


def _text_blocks(content: object) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text} for text in _text_parts(content) if _visible(text)]


def _tool_use_blocks(raw: object) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise _policy("the tool calls of a message are not a list")
    blocks: list[dict[str, Any]] = []
    calls: list[Any] = raw  # pyright: ignore[reportUnknownVariableType]
    for call in calls:
        entry = as_object(call)
        function = as_object(entry.get("function")) if entry is not None else None
        call_id = entry.get("id") if entry is not None else None
        name = function.get("name") if function is not None else None
        arguments = function.get("arguments") if function is not None else None
        if (
            entry is None
            or function is None
            or entry.get("type") != "function"
            or not isinstance(call_id, str)
            or not call_id
            or not isinstance(name, str)
            or not name
            or not isinstance(arguments, str)
        ):
            raise _policy("a tool call of the history is malformed")
        try:
            parsed: Any = json.loads(arguments)
        except (ValueError, RecursionError):
            raise _policy("the arguments of a tool call in the history are not JSON") from None
        parsed_input = as_object(parsed)
        if parsed_input is None:
            raise _policy("the arguments of a tool call in the history are not an object")
        blocks.append({"type": "tool_use", "id": call_id, "name": name, "input": parsed_input})
    return blocks


def _convert_messages(raw: object) -> tuple[str, list[dict[str, Any]]]:
    """The system prompt and the alternating turns of a chat history.

    A run of tool messages becomes the tool results of one user turn, in order and before any text
    that follows them (the API wants the results first); same-role neighbours join one turn.
    """
    if not isinstance(raw, list) or not raw:
        raise _policy("the request has no messages")
    system: list[str] = []
    turns: list[dict[str, Any]] = []
    messages: list[Any] = raw  # pyright: ignore[reportUnknownVariableType]

    def add(role: str, blocks: list[dict[str, Any]]) -> None:
        if not blocks:
            return
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"].extend(blocks)
        else:
            turns.append({"role": role, "content": list(blocks)})

    for entry in messages:
        message = as_object(entry)
        role = message.get("role") if message is not None else None
        if message is None or not isinstance(role, str):
            raise _policy("a message has no role")
        if role in _SYSTEM_ROLES:
            system.extend(text for text in _text_parts(message.get("content")) if _visible(text))
        elif role == "user":
            add("user", _text_blocks(message.get("content")))
        elif role == "assistant":
            # Reasoning the engine kept (`reasoning_content`) is not sent back: the model runs
            # without thinking blocks, and text of that kind is not part of the answer.
            add(
                "assistant",
                [
                    *_text_blocks(message.get("content")),
                    *_tool_use_blocks(message.get("tool_calls")),
                ],
            )
        elif role == "tool":
            call_id = message.get("tool_call_id")
            if not isinstance(call_id, str) or not call_id:
                raise _policy("a tool result names no tool call")
            result: dict[str, Any] = {"type": "tool_result", "tool_use_id": call_id}
            content = _text_blocks(message.get("content"))
            if content:
                result["content"] = (
                    content[0]["text"] if len(content) == 1 and _is_plain(message) else content
                )
            add("user", [result])
        else:
            raise _policy("a message has a role the provider does not know")
    return "\n\n".join(system), turns


def _is_plain(message: dict[str, Any]) -> bool:
    """A tool result given as a string stays a string; one given as parts stays a list of blocks."""
    return isinstance(message.get("content"), str)


def _tools(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise _policy("the tools of the request are not a list")
    converted: list[dict[str, Any]] = []
    tools: list[Any] = raw  # pyright: ignore[reportUnknownVariableType]
    for tool in tools:
        entry = as_object(tool)
        function = as_object(entry.get("function")) if entry is not None else None
        name = function.get("name") if function is not None else None
        if entry is None or function is None or entry.get("type") != "function":
            raise _policy("a tool is not a function")
        if not isinstance(name, str) or not name:
            raise _policy("a tool has no name")
        converted_tool: dict[str, Any] = {"name": name}
        description = function.get("description")
        if isinstance(description, str) and description:
            converted_tool["description"] = description
        schema = as_object(function.get("parameters"))
        converted_tool["input_schema"] = (
            schema if schema is not None else {"type": "object", "properties": {}}
        )
        converted.append(converted_tool)
    return converted


def _control() -> dict[str, str]:
    return dict(CACHE_CONTROL)


def _last_markable(turn: dict[str, Any]) -> dict[str, Any] | None:
    for block in reversed(turn["content"]):
        if block.get("type") not in _UNMARKABLE_BLOCKS:
            return block
    return None


def _mark_turns(turns: list[dict[str, Any]]) -> None:
    """The breakpoints inside the conversation: the end of the latest turn and the end of the
    turn before it of the same side (the entry the previous call wrote)."""
    if not turns:
        return
    head = turns[-1]
    candidates = [head]
    for turn in reversed(turns[:-1]):
        if turn["role"] == head["role"]:
            candidates.append(turn)
            break
    for turn in candidates:
        block = _last_markable(turn)
        if block is not None:
            block["cache_control"] = _control()


def _tool_choice(raw: object, parallel: object, model: ClaudeModel | None) -> dict[str, Any] | None:
    choice: dict[str, Any] | None
    forced = False
    if raw is None:
        choice = {"type": "auto"} if parallel is False else None
    elif raw == "auto":
        choice = {"type": "auto"}
    elif raw == "none":
        choice = {"type": "none"}
    elif raw == "required":
        choice, forced = {"type": "any"}, True
    else:
        entry = as_object(raw)
        function = as_object(entry.get("function")) if entry is not None else None
        name = function.get("name") if function is not None else None
        if (
            entry is None
            or entry.get("type") != "function"
            or not isinstance(name, str)
            or not name
        ):
            raise _policy("the tool choice is not one the provider knows")
        choice, forced = {"type": "tool", "name": name}, True
    if forced and model is not None and not model.forced_tool_choice:
        # Not a downgrade to `auto`: the run needs the tool called (the findings come through it).
        raise _unsupported("the model does not take a forced tool choice")
    if choice is not None and parallel is False and choice["type"] != "none":
        choice["disable_parallel_tool_use"] = True
    return choice


def _stop_sequences(raw: object) -> list[str]:
    values: list[Any] = [raw] if isinstance(raw, str) else []
    if isinstance(raw, list):
        values = list(raw)  # pyright: ignore[reportUnknownArgumentType]
    return [value for value in values if isinstance(value, str) and value.strip()]


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _sampling(request: dict[str, Any], model: ClaudeModel | None) -> dict[str, float]:
    """`temperature`, or else `top_p`: only for a model whose flags say it takes one, never both,
    and nothing at all for a model the list does not know."""
    if model is None:
        return {}
    temperature = _number(request.get("temperature"))
    if model.temperature and temperature is not None and temperature >= 0:
        return {"temperature": min(temperature, 1.0)}
    top_p = _number(request.get("top_p"))
    if model.top_p and top_p is not None and 0 <= top_p <= 1:
        return {"top_p": top_p}
    return {}


class AnthropicMessagesWire:
    """The Messages API as the proxy's upstream for one model."""

    def __init__(self, model_id: str) -> None:
        self._model = model_for(model_id)

    def url(self, base: str) -> str:
        return f"{base.rstrip('/')}/messages"

    def headers(self, api_key: str) -> dict[str, str]:
        return {
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }

    def encode_request(self, request: dict[str, Any]) -> dict[str, Any]:
        max_tokens = request.get("max_tokens")
        if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or max_tokens <= 0:
            raise _policy("the request has no usable output bound")
        response_format = as_object(request.get("response_format"))
        if response_format is not None and response_format.get("type") != "text":
            raise _unsupported(
                "the provider has no response format; the run answers through a tool"
            )
        system, turns = _convert_messages(request.get("messages"))
        body: dict[str, Any] = {
            "model": request.get("model"),
            "max_tokens": max_tokens,
            "messages": turns,
        }
        if system:
            body["system"] = [{"type": "text", "text": system, "cache_control": _control()}]
        if request.get("tools") is not None:
            tools = _tools(request["tools"])
            if tools:
                body["tools"] = tools
                if not system:
                    tools[-1]["cache_control"] = _control()
                choice = _tool_choice(
                    request.get("tool_choice"), request.get("parallel_tool_calls"), self._model
                )
                if choice is not None:
                    body["tool_choice"] = choice
        stops = _stop_sequences(request.get("stop"))
        if stops:
            body["stop_sequences"] = stops
        body.update(_sampling(request, self._model))
        if self._model is not None and self._model.thinking_disabled:
            body["thinking"] = {"type": "disabled"}
        _mark_turns(turns)
        return body

    def decode_response(self, body: bytes) -> bytes:
        try:
            parsed: Any = json.loads(body)
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise _invalid_answer("the provider answer is not JSON") from None
        document = as_object(parsed)
        if document is None or document.get("type") != "message":
            raise _invalid_answer("the provider answer is not a message")
        text, calls = _read_content(document.get("content"))
        stop_reason = document.get("stop_reason")
        finish = (
            _FINISH_REASONS.get(stop_reason, "stop") if isinstance(stop_reason, str) else "stop"
        )
        message: dict[str, Any] = {"role": "assistant", "content": text}
        if calls:
            message["tool_calls"] = calls
        choice: dict[str, Any] = {"index": 0, "message": message, "finish_reason": finish}
        if isinstance(stop_reason, str):
            choice["native_finish_reason"] = stop_reason
        completion: dict[str, Any] = {
            "id": document.get("id") if isinstance(document.get("id"), str) else "",
            "object": "chat.completion",
            "created": 0,
            "model": document.get("model") if isinstance(document.get("model"), str) else "",
            "choices": [choice],
        }
        usage = _usage(document.get("usage"))
        if usage is not None:
            completion["usage"] = usage
        return json.dumps(completion, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _read_content(raw: object) -> tuple[str | None, list[dict[str, Any]]]:
    if not isinstance(raw, list):
        raise _invalid_answer("the provider answer has no content blocks")
    texts: list[str] = []
    calls: list[dict[str, Any]] = []
    blocks: list[Any] = raw  # pyright: ignore[reportUnknownVariableType]
    for block in blocks:
        entry = as_object(block)
        if entry is None:
            raise _invalid_answer("a content block of the provider answer is not an object")
        kind = entry.get("type")
        if kind == "text" and isinstance(entry.get("text"), str):
            texts.append(entry["text"])
        elif kind == "tool_use":
            call_id, name = entry.get("id"), entry.get("name")
            arguments = as_object(entry.get("input"))
            if not isinstance(call_id, str) or not isinstance(name, str) or arguments is None:
                raise _invalid_answer("a tool call of the provider answer is malformed")
            calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                }
            )
        # Thinking blocks and every other kind never reach the engine.
    joined = "".join(texts)
    return (joined if joined else None), calls


def _count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _count_or_zero(value: object) -> int | None:
    """A count that may be absent (null or missing is zero); None when it is there and unusable."""
    return 0 if value is None else _count(value)


def _split_total(split: dict[str, Any]) -> int | None:
    """The tokens written to the cache by the two lifetimes of the split, None when unusable."""
    five = _count_or_zero(split.get("ephemeral_5m_input_tokens"))
    hour = _count_or_zero(split.get("ephemeral_1h_input_tokens"))
    return None if five is None or hour is None else five + hour


def _usage(raw: object) -> dict[str, Any] | None:
    """The usage in the shape the proxy and the cost rule read (LiteLLM's names): `prompt_tokens`
    holds the cache tokens. A count that is missing or unusable is left out, so the proxy sees
    no usage and stops the run, as it does for any provider that reports none."""
    usage = as_object(raw)
    if usage is None:
        return None
    translated: dict[str, Any] = {}
    uncached = _count(usage.get("input_tokens"))
    output = _count(usage.get("output_tokens"))
    read = _count_or_zero(usage.get("cache_read_input_tokens"))
    split = as_object(usage.get("cache_creation"))
    written = _count_or_zero(usage.get("cache_creation_input_tokens"))
    if usage.get("cache_creation_input_tokens") is None and split is not None:
        # The documented split (5 minute and 1 hour writes) without the flat count: the split is
        # the count (#534).
        written = _split_total(split)
    if uncached is not None and read is not None and written is not None:
        translated["prompt_tokens"] = uncached + read + written
        translated["cache_read_input_tokens"] = read
        translated["cache_creation_input_tokens"] = written
    if output is not None:
        translated["completion_tokens"] = output
    if "prompt_tokens" in translated and output is not None:
        translated["total_tokens"] = translated["prompt_tokens"] + output
    if split is not None:
        translated["prompt_tokens_details"] = {
            "cached_tokens": translated.get("cache_read_input_tokens", 0),
            "cache_creation_token_details": {
                "ephemeral_5m_input_tokens": split.get("ephemeral_5m_input_tokens"),
                "ephemeral_1h_input_tokens": split.get("ephemeral_1h_input_tokens"),
            },
        }
    for name, value in usage.items():
        if name not in _TRANSLATED_FIELDS:
            translated[name] = value
    return translated
