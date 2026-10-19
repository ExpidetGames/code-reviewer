# SPDX-License-Identifier: Apache-2.0

"""The wire between the Dynamic proxy and the Claude Messages API (#511).

The engine speaks the OpenAI chat protocol; Anthropic's Messages API is a different one (a
separate `system`, content blocks, tool results inside a user turn, `tool_choice` and
`stop_sequences` of its own). The wire translates the request the proxy has already checked, and the
answer into the chat completion the rest of the proxy works on. What it must keep exact:

- what is sent: nothing the model refuses (`temperature` and `top_p` by the flag of the model, never
  both, never for a model the list does not know), nothing the engine did not ask for;
- what it will not do: change the meaning of a request (a forced tool choice for a model that
  rejects it, content that is not text) is refused with a stable code, not downgraded;
- what comes back: text, tool calls with parsed arguments, the finish reason, and a usage whose
  counts the cost rule reads (cache tokens included)."""

import json
from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.anthropic_models import MODELS
from code_reviewer_runner.anthropic_wire import AnthropicMessagesWire
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.llm_providers import ANTHROPIC
from code_reviewer_runner.result import ErrorCode

# A model that takes everything the engine sends: forced tool choice, thinking off, no sampling.
MODEL = "claude-sonnet-5"
# One that takes sampling parameters.
SAMPLING_MODEL = "claude-sonnet-4-6"


def wire(model: str = MODEL) -> AnthropicMessagesWire:
    return AnthropicMessagesWire(model)


def request(**extra: Any) -> dict[str, Any]:
    """What the proxy hands the wire: the allow-listed fields, the model, the output, no stream."""
    body: dict[str, Any] = {
        "model": MODEL,
        "max_tokens": 4096,
        "stream": False,
        "messages": [{"role": "user", "content": "review this"}],
    }
    body.update(extra)
    return body


def encode(model: str = MODEL, **extra: Any) -> dict[str, Any]:
    return wire(model).encode_request(request(model=model, **extra))


def refused(model: str = MODEL, **extra: Any) -> LimitError:
    with pytest.raises(LimitError) as caught:
        encode(model, **extra)
    return caught.value


TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "read",
        "description": "Read a file",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
}
STRUCTURED: dict[str, Any] = {
    "type": "function",
    "function": {"name": "StructuredOutput", "parameters": {"type": "object"}},
}


# #511-T21
def test_the_endpoint_and_the_headers_are_those_of_the_messages_api() -> None:
    w = wire()

    assert w.url("https://api.anthropic.com/v1") == "https://api.anthropic.com/v1/messages"
    assert w.url("http://127.0.0.1:4010/api/v1") == "http://127.0.0.1:4010/api/v1/messages"
    headers = w.headers("sk-ant-key")
    assert headers == {
        "x-api-key": "sk-ant-key",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }


# #511-T21
def test_a_plain_request_becomes_a_message_request_without_streaming_or_thinking() -> None:
    body = encode()

    assert body == {
        "model": MODEL,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "review this"}]}],
        # The engine's history cannot carry thinking blocks, so the model runs without them.
        "thinking": {"type": "disabled"},
        # Caching of the growing history of a tool loop (the cost reads the cache tokens).
        "cache_control": {"type": "ephemeral"},
    }


# #511-T21
def test_system_and_developer_text_becomes_the_system_prompt() -> None:
    body = encode(
        messages=[
            {"role": "system", "content": "You are a reviewer."},
            {"role": "developer", "content": [{"type": "text", "text": "Be brief."}]},
            {"role": "user", "content": "hi"},
        ]
    )

    assert body["system"] == "You are a reviewer.\n\nBe brief."
    assert [m["role"] for m in body["messages"]] == ["user"]


