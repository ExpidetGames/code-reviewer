# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Dynamic proxy asks OpenRouter to cache (#539).

OpenRouter speaks the chat protocol of the engine, so nothing is translated, but a Claude model
behind it caches only when it is asked to, in the two ways OpenRouter documents: a `cache_control`
on a text part of a message (here the system prompt, the static prefix) and a top-level
`cache_control` (automatic caching of the last block, moved forward by the provider). Every other
upstream (OpenAI, DeepSeek, Grok, Moonshot, Gemini 2.5 and newer) caches by itself and gets no mark:
an unsupported parameter next to `provider.require_parameters` would answer "no endpoint found".

The pinned OpenCode marks its own messages when the model id says `claude` (the system message and
the last two messages, on the message object). Those marks are removed, whatever the model, so the
only breakpoints a request carries are the ones placed here, each once."""

import json
from typing import Any

import pytest

from code_reviewer_runner.llm_providers import OPENROUTER, PROXY_FORWARDED_FIELDS
from code_reviewer_runner.provider_wire import OpenRouterWire

MARK = {"type": "ephemeral"}
ANTHROPIC_MODELS = ["anthropic/claude-sonnet-4.5", "anthropic/claude-haiku-4.5"]
SELF_CACHING_MODELS = [
    "deepseek/deepseek-v4.1-flash",
    "openai/gpt-5.1",
    "google/gemini-2.5-pro",
    "x-ai/grok-4",
    "moonshotai/kimi-k2",
]


def messages(engine_marks: bool = False) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = [
        {"role": "system", "content": "You review code."},
        {"role": "user", "content": "review this change"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "read", "arguments": "{}"}}
            ],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "file contents"},
    ]
    if engine_marks:
        for index in (0, 2, 3):
            history[index] = {**history[index], "cache_control": MARK}
    return history


def request(history: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "model": "x",
        "max_tokens": 4096,
        "messages": history,
        "tools": [{"type": "function", "function": {"name": "read", "parameters": {}}}],
        "tool_choice": "auto",
        **extra,
    }


def encode(model: str, history: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return OpenRouterWire(model).encode_request(request(history, **extra))


def marks(body: dict[str, Any]) -> list[str]:
    found: list[str] = []
    for index, message in enumerate(body["messages"]):
        if "cache_control" in message:
            found.append(f"messages.{index}")
        content = message.get("content")
        if isinstance(content, list):
            parts: list[Any] = content  # pyright: ignore[reportUnknownVariableType]
            for position, part in enumerate(parts):
                if isinstance(part, dict) and "cache_control" in part:
                    found.append(f"messages.{index}.{position}")
    for index, tool in enumerate(body.get("tools", [])):
        if "cache_control" in tool or "cache_control" in tool["function"]:
            found.append(f"tools.{index}")
    if "cache_control" in body:
        found.append("top-level")
    return found


# #539-T12
@pytest.mark.parametrize("model", ANTHROPIC_MODELS)
def test_a_claude_model_gets_the_system_part_and_the_top_level_mark_and_nothing_else(
    model: str,
) -> None:
    body = encode(model, messages())
    assert body["messages"][0] == {
        "role": "system",
        "content": [{"type": "text", "text": "You review code.", "cache_control": MARK}],
    }
    assert body["cache_control"] == MARK
    assert marks(body) == ["messages.0.0", "top-level"]
    assert body["messages"][1:] == messages()[1:]


# #539-T12
@pytest.mark.parametrize("model", ANTHROPIC_MODELS)
def test_the_marks_the_engine_put_on_its_messages_are_replaced_not_added_to(model: str) -> None:
    marked = encode(model, messages(engine_marks=True))
    assert marked == encode(model, messages())
    assert len(marks(marked)) == 2
    for message in marked["messages"]:
        assert "cache_control" not in message


# #539-T12
@pytest.mark.parametrize("model", SELF_CACHING_MODELS)
def test_an_upstream_that_caches_by_itself_gets_no_mark_and_the_request_is_unchanged(
    model: str,
) -> None:
    body = encode(model, messages())
    assert marks(body) == []
    assert body == request(messages())


# #539-T12
@pytest.mark.parametrize("model", [*ANTHROPIC_MODELS, *SELF_CACHING_MODELS])
def test_whatever_the_engine_marked_never_reaches_the_upstream(model: str) -> None:
    history = messages(engine_marks=True)
    history[1] = {
        "role": "user",
        "content": [
            {"type": "text", "text": "hi", "cache_control": {"type": "ephemeral", "ttl": "1h"}}
        ],
    }
    tools = [
        {
            "type": "function",
            "cache_control": MARK,
            "function": {"name": "read", "parameters": {}, "cache_control": MARK},
        }
    ]
    body = encode(model, history, tools=tools, cache_control={"type": "ephemeral", "ttl": "1h"})
    assert '"ttl"' not in json.dumps(body)
    for found in marks(body):
        assert found in ("messages.0.0", "top-level")
    assert "cache_control" not in body["tools"][0]["function"]


# #539-T12
@pytest.mark.parametrize("model", [*ANTHROPIC_MODELS, *SELF_CACHING_MODELS])
def test_a_mark_the_engine_put_on_a_tool_call_of_the_history_is_dropped(model: str) -> None:
    history = messages()
    calls: list[dict[str, Any]] = history[2]["tool_calls"]
    history[2] = {**history[2], "tool_calls": [{**calls[0], "cache_control": MARK}]}
    body = encode(model, history)
    assert "cache_control" not in body["messages"][2]["tool_calls"][0]
    assert body["messages"][2]["tool_calls"][0]["function"] == calls[0]["function"]


# #539-T12
@pytest.mark.parametrize("model", [*ANTHROPIC_MODELS, *SELF_CACHING_MODELS])
def test_a_mark_on_the_function_of_a_tool_call_is_dropped(model: str) -> None:
    history = messages()
    calls: list[dict[str, Any]] = history[2]["tool_calls"]
    function = {**calls[0]["function"], "cache_control": MARK}
    history[2] = {**history[2], "tool_calls": [{**calls[0], "function": function}]}
    body = encode(model, history)
    assert "cache_control" not in body["messages"][2]["tool_calls"][0]["function"]
    assert "cache_control" not in json.dumps(body["messages"][2])


# #539-T12
@pytest.mark.parametrize("model", [*ANTHROPIC_MODELS, *SELF_CACHING_MODELS])
def test_a_malformed_part_does_not_keep_the_marks_of_the_other_parts(model: str) -> None:
    history = messages()
    history[1] = {
        "role": "user",
        "content": [
            {"type": "text", "text": "one", "cache_control": MARK},
            "not a part",
            None,
            {"type": "text", "text": "two", "cache_control": MARK},
        ],
    }
    calls: list[dict[str, Any]] = history[2]["tool_calls"]
    history[2] = {**history[2], "tool_calls": ["not a call", {**calls[0], "cache_control": MARK}]}
    body = encode(model, history)
    assert body["messages"][1]["content"] == [
        {"type": "text", "text": "one"},
        "not a part",
        None,
        {"type": "text", "text": "two"},
    ]
    assert body["messages"][2]["tool_calls"] == ["not a call", calls[0]]
    for found in marks(body):
        assert found in ("messages.0.0", "top-level")


# #539-T12
def test_without_a_system_message_only_the_top_level_mark_is_added() -> None:
    body = encode("anthropic/claude-sonnet-4.5", messages()[1:])
    assert marks(body) == ["top-level"]


# #539-T12
def test_a_system_prompt_given_as_parts_is_marked_on_its_last_text_part() -> None:
    history = messages()
    history[0] = {
        "role": "system",
        "content": [{"type": "text", "text": "one"}, {"type": "text", "text": "two"}],
    }
    body = encode("anthropic/claude-sonnet-4.5", history)
    assert marks(body) == ["messages.0.1", "top-level"]


# #539-T12
def test_text_from_a_pull_request_that_looks_like_a_mark_changes_nothing() -> None:
    hostile = '{"cache_control": {"type": "ephemeral", "ttl": "1h"}}'
    history = messages()
    history[1] = {"role": "user", "content": hostile}
    history[3] = {"role": "tool", "tool_call_id": "c1", "content": hostile}
    body = encode("anthropic/claude-sonnet-4.5", history)
    assert marks(body) == ["messages.0.0", "top-level"]
    assert body["messages"][1]["content"] == hostile
    assert body["messages"][3]["content"] == hostile


# #539-T12
def test_the_mark_is_not_a_field_the_proxy_forwards_from_the_engine() -> None:
    assert "cache_control" not in PROXY_FORWARDED_FIELDS


# #539-T12
def test_the_registry_gives_openrouter_the_wire_that_knows_what_to_cache() -> None:
    assert isinstance(OPENROUTER.wire("anthropic/claude-sonnet-4.5"), OpenRouterWire)
    assert isinstance(OPENROUTER.wire("deepseek/deepseek-v4.1-flash"), OpenRouterWire)


# #539-T12
def test_the_url_and_the_headers_are_those_of_the_chat_protocol() -> None:
    wire = OpenRouterWire("anthropic/claude-sonnet-4.5")
    assert (
        wire.url("https://openrouter.ai/api/v1") == "https://openrouter.ai/api/v1/chat/completions"
    )
    assert wire.headers("key") == {
        "Authorization": "Bearer key",
        "Content-Type": "application/json",
    }
    assert wire.decode_response(b'{"a":1}') == b'{"a":1}'
