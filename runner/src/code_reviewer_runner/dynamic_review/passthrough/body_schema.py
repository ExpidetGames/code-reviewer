# SPDX-License-Identifier: Apache-2.0

"""The closed schema of a request body per wire family (#550).

The engine is hostile: an untrusted model, steered by untrusted repository content, writes what it
sends. Pinning the model and the output cap is not enough, because the provider does more for a
request than answer it: server-side tools (web search, code execution, MCP servers, computer use)
run and are billed at the provider's price and fetch what the request names; an image or file part
makes the provider fetch a URL; `n` bills several choices for one request; routing fields send the
request to another model. So the body is **walked against a closed schema** of exactly what the
pinned engine sends (the keys of `fakes/wire/engine_requests.json`, captured from the real engine
by the engine test), and everything else is refused:

- a key that is not in the family's set is refused, **case sensitively** (`Model` is not `model`,
  and an unknown key is refused whatever it is called); the keys of a nested object are closed too;
- tools are **function tools only** (Chat and Responses `type: function`; Messages without a
  `type`, or `custom`; Google `functionDeclarations`);
- the content parts are text, the tool exchange of the family and the engine's reasoning blocks
  (`thinking`, `redacted_thinking`, Responses `reasoning`, Google `thought`). **No image, audio,
  file or document part at all**: the model entries are text-only, and a part that can carry a URL
  or a file id is a part the provider can fetch. A URL that is text stays text;
- `n` and `candidateCount` are exactly 1, `store` is `false`, there is no `service_tier`,
  `background`, `previous_response_id`, `cachedContent` or routing field (none is a key of the set);
- exactly one spelling of the output cap, within the job's allowance. A second spelling of the same
  field (`max_tokens` and `max_completion_tokens`, `generationConfig.maxOutputTokens` and its
  snake-case twin) is refused, whatever its value.

The walk only checks. The body that is forwarded is the bytes that arrived. What the engine sends
beyond these sets (a provider the capture did not cover) fails closed as `request_not_allowed`, and
the key joins the set when a live capture shows it is the engine's (docs/spike/544-passthrough.md,
section 7). The values of tool schemas, tool arguments and tool results are opaque objects or
strings: the provider does not act on them.
"""

import math
from collections.abc import Callable, Collection, Mapping
from functools import lru_cache
from typing import Any, Final

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of


class NotAllowed(Exception):
    """The body is not one the engine sends. Carries nothing of the body."""


Check = Callable[[Any], None]


def _no() -> NotAllowed:
    return NotAllowed()


def text(value: Any) -> None:
    if not isinstance(value, str):
        raise _no()


def boolean(value: Any) -> None:
    if not isinstance(value, bool):
        raise _no()


def number(value: Any) -> None:
    # A boolean is an int in Python and no number in JSON.
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _no()