# #511-T21
def test_a_tool_loop_becomes_tool_use_and_tool_result_blocks_in_the_right_turns() -> None:
    body = encode(
        messages=[
            {"role": "user", "content": "review"},
            {
                "role": "assistant",
                "content": "I will read two files.",
                "tool_calls": [
                    {
                        "id": "toolu_1",
                        "type": "function",
                        "function": {"name": "read", "arguments": '{"path": "a.py"}'},
                    },
                    {
                        "id": "toolu_2",
                        "type": "function",
                        "function": {"name": "read", "arguments": '{"path": "b.py"}'},
                    },
                ],
            },
            {"role": "tool", "tool_call_id": "toolu_1", "content": "print(1)"},
            {"role": "tool", "tool_call_id": "toolu_2", "content": [{"type": "text", "text": "x"}]},
            {"role": "user", "content": "continue"},
        ],
        tools=[TOOL],
    )

    assert body["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "review"}]},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "I will read two files."},
                {"type": "tool_use", "id": "toolu_1", "name": "read", "input": {"path": "a.py"}},
                {"type": "tool_use", "id": "toolu_2", "name": "read", "input": {"path": "b.py"}},
            ],
        },
        # Both results in one user turn, before the text that follows them.
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "print(1)"},
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_2",
                    "content": [{"type": "text", "text": "x"}],
                },
                {"type": "text", "text": "continue"},
            ],
        },
    ]


# #511-T21
def test_an_assistant_turn_without_content_or_calls_is_left_out_and_empty_text_is_never_sent() -> (
    None
):
    body = encode(
        messages=[
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": ""},
            {"role": "assistant", "content": None, "reasoning_content": "thinking out loud"},
            {
                "role": "user",
                "content": [{"type": "text", "text": ""}, {"type": "text", "text": "b"}],
            },
        ]
    )

    assert body["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "go"}, {"type": "text", "text": "b"}]}
    ]
    assert "thinking out loud" not in json.dumps(body)


# #511-T21
def test_a_tool_result_without_content_is_sent_without_content() -> None:
    body = encode(
        messages=[
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "t1",
                        "type": "function",
                        "function": {"name": "read", "arguments": "{}"},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "t1", "content": ""},
        ],
        tools=[TOOL],
    )

    assert body["messages"][-1] == {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "t1"}],
    }


# #511-T21
def test_the_tools_become_input_schemas_and_the_strict_flag_is_not_carried() -> None:
    strict = {"type": "function", "function": {**TOOL["function"], "strict": True}}
    bare = {"type": "function", "function": {"name": "ping"}}

    body = encode(tools=[strict, bare])

    assert body["tools"] == [
        {
            "name": "read",
            "description": "Read a file",
            "input_schema": TOOL["function"]["parameters"],
        },
        {"name": "ping", "input_schema": {"type": "object", "properties": {}}},
    ]


# #511-T21
@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (None, None),
        ("auto", {"type": "auto"}),
        ("none", {"type": "none"}),
        ("required", {"type": "any"}),
        (
            {"type": "function", "function": {"name": "StructuredOutput"}},
            {"type": "tool", "name": "StructuredOutput"},
        ),
    ],
)
def test_every_form_of_tool_choice_has_its_counterpart(
    given: Any, expected: dict[str, Any] | None
) -> None:
    extra: dict[str, Any] = {"tools": [TOOL, STRUCTURED]}
    if given is not None:
        extra["tool_choice"] = given

    body = encode(**extra)

    assert body.get("tool_choice") == expected


# #511-T21
def test_parallel_tool_calls_off_is_carried_into_the_tool_choice() -> None:
    assert encode(tools=[TOOL], parallel_tool_calls=False)["tool_choice"] == {
        "type": "auto",
        "disable_parallel_tool_use": True,
    }
    assert encode(tools=[TOOL], tool_choice="required", parallel_tool_calls=False)[
        "tool_choice"
    ] == {"type": "any", "disable_parallel_tool_use": True}
    assert "tool_choice" not in encode(tools=[TOOL], parallel_tool_calls=True)
    # No tools, no tool choice: the API refuses one without tools.
    assert "tool_choice" not in encode(tool_choice="auto")
    assert "tool_choice" not in encode(parallel_tool_calls=False)


# #511-T21
def test_stop_sequences_are_carried_without_the_blank_ones() -> None:
    assert encode(stop="END")["stop_sequences"] == ["END"]
    assert encode(stop=["END", "  ", "", "STOP"])["stop_sequences"] == ["END", "STOP"]
    assert "stop_sequences" not in encode(stop=[" "])
    assert "stop_sequences" not in encode(stop=None)


# #511-T21
def test_fields_without_a_counterpart_are_not_sent() -> None:
    body = encode(
        seed=7,
        frequency_penalty=0.5,
        presence_penalty=0.5,
        response_format={"type": "text"},
        stream=True,
    )

    for name in ("seed", "frequency_penalty", "presence_penalty", "response_format", "stream"):
        assert name not in body


