# SPDX-License-Identifier: Apache-2.0

"""The generic wire fakes' answer builders (#546): four provider formats, one place for the usage.

`fakes/wire/formats.py` writes what a provider of each family answers (OpenAI Chat, OpenAI
Responses, Anthropic Messages, Google Generative Language), as one JSON document and as the stream
of server-sent events, with a distinct usage per call. These tests pin where the usage sits in each
shape, because the passthrough proxy and its usage parsers (#550, #551) are built against exactly
that. The shapes follow the providers' documented formats; a real answer is still the live test of
#546 (see docs/spike/544-passthrough.md, "Open").
"""

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import (
    AUTH_HEADER,
    FAMILIES,
    Family,
    Turn,
    answer,
    error_body,
    parse_sse,
    request_path,
    request_tool_names,
    stream,
    usage_for,
)

MODEL = "acme-model-9"
READ = Turn(tool="read", args={"filePath": "src/app.py"})
FINAL = Turn(text="all done")


def events(family: Family, turn: Turn, call: int = 3) -> list[tuple[str | None, Any]]:
    return parse_sse(stream(family, turn, call, MODEL))


# #546-T10
def test_every_family_has_its_own_auth_header() -> None:
    assert AUTH_HEADER == {
        "chat": "authorization",
        "responses": "authorization",
        "messages": "x-api-key",
        "google": "x-goog-api-key",
    }
    assert FAMILIES == ("chat", "responses", "messages", "google")


def test_each_call_reports_a_different_usage() -> None:
    first, second = usage_for(1), usage_for(2)

    assert first != second
    assert first.input > first.cache_read > 0


# #546-T02
def test_a_chat_answer_carries_its_usage_in_the_usage_object() -> None:
    usage = usage_for(3)

    document = answer("chat", READ, 3, MODEL)

    assert document["usage"] == {
        "prompt_tokens": usage.input,
        "completion_tokens": usage.output,
        "total_tokens": usage.input + usage.output,
        "prompt_tokens_details": {"cached_tokens": usage.cache_read},
        "completion_tokens_details": {"reasoning_tokens": usage.reasoning},
    }
    call = document["choices"][0]["message"]["tool_calls"][0]["function"]
    assert call["name"] == "read"
    assert json.loads(call["arguments"]) == {"filePath": "src/app.py"}


# #546-T02
def test_a_chat_stream_reports_usage_in_a_last_chunk_without_choices() -> None:
    usage = usage_for(3)

    chunks = [data for _, data in events("chat", FINAL)]

    assert chunks[-1] == "[DONE]"
    last = chunks[-2]
    assert last["choices"] == []
    assert last["usage"]["prompt_tokens"] == usage.input
    assert all("usage" not in chunk for chunk in chunks[:-2])
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks[:-2])
    assert text == "all done"


# #546-T02
def test_a_responses_answer_and_stream_report_usage_with_input_and_output_tokens() -> None:
    usage = usage_for(3)
    expected = {
        "input_tokens": usage.input,
        "input_tokens_details": {"cached_tokens": usage.cache_read},
        "output_tokens": usage.output,
        "output_tokens_details": {"reasoning_tokens": usage.reasoning},
        "total_tokens": usage.input + usage.output,
    }

    document = answer("responses", READ, 3, MODEL)
    sequence = events("responses", READ)

    assert document["usage"] == expected
    assert document["output"][0]["type"] == "function_call"
    names = [name for name, _ in sequence]
    assert names[0] == "response.created"
    assert names[-1] == "response.completed"
    assert sequence[-1][1]["response"]["usage"] == expected


# #546-T02
def test_a_messages_stream_splits_the_usage_over_message_start_and_message_delta() -> None:
    usage = usage_for(3)

    sequence = events("messages", FINAL)

    names = [name for name, _ in sequence]
    assert names[0] == "message_start" and names[-1] == "message_stop"
    start = sequence[0][1]["message"]["usage"]
    assert start["input_tokens"] == usage.input
    assert start["cache_read_input_tokens"] == usage.cache_read
    assert start["cache_creation"] == {
        "ephemeral_5m_input_tokens": usage.cache_write_5m,
        "ephemeral_1h_input_tokens": usage.cache_write_1h,
    }
    assert start["cache_creation_input_tokens"] == usage.cache_write_5m + usage.cache_write_1h
    delta = next(data for name, data in sequence if name == "message_delta")
    assert delta["usage"] == {"output_tokens": usage.output}
    assert delta["delta"]["stop_reason"] == "end_turn"