def count(value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _no()


def mapping(value: Any) -> None:
    """An object whose content the provider does not act on (a tool schema, a tool's arguments)."""
    if not isinstance(value, dict):
        raise _no()


def null(value: Any) -> None:
    if value is not None:
        raise _no()


def literal(*allowed: Any) -> Check:
    def check(value: Any) -> None:
        # `True == 1` in Python: the type has to be the same as well.
        if not any(value == item and type(value) is type(item) for item in allowed):
            raise _no()

    return check


def bounded(maximum: int) -> Check:
    def check(value: Any) -> None:
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise _no()

    return check


def array(item: Check) -> Check:
    def check(value: Any) -> None:
        if not isinstance(value, list):
            raise _no()
        for element in value:  # pyright: ignore[reportUnknownVariableType]
            item(element)

    return check


def either(*options: Check) -> Check:
    def check(value: Any) -> None:
        for option in options:
            try:
                option(value)
            except NotAllowed:
                continue
            return
        raise _no()

    return check


def obj(fields: Mapping[str, Check], required: Collection[str] = ()) -> Check:
    """An object with exactly these keys (case sensitive), the `required` ones present."""

    def check(value: Any) -> None:
        if not isinstance(value, dict):
            raise _no()
        document: dict[str, Any] = value  # pyright: ignore[reportUnknownVariableType]
        if not document.keys() <= fields.keys() or not set(required) <= document.keys():
            raise _no()
        for name, item in document.items():
            fields[name](item)

    return check


_CACHE_CONTROL: Final = obj({"type": literal("ephemeral"), "ttl": literal("5m", "1h")}, ("type",))
_SAMPLING: Final = {"temperature": number, "top_p": number, "top_k": number}


# -- OpenAI Chat -----------------------------------------------------------------------------------


def _chat(allowance: int) -> Check:
    part = obj(
        {"type": literal("text"), "text": text, "cache_control": _CACHE_CONTROL}, ("type", "text")
    )
    call = obj(
        {
            "id": text,
            "type": literal("function"),
            "function": obj({"name": text, "arguments": text}, ("name", "arguments")),
            "cache_control": _CACHE_CONTROL,
        },
        ("id", "type", "function"),
    )
    detail = obj(
        {
            "type": text,
            "text": text,
            "summary": text,
            "data": text,
            "id": text,
            "format": text,
            "signature": text,
            "index": count,
        }
    )
    message = obj(
        {
            "role": literal("system", "developer", "user", "assistant", "tool"),
            "content": either(text, null, array(part)),
            "tool_calls": array(call),
            "tool_call_id": text,
            "name": text,
            "reasoning_content": text,
            "reasoning_details": array(detail),
            "cache_control": _CACHE_CONTROL,
        },
        ("role",),
    )
    function = obj(
        {"name": text, "description": text, "parameters": mapping, "strict": boolean}, ("name",)
    )
    tool = obj(
        {"type": literal("function"), "function": function, "cache_control": _CACHE_CONTROL},
        ("type", "function"),
    )
    choice = either(
        literal("auto", "none", "required"),
        obj(
            {"type": literal("function"), "function": obj({"name": text}, ("name",))},
            ("type", "function"),
        ),
    )
    return obj(
        {
            "model": text,
            "messages": array(message),
            "tools": array(tool),
            "tool_choice": choice,
            "stream": boolean,
            "stream_options": obj({"include_usage": boolean}),
            # OpenRouter asks for its usage (and cost) this way instead of `stream_options`.
            "usage": obj({"include": literal(True)}, ("include",)),
            "max_tokens": bounded(allowance),
            "max_completion_tokens": bounded(allowance),
            "n": literal(1),
            **_SAMPLING,
        },
        ("model", "messages"),
    )


# -- OpenAI Responses ------------------------------------------------------------------------------


def _responses(allowance: int) -> Check:
    part = obj({"type": literal("input_text", "output_text"), "text": text}, ("type", "text"))
    content = either(text, array(part))
    message = obj(
        {
            "type": literal("message"),
            "role": literal("system", "developer", "user", "assistant"),
            "content": content,
            "id": text,
            "status": text,
        },
        ("role", "content"),
    )
    call = obj(
        {
            "type": literal("function_call"),
            "call_id": text,
            "name": text,
            "arguments": text,
            "id": text,
            "status": text,
        },
        ("type", "call_id", "name", "arguments"),
    )
    output = obj(
        {"type": literal("function_call_output"), "call_id": text, "output": content},
        ("type", "call_id", "output"),
    )
    reasoning = obj(
        {
            "type": literal("reasoning"),
            "id": text,
            "summary": array(
                obj({"type": literal("summary_text"), "text": text}, ("type", "text"))
            ),
            "encrypted_content": either(text, null),
        },
        ("type", "id", "summary"),
    )
    tool = obj(
        {
            "type": literal("function"),
            "name": text,
            "description": text,
            "parameters": mapping,
            "strict": boolean,
        },
        ("type", "name", "parameters"),
    )
    choice = either(
        literal("auto", "none", "required"),
        obj({"type": literal("function"), "name": text}, ("type", "name")),
    )
    return obj(
        {
            "model": text,
            "input": array(either(message, call, output, reasoning)),
            "instructions": text,
            "tools": array(tool),
            "tool_choice": choice,
            "stream": boolean,
            "store": literal(False),
            "prompt_cache_key": text,
            "include": array(literal("reasoning.encrypted_content")),
            "reasoning": obj({"effort": text, "summary": text}),
            "text": obj({"verbosity": text}),
            "parallel_tool_calls": boolean,
            "max_output_tokens": bounded(allowance),
            "temperature": number,
            "top_p": number,
        },
        ("model", "input"),
    )


# -- Anthropic Messages ----------------------------------------------------------------------------


def _messages(allowance: int) -> Check:
    block = obj(
        {"type": literal("text"), "text": text, "cache_control": _CACHE_CONTROL}, ("type", "text")
    )
    tool_use = obj(
        {
            "type": literal("tool_use"),
            "id": text,
            "name": text,
            "input": mapping,
            "cache_control": _CACHE_CONTROL,
        },
        ("type", "id", "name", "input"),
    )
    result = obj(
        {
            "type": literal("tool_result"),
            "tool_use_id": text,
            "content": either(text, array(block)),
            "is_error": boolean,
            "cache_control": _CACHE_CONTROL,
        },
        ("type", "tool_use_id"),
    )
    thinking_block = obj(
        {"type": literal("thinking"), "thinking": text, "signature": text},
        ("type", "thinking", "signature"),
    )
    redacted = obj({"type": literal("redacted_thinking"), "data": text}, ("type", "data"))
    message = obj(
        {
            "role": literal("user", "assistant"),
            "content": either(
                text, array(either(block, tool_use, result, thinking_block, redacted))
            ),
        },
        ("role", "content"),
    )
    tool = obj(
        {
            # Without a type, or `custom`: a function tool. Every other type is a server tool.
            "type": literal("custom"),
            "name": text,
            "description": text,
            "input_schema": mapping,
            "eager_input_streaming": boolean,
            "cache_control": _CACHE_CONTROL,
        },
        ("name", "input_schema"),
    )
    choice = obj(
        {
            "type": literal("auto", "any", "none", "tool"),
            "name": text,
            "disable_parallel_tool_use": boolean,
        },
        ("type",),
    )
    thinking = obj(
        {
            "type": literal("adaptive", "enabled", "disabled"),
            "budget_tokens": bounded(allowance),
            "block_binding": obj({"prefix_mismatch_behavior": text}),
        },
        ("type",),
    )
    return obj(
        {
            "model": text,
            "max_tokens": bounded(allowance),
            "system": either(text, array(block)),
            "messages": array(message),
            "tools": array(tool),
            "tool_choice": choice,
            "thinking": thinking,
            "stream": boolean,
            **_SAMPLING,
        },
        ("model", "messages"),
    )


# -- Google ----------------------------------------------------------------------------------------


def _google(allowance: int) -> Check:
    text_part = obj({"text": text, "thought": boolean, "thoughtSignature": text}, ("text",))
    call = obj(
        {
            "functionCall": obj({"name": text, "args": mapping, "id": text}, ("name",)),
            "thoughtSignature": text,
        },
        ("functionCall",),
    )
    response = obj(
        {
            "functionResponse": obj(
                {"name": text, "response": mapping, "id": text}, ("name", "response")
            )
        },
        ("functionResponse",),
    )
    content = obj(
        {"role": literal("user", "model"), "parts": array(either(text_part, call, response))},
        ("role", "parts"),
    )
    declaration = obj(
        {"name": text, "description": text, "parameters": mapping, "parametersJsonSchema": mapping},
        ("name",),
    )
    tool = obj({"functionDeclarations": array(declaration)}, ("functionDeclarations",))
    config = obj(
        {
            "maxOutputTokens": bounded(allowance),
            "temperature": number,
            "topP": number,
            "topK": number,
            "candidateCount": literal(1),
            "thinkingConfig": obj(
                {"includeThoughts": boolean, "thinkingLevel": text, "thinkingBudget": count}
            ),
        },
        ("maxOutputTokens",),
    )
    tool_config = obj(
        {
            "functionCallingConfig": obj(
                {"mode": literal("AUTO", "ANY", "NONE"), "allowedFunctionNames": array(text)},
                ("mode",),
            )
        },
        ("functionCallingConfig",),
    )
    return obj(
        {
            "contents": array(content),
            "systemInstruction": obj(
                {"role": text, "parts": array(obj({"text": text}, ("text",)))}, ("parts",)
            ),
            "generationConfig": config,
            "tools": array(tool),
            "toolConfig": tool_config,
        },
        ("contents", "generationConfig"),
    )


_BUILD: Final = {
    WireFamily.OPENAI_CHAT: _chat,
    WireFamily.OPENAI_RESPONSES: _responses,
    WireFamily.ANTHROPIC_MESSAGES: _messages,
    WireFamily.GOOGLE: _google,
}


@lru_cache(maxsize=32)
def _schema(family: WireFamily, allowance: int) -> Check:
    return _BUILD[family](allowance)


def check_body(family: WireFamily, document: dict[str, Any], allowance: int) -> int:
    """Walk `document` against the closed schema of `family`; return the output cap it asks for.

    Raises `NotAllowed`. Exactly one spelling of the cap may be present.
    """
    _schema(family, allowance)(document)
    found: list[Any] = []
    for path in spec_of(family).output_caps:
        node: Any = document
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
        if node is not None:
            found.append(node)  # pyright: ignore[reportUnknownArgumentType]
    if len(found) != 1:
        raise _no()
    return int(found[0])