# #511-T21: the body is built from fields; whatever else the caller put in the request is not sent.
def test_nothing_outside_the_translated_fields_reaches_the_provider() -> None:
    body = encode(provider={"order": ["x"]}, metadata={"user_id": "someone"}, user="someone")

    assert set(body) == {"model", "max_tokens", "messages", "thinking", "cache_control"}


# #511-T22
def test_a_forced_tool_choice_for_a_model_that_rejects_it_is_refused_not_downgraded() -> None:
    for model in ("claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"):
        for choice in ("required", {"type": "function", "function": {"name": "StructuredOutput"}}):
            error = refused(model, tools=[STRUCTURED], tool_choice=choice)
            assert error.code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED

    # `auto` and `none` are fine for them.
    assert encode("claude-sonnet-5-5", tools=[TOOL], tool_choice="auto")["tool_choice"] == {
        "type": "auto"
    }


# #511-T22
@pytest.mark.parametrize(
    "content",
    [
        [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}],
        [{"type": "input_audio", "input_audio": {"data": "x", "format": "wav"}}],
        [{"type": "text", "text": "ok"}, {"type": "file", "file": {"file_id": "f"}}],
        [{"text": "no type"}],
        [{"type": "text", "text": 5}],
        ["a bare string in a list"],
        {"type": "text", "text": "an object"},
        5,
    ],
    ids=repr,
)
def test_content_that_is_not_text_is_refused_with_a_stable_code(content: Any) -> None:
    error = refused(messages=[{"role": "user", "content": content}])

    assert error.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #511-T22
@pytest.mark.parametrize(
    "calls",
    [
        [{"id": "t", "type": "function", "function": {"name": "read", "arguments": "not json"}}],
        [{"id": "t", "type": "function", "function": {"name": "read", "arguments": "[1]"}}],
        [{"id": "t", "type": "function", "function": {"name": "read", "arguments": 5}}],
        [{"id": "t", "type": "function", "function": {"arguments": "{}"}}],
        [{"id": "", "type": "function", "function": {"name": "read", "arguments": "{}"}}],
        [{"type": "function", "function": {"name": "read", "arguments": "{}"}}],
        [{"id": "t", "type": "custom", "function": {"name": "read", "arguments": "{}"}}],
        ["call"],
        "calls",
    ],
    ids=repr,
)
def test_a_malformed_tool_call_in_the_history_is_refused(calls: Any) -> None:
    error = refused(
        messages=[
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": None, "tool_calls": calls},
        ]
    )

    assert error.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #511-T22
@pytest.mark.parametrize(
    "messages",
    [
        [{"role": "function", "content": "x"}],
        [{"role": "tool", "content": "x"}],
        [{"role": "tool", "tool_call_id": "", "content": "x"}],
        [{"content": "no role"}],
        ["a bare string"],
        "not a list",
        [],
    ],
    ids=repr,
)
def test_a_message_list_the_provider_cannot_take_is_refused(messages: Any) -> None:
    assert refused(messages=messages).code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #511-T22
@pytest.mark.parametrize(
    "extra",
    [
        {"tools": "tools"},
        {"tools": [{"type": "retrieval"}]},
        {"tools": [{"type": "function", "function": {"description": "no name"}}]},
        {"tools": [TOOL], "tool_choice": "sometimes"},
        {"tools": [TOOL], "tool_choice": {"type": "function", "function": {}}},
        {"tools": [TOOL], "tool_choice": 5},
        {"response_format": {"type": "json_schema", "json_schema": {"name": "x", "schema": {}}}},
        {"response_format": {"type": "json_object"}},
    ],
    ids=repr,
)
def test_tools_and_formats_the_provider_cannot_take_are_refused(extra: dict[str, Any]) -> None:
    error = refused(**extra)

    assert error.code in (
        ErrorCode.DYNAMIC_POLICY_VIOLATION,
        ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
    )


# #511-T22: the output bound is the trusted limit the proxy set; the provider needs a real one.
@pytest.mark.parametrize("bound", [0, -1, True, 1.5, "100", None])
def test_a_request_without_a_usable_output_bound_is_refused(bound: Any) -> None:
    error = refused(max_tokens=bound)

    assert error.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #511-T23
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_sampling_parameters_follow_the_flags_of_the_model(model: Any) -> None:
    body = encode(model.id, temperature=0.2)

    assert ("temperature" in body) is model.temperature
    assert "top_p" not in body

    body = encode(model.id, top_p=0.9)

    assert ("top_p" in body) is model.top_p
    assert "temperature" not in body