# #546-T02
def test_a_messages_answer_has_the_whole_usage_and_the_tool_use_block() -> None:
    usage = usage_for(3)

    document = answer("messages", READ, 3, MODEL)

    assert document["usage"]["output_tokens"] == usage.output
    assert document["usage"]["cache_creation"]["ephemeral_1h_input_tokens"] == usage.cache_write_1h
    assert document["stop_reason"] == "tool_use"
    block = document["content"][0]
    assert (block["type"], block["name"], block["input"]) == (
        "tool_use",
        "read",
        {"filePath": "src/app.py"},
    )


# #546-T02
def test_a_google_stream_states_the_usage_only_in_the_last_chunk() -> None:
    usage = usage_for(3)

    chunks = [data for _, data in events("google", READ)]

    assert len(chunks) == 2
    assert "usageMetadata" not in chunks[0]
    assert chunks[1]["usageMetadata"] == {
        "promptTokenCount": usage.input,
        "candidatesTokenCount": usage.output,
        "totalTokenCount": usage.input + usage.output + usage.reasoning,
        "cachedContentTokenCount": usage.cache_read,
        "thoughtsTokenCount": usage.reasoning,
    }
    assert chunks[1]["candidates"][0]["finishReason"] == "STOP"
    part = chunks[0]["candidates"][0]["content"]["parts"][0]
    assert part == {"functionCall": {"name": "read", "args": {"filePath": "src/app.py"}}}


def test_a_thinking_turn_puts_the_thought_before_the_tool_call_where_the_family_has_one() -> None:
    turn = Turn(tool="read", args={}, thinking="let me look")

    messages = answer("messages", turn, 4, MODEL)["content"]
    google = answer("google", turn, 4, MODEL)["candidates"][0]["content"]["parts"]

    assert [block["type"] for block in messages] == ["thinking", "tool_use"]
    assert messages[0]["signature"] == "sig-4"
    assert google[0] == {"text": "let me look", "thought": True}
    assert google[1]["thoughtSignature"] == "tsig-read"


# #546-T09
@pytest.mark.parametrize(
    ("family", "streaming", "expected"),
    [
        ("chat", True, "/v1/chat/completions"),
        ("responses", True, "/v1/responses"),
        ("messages", True, "/v1/messages"),
        ("google", True, f"/v1beta/models/{MODEL}:streamGenerateContent"),
        ("google", False, f"/v1beta/models/{MODEL}:generateContent"),
    ],
)
def test_the_path_of_a_family_names_the_model_only_for_google(
    family: Family, streaming: bool, expected: str
) -> None:
    assert request_path(family, MODEL, streaming=streaming) == expected


def test_the_tools_a_request_offers_are_found_in_every_family() -> None:
    names = ["read", "grep"]
    bodies: dict[Family, dict[str, Any]] = {
        "chat": {"tools": [{"type": "function", "function": {"name": n}} for n in names]},
        "responses": {"tools": [{"type": "function", "name": n} for n in names]},
        "messages": {"tools": [{"name": n, "input_schema": {}} for n in names]},
        "google": {"tools": [{"functionDeclarations": [{"name": n} for n in names]}]},
    }

    for family, body in bodies.items():
        assert request_tool_names(family, body) == names
        assert request_tool_names(family, {}) == []


def test_an_error_body_has_the_envelope_of_its_provider() -> None:
    assert error_body("chat", 429)["error"]["message"]
    assert error_body("responses", 500)["error"]["message"]
    assert error_body("messages", 429)["error"]["type"] == "rate_limit_error"
    assert error_body("messages", 529)["error"]["type"] == "overloaded_error"
    assert error_body("google", 429)["error"]["status"] == "RESOURCE_EXHAUSTED"