# #511-T23
def test_temperature_and_top_p_are_never_sent_together() -> None:
    body = encode(SAMPLING_MODEL, temperature=0.3, top_p=0.9)

    assert body["temperature"] == 0.3
    assert "top_p" not in body


# #511-T23
@pytest.mark.parametrize(
    ("given", "sent"), [(0, 0.0), (0.2, 0.2), (1, 1.0), (1.7, 1.0), (2, 1.0)], ids=repr
)
def test_temperature_is_capped_at_the_most_the_api_takes(given: float, sent: float) -> None:
    assert encode(SAMPLING_MODEL, temperature=given)["temperature"] == sent


# #511-T23
@pytest.mark.parametrize("given", [-0.1, "0.2", True, None, float("nan"), float("inf")], ids=repr)
def test_a_temperature_that_is_no_number_in_range_is_not_sent(given: Any) -> None:
    assert "temperature" not in encode(SAMPLING_MODEL, temperature=given)


# #511-T23
@pytest.mark.parametrize(
    "model_id",
    ["claude-haiku-5-5-latest", "claude-opus-4-5", "claude-future-9-9", "something-else"],
)
def test_a_model_the_list_does_not_know_gets_no_sampling_and_no_thinking_setting(
    model_id: str,
) -> None:
    body = encode(model_id, temperature=0.2, top_p=0.9)

    assert "temperature" not in body
    assert "top_p" not in body
    assert "thinking" not in body


# #511-T23
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_thinking_is_switched_off_exactly_where_the_model_accepts_it(model: Any) -> None:
    body = encode(model.id)

    if model.thinking_disabled:
        assert body["thinking"] == {"type": "disabled"}
    else:
        assert "thinking" not in body


def message(
    content: list[dict[str, Any]] | None = None, stop_reason: str = "end_turn", **usage: Any
) -> bytes:
    document: dict[str, Any] = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": MODEL,
        "content": content if content is not None else [{"type": "text", "text": "done"}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 100, "output_tokens": 50, **usage},
    }
    return json.dumps(document).encode("utf-8")


def decode(body: bytes, model: str = MODEL) -> dict[str, Any]:
    document: dict[str, Any] = json.loads(wire(model).decode_response(body))
    return document


# #511-T24
def test_text_becomes_the_message_content_of_a_chat_completion() -> None:
    completion = decode(
        message([{"type": "text", "text": "hello "}, {"type": "text", "text": "there"}])
    )

    assert completion["object"] == "chat.completion"
    assert completion["id"] == "msg_1"
    assert completion["model"] == MODEL
    choice = completion["choices"][0]
    assert choice["message"] == {"role": "assistant", "content": "hello there"}
    assert choice["finish_reason"] == "stop"
    assert choice["native_finish_reason"] == "end_turn"


# #511-T24
def test_tool_calls_keep_their_ids_and_get_their_arguments_as_json_text() -> None:
    completion = decode(
        message(
            [
                {"type": "text", "text": "reading"},
                {"type": "tool_use", "id": "toolu_1", "name": "read", "input": {"path": "é.py"}},
                {"type": "tool_use", "id": "toolu_2", "name": "grep", "input": {}},
            ],
            stop_reason="tool_use",
        )
    )

    message_ = completion["choices"][0]["message"]
    assert completion["choices"][0]["finish_reason"] == "tool_calls"
    assert message_["content"] == "reading"
    assert [call["id"] for call in message_["tool_calls"]] == ["toolu_1", "toolu_2"]
    first = message_["tool_calls"][0]
    assert first["type"] == "function"
    assert first["function"]["name"] == "read"
    assert json.loads(first["function"]["arguments"]) == {"path": "é.py"}
    assert message_["tool_calls"][1]["function"]["arguments"] == "{}"


# #511-T24
def test_an_answer_with_tool_calls_and_no_text_has_no_content() -> None:
    completion = decode(
        message(
            [{"type": "tool_use", "id": "t", "name": "read", "input": {}}], stop_reason="tool_use"
        )
    )

    assert completion["choices"][0]["message"]["content"] is None


# #511-T24
@pytest.mark.parametrize(
    ("stop_reason", "finish"),
    [
        ("end_turn", "stop"),
        ("stop_sequence", "stop"),
        ("tool_use", "tool_calls"),
        ("max_tokens", "length"),
        ("model_context_window_exceeded", "length"),
        ("refusal", "content_filter"),
        ("pause_turn", "stop"),
        ("something_new", "stop"),
        (None, "stop"),
    ],
)
def test_the_stop_reason_becomes_a_finish_reason(stop_reason: str | None, finish: str) -> None:
    completion = decode(message(stop_reason=stop_reason))  # type: ignore[arg-type]

    assert completion["choices"][0]["finish_reason"] == finish


# #511-T24
def test_thinking_blocks_and_unknown_blocks_are_dropped_and_never_reach_the_engine() -> None:
    completion = decode(
        message(
            [
                {"type": "thinking", "thinking": "secret chain of thought", "signature": "sig"},
                {"type": "redacted_thinking", "data": "opaque"},
                {"type": "text", "text": "answer"},
                {"type": "server_tool_use", "id": "s", "name": "web_search", "input": {}},
            ]
        )
    )

    text = json.dumps(completion)
    assert completion["choices"][0]["message"]["content"] == "answer"
    assert "secret chain" not in text
    assert "opaque" not in text


# #511-T24
def test_the_usage_counts_the_cache_inside_the_prompt_and_names_it_on_its_own() -> None:
    completion = decode(
        message(
            input_tokens=10_000,
            output_tokens=3000,
            cache_read_input_tokens=20_000,
            cache_creation_input_tokens=5000,
            cache_creation={"ephemeral_5m_input_tokens": 3000, "ephemeral_1h_input_tokens": 2000},
        ),
        SAMPLING_MODEL,
    )

    usage = completion["usage"]
    assert usage["prompt_tokens"] == 35_000
    assert usage["completion_tokens"] == 3000
    assert usage["total_tokens"] == 38_000
    assert usage["cache_read_input_tokens"] == 20_000
    assert usage["cache_creation_input_tokens"] == 5000
    # The cost rule of the provider prices exactly this usage.
    assert ANTHROPIC.cost_extractor(SAMPLING_MODEL, usage) == Decimal("0.10425")


# #511-T24
@pytest.mark.parametrize(
    "usage",
    [
        {},
        {"output_tokens": 5},
        {"input_tokens": 5},
        {"input_tokens": "5", "output_tokens": 5},
        {"input_tokens": -1, "output_tokens": 5},
        {"input_tokens": True, "output_tokens": 5},
    ],
    ids=repr,
)
def test_an_answer_whose_usage_is_unusable_reports_no_token_count(usage: dict[str, Any]) -> None:
    document: dict[str, Any] = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": MODEL,
        "content": [{"type": "text", "text": "x"}],
        "stop_reason": "end_turn",
        "usage": usage,
    }

    completion = decode(json.dumps(document).encode("utf-8"))

    assert (
        "prompt_tokens" not in completion["usage"] or "completion_tokens" not in completion["usage"]
    )


# #511-T24
def test_an_answer_without_a_usage_has_none() -> None:
    document: dict[str, Any] = {
        "id": "m",
        "type": "message",
        "content": [],
        "stop_reason": "end_turn",
    }

    completion = decode(json.dumps(document).encode("utf-8"))

    assert "usage" not in completion or completion["usage"] in (None, {})


# #511-T24: what changes the price travels with the usage, so the cost rule can refuse to price it.
def test_the_fields_that_change_a_price_are_passed_on_for_the_cost_rule() -> None:
    completion = decode(message(service_tier="priority", speed="fast", inference_geo="us"))

    assert completion["usage"]["service_tier"] == "priority"
    assert completion["usage"]["speed"] == "fast"
    assert ANTHROPIC.cost_extractor(MODEL, completion["usage"]) is None


# #511-T24
@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b"5",
        b'{"type": "error", "error": {"type": "api_error", "message": "x"}}',
        b'{"type": "message", "content": "text"}',
        b'{"type": "message", "content": [5]}',
        b'{"type":"message","content":[{"type":"tool_use","id":"t","name":"r","input":1}]}',
        b'{"type": "message", "content": [{"type": "tool_use", "name": "read", "input": {}}]}',
    ],
    ids=repr,
)
def test_an_answer_that_is_no_message_is_refused_with_a_stable_code(body: bytes) -> None:
    with pytest.raises(LimitError) as caught:
        wire().decode_response(body)

    assert caught.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
