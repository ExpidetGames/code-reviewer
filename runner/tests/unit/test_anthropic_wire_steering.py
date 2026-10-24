# SPDX-License-Identifier: LicenseRef-Proprietary

"""Dynamic Review on the models that refuse a forced tool choice or cannot run without thinking
(#533).

The engine asks for `tool_choice: required` on every call, because the review must come back
through its `StructuredOutput` tool. Fable 5.1, Opus 5.5 and Sonnet 5.5 answer that with a 400,
and a model that cannot switch thinking off (those three and Fable 5) should think between its
tool calls, which a forced call prevents. The wire therefore steers them: `auto`, a strict tool
schema and a runner instruction, with the answer checked as strictly as before. These models also
have to get their thinking blocks back with every tool result; the engine's chat history cannot
carry them, so the wire keeps them, per tool call."""

import json
from copy import deepcopy
from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.anthropic_models import MODELS
from code_reviewer_runner.anthropic_wire import (
    STEERING_INSTRUCTION,
    THINKING_BINDING_BETA,
    AnthropicMessagesWire,
)
from code_reviewer_runner.llm_providers import ANTHROPIC
from code_reviewer_runner.provider_wire import OpenAiChatWire

THINKING_SONNET = "claude-sonnet-5-5"
FORCING_SONNET = "claude-sonnet-5"
STRUCTURED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings", "resolvedIds"],
    "properties": {
        "resolvedIds": {
            "type": "array",
            "items": {"type": "string", "minLength": 1, "maxLength": 128},
            "uniqueItems": True,
            "maxItems": 500,
        },
        "findings": {
            "type": "array",
            "maxItems": 5,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "confidence", "path", "lineStart"],
                "properties": {
                    "id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "priority": {"type": "string", "enum": ["P0", "P1", "P2", "P3"]},
                    "path": {
                        "description": "Repository-relative.",
                        "type": "string",
                        "pattern": "^(?!/)(?!.*\\\\).{1,1024}$",
                    },
                    "lineStart": {"type": "integer", "minimum": 1, "maximum": 10000000},
                },
            },
        },
    },
}
READ: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "read",
        "description": "Read a file",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string", "maxLength": 10}},
            "required": ["path"],
        },
    },
}
STRUCTURED: dict[str, Any] = {
    "type": "function",
    "function": {"name": "StructuredOutput", "parameters": STRUCTURED_SCHEMA},
}
REQUIRED = "required"
NAMED = {"type": "function", "function": {"name": "StructuredOutput"}}


def steered(model_id: str) -> bool:
    """The rule of the issue, from the flags of the list: a forced choice is a 400, or thinking
    cannot be switched off (a forced call would suppress it)."""
    model = MODELS[model_id]
    return not model.forced_tool_choice or not model.thinking_disabled


def request(model: str, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": "review this"}],
        "tools": [READ, STRUCTURED],
        "tool_choice": REQUIRED,
    }
    body.update(extra)
    return body


def encode(model: str, **extra: Any) -> dict[str, Any]:
    return AnthropicMessagesWire(model).encode_request(request(model, **extra))


def system_text(body: dict[str, Any]) -> str:
    """The text of the system prompt: one block, the breakpoint of the static prefix (#539)."""
    blocks = body.get("system", [])
    assert len(blocks) <= 1
    return "".join(block["text"] for block in blocks)


def tool_by_name(body: dict[str, Any], name: str) -> dict[str, Any]:
    return next(tool for tool in body["tools"] if tool["name"] == name)


# #533-T01
@pytest.mark.parametrize("choice", [REQUIRED, NAMED])
@pytest.mark.parametrize("model", ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"])
def test_a_forced_choice_for_a_model_that_refuses_it_is_asked_for_as_auto(
    model: str, choice: Any
) -> None:
    body = encode(model, tool_choice=choice)

    assert body["tool_choice"] == {"type": "auto"}


# #533-T01
def test_auto_keeps_one_tool_call_at_a_time_when_the_request_asks_for_it() -> None:
    body = encode(THINKING_SONNET, parallel_tool_calls=False)

    assert body["tool_choice"] == {"type": "auto", "disable_parallel_tool_use": True}


# #533-T01
def test_a_choice_that_was_never_forced_is_left_as_it_is() -> None:
    assert encode(THINKING_SONNET, tool_choice="auto")["tool_choice"] == {"type": "auto"}
    assert encode(THINKING_SONNET, tool_choice="none")["tool_choice"] == {"type": "none"}


# #533-T02
@pytest.mark.parametrize("model", ["claude-sonnet-5", "claude-haiku-5-5", "claude-opus-5"])
def test_a_model_that_takes_a_forced_choice_and_can_disable_thinking_is_not_steered(
    model: str,
) -> None:
    body = encode(model)

    assert body["tool_choice"] == {"type": "any"}
    assert encode(model, tool_choice=NAMED)["tool_choice"] == {
        "type": "tool",
        "name": "StructuredOutput",
    }
    assert "system" not in body
    assert "strict" not in tool_by_name(body, "StructuredOutput")
    assert body["thinking"] == {"type": "disabled"}


# #539-T17
# #533-T03
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_a_model_is_steered_exactly_when_its_flags_say_so(model: Any) -> None:
    body = encode(model.id)

    assert (body["tool_choice"] == {"type": "auto"}) is steered(model.id)
    assert ("strict" in tool_by_name(body, "StructuredOutput")) is steered(model.id)
    assert (STEERING_INSTRUCTION in system_text(body)) is steered(model.id)


# #533-T03
def test_the_steered_models_are_the_three_that_refuse_a_forced_choice_and_the_one_that_thinks() -> (
    None
):
    assert {model for model in MODELS if steered(model)} == {
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-fable-5",
    }


# #533-T03
@pytest.mark.parametrize("model_id", ["claude-sonnet-5-5-latest", "claude-future-9-9"])
def test_a_model_the_list_does_not_know_is_never_steered_and_gets_no_thinking_setting(
    model_id: str,
) -> None:
    body = encode(model_id)

    assert body["tool_choice"] == {"type": "any"}
    assert "system" not in body
    assert "thinking" not in body
    assert "strict" not in tool_by_name(body, "StructuredOutput")


# #539-T17
# #533-T04
def test_the_steering_instruction_is_added_after_the_system_text_and_is_the_same_every_time() -> (
    None
):
    first = encode(
        THINKING_SONNET,
        messages=[
            {"role": "system", "content": "You are a reviewer."},
            {"role": "user", "content": "one"},
        ],
    )
    second = encode(
        THINKING_SONNET,
        messages=[
            {"role": "system", "content": "You are a reviewer."},
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "three"},
        ],
    )

    assert system_text(first) == f"You are a reviewer.\n\n{STEERING_INSTRUCTION}"
    assert second["system"] == first["system"]
    assert system_text(encode(THINKING_SONNET)) == STEERING_INSTRUCTION


# #533-T04
def test_the_steering_instruction_asks_for_a_tool_call_and_the_review_through_the_return_tool() -> (
    None
):
    assert "StructuredOutput" in STEERING_INSTRUCTION
    assert "tool" in STEERING_INSTRUCTION.lower()
    assert "<" not in STEERING_INSTRUCTION  # no tag a repository text could imitate


# #533-T04
def test_a_request_that_asks_for_no_forced_choice_gets_no_steering_text() -> None:
    assert "system" not in encode(THINKING_SONNET, tool_choice="auto")
    assert "system" not in encode(THINKING_SONNET, tools=None, tool_choice=None)


# #533-T05
def test_the_return_tool_alone_is_strict_with_a_schema_the_api_accepts() -> None:
    body = encode(THINKING_SONNET)

    assert tool_by_name(body, "StructuredOutput")["strict"] is True
    assert "strict" not in tool_by_name(body, "read")
    assert tool_by_name(body, "read")["input_schema"] == READ["function"]["parameters"]
    schema = tool_by_name(body, "StructuredOutput")["input_schema"]
    findings = schema["properties"]["findings"]
    finding = findings["items"]
    # What the strict grammar cannot express is gone; each limit is named in the description.
    for forbidden in (
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "maxItems",
        "uniqueItems",
        "pattern",
    ):
        assert f'"{forbidden}":' not in json.dumps(schema)
    assert "maxItems 5" in findings["description"]
    assert "maxLength 128" in finding["properties"]["id"]["description"]
    assert "minimum 0" in finding["properties"]["confidence"]["description"]
    assert "maximum 1" in finding["properties"]["confidence"]["description"]
    assert finding["properties"]["path"]["description"].startswith("Repository-relative.")
    assert "pattern" in finding["properties"]["path"]["description"]
    # What it can express stays.
    assert finding["properties"]["priority"]["enum"] == ["P0", "P1", "P2", "P3"]
    assert schema["required"] == ["findings", "resolvedIds"]
    assert finding["required"] == ["id", "confidence", "path", "lineStart"]
    assert schema["additionalProperties"] is False
    assert findings["items"]["additionalProperties"] is False


# #533-T05
def test_a_schema_gets_additional_properties_false_on_every_object() -> None:
    loose = deepcopy(STRUCTURED)
    del loose["function"]["parameters"]["additionalProperties"]
    del loose["function"]["parameters"]["properties"]["findings"]["items"]["additionalProperties"]

    body = AnthropicMessagesWire(THINKING_SONNET).encode_request(
        request(THINKING_SONNET, tools=[loose])
    )

    schema = body["tools"][0]["input_schema"]
    assert schema["additionalProperties"] is False
    assert schema["properties"]["findings"]["items"]["additionalProperties"] is False


# #533-T05
def test_a_schema_the_strict_mode_cannot_take_is_sent_as_it_is_without_strict() -> None:
    odd = deepcopy(STRUCTURED)
    odd["function"]["parameters"]["properties"]["findings"]["items"]["properties"]["id"] = {
        "oneOf": [{"type": "string"}, {"type": "integer"}]
    }

    body = AnthropicMessagesWire(THINKING_SONNET).encode_request(
        request(THINKING_SONNET, tools=[odd])
    )

    assert "strict" not in body["tools"][0]
    assert body["tools"][0]["input_schema"] == odd["function"]["parameters"]


# #533-T05
def test_the_request_of_the_engine_is_never_changed_by_the_translation() -> None:
    original = request(THINKING_SONNET)
    before = deepcopy(original)

    AnthropicMessagesWire(THINKING_SONNET).encode_request(original)

    assert original == before


# --- the answers and the thinking blocks ---------------------------------------------------------

THINK = {"type": "thinking", "thinking": "", "signature": "sig-one"}
REDACTED = {"type": "redacted_thinking", "data": "opaque-one"}
TOOL_USE = {"type": "tool_use", "id": "toolu_1", "name": "read", "input": {"path": "a.py"}}


def answer(content: list[dict[str, Any]], **usage: Any) -> bytes:
    return json.dumps(
        {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": THINKING_SONNET,
            "content": content,
            "stop_reason": "tool_use"
            if any(b["type"] == "tool_use" for b in content)
            else "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 100, "output_tokens": 50, **usage},
        }
    ).encode("utf-8")


def tool_call(
    call_id: str = "toolu_1", name: str = "read", arguments: str = '{"path": "a.py"}'
) -> dict[str, Any]:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def history(*assistant: dict[str, Any]) -> list[dict[str, Any]]:
    """The chat history the engine sends back: the question, the assistant turn, its tool
    results."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": "review this"}]
    for turn in assistant:
        messages.append(turn)
        calls: list[dict[str, Any]] = turn.get("tool_calls") or []
        for call in calls:
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": "result"})
    return messages


def assistant_blocks(body: dict[str, Any], position: int = 1) -> list[dict[str, Any]]:
    turn = body["messages"][position]
    assert turn["role"] == "assistant"
    blocks: list[dict[str, Any]] = turn["content"]
    return blocks


# #533-T06
def test_the_thinking_blocks_of_an_answer_come_back_with_its_tool_call_not_to_the_engine() -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)

    completion = json.loads(
        wire.decode_response(
            answer([THINK, REDACTED, {"type": "text", "text": "reading"}, TOOL_USE])
        )
    )

    assert "sig-one" not in json.dumps(completion)
    assert "opaque-one" not in json.dumps(completion)
    message = completion["choices"][0]["message"]
    body = wire.encode_request(
        request(
            THINKING_SONNET,
            messages=history(
                {
                    "role": "assistant",
                    "content": message["content"],
                    "tool_calls": message["tool_calls"],
                }
            ),
        )
    )
    assert assistant_blocks(body) == [
        THINK,
        REDACTED,
        {"type": "text", "text": "reading"},
        TOOL_USE,
    ]


# #533-T06
def test_an_answer_with_only_a_tool_call_gets_its_blocks_before_the_call() -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)
    wire.decode_response(answer([THINK, TOOL_USE]))

    body = wire.encode_request(
        request(
            THINKING_SONNET,
            messages=history({"role": "assistant", "content": None, "tool_calls": [tool_call()]}),
        )
    )

    assert assistant_blocks(body) == [THINK, TOOL_USE]


# #533-T06
def test_thinking_between_the_blocks_of_an_answer_stays_where_the_model_put_it() -> None:
    second = {"type": "tool_use", "id": "toolu_2", "name": "read", "input": {"path": "b.py"}}
    later = {"type": "thinking", "thinking": "", "signature": "sig-two"}
    wire = AnthropicMessagesWire(THINKING_SONNET)
    wire.decode_response(answer([THINK, TOOL_USE, later, second]))

    body = wire.encode_request(
        request(
            THINKING_SONNET,
            messages=history(
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [tool_call(), tool_call("toolu_2", "read", '{"path": "b.py"}')],
                }
            ),
        )
    )

    assert assistant_blocks(body) == [THINK, TOOL_USE, later, second]


# #533-T06
def test_each_turn_of_the_loop_gets_its_own_blocks_back() -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)
    other = {"type": "thinking", "thinking": "", "signature": "sig-other"}
    next_use = {"type": "tool_use", "id": "toolu_9", "name": "read", "input": {"path": "z.py"}}
    wire.decode_response(answer([THINK, TOOL_USE]))
    wire.decode_response(answer([other, next_use]))

    body = wire.encode_request(
        request(
            THINKING_SONNET,
            messages=history(
                {"role": "assistant", "content": None, "tool_calls": [tool_call()]},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [tool_call("toolu_9", "read", '{"path": "z.py"}')],
                },
            ),
        )
    )

    assert assistant_blocks(body, 1) == [THINK, TOOL_USE]
    assert assistant_blocks(body, 3) == [other, next_use]


# #533-T06
def test_a_text_answer_with_thinking_gets_its_blocks_back_by_its_text() -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)
    wire.decode_response(answer([THINK, {"type": "text", "text": "no more findings"}]))

    body = wire.encode_request(
        request(
            THINKING_SONNET,
            messages=[
                {"role": "user", "content": "review this"},
                {"role": "assistant", "content": "no more findings"},
                {"role": "user", "content": "continue"},
            ],
        )
    )

    assert assistant_blocks(body) == [THINK, {"type": "text", "text": "no more findings"}]


# #533-T06
def test_a_model_that_can_run_without_thinking_keeps_no_blocks() -> None:
    wire = AnthropicMessagesWire(FORCING_SONNET)
    wire.decode_response(answer([THINK, TOOL_USE]))

    body = wire.encode_request(
        request(
            FORCING_SONNET,
            messages=history({"role": "assistant", "content": None, "tool_calls": [tool_call()]}),
        )
    )

    assert assistant_blocks(body) == [TOOL_USE]


# #533-T07
def test_a_turn_without_stored_blocks_is_translated_as_before() -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)
    wire.decode_response(answer([THINK, TOOL_USE]))

    body = wire.encode_request(
        request(
            THINKING_SONNET,
            messages=history(
                {"role": "assistant", "content": None, "tool_calls": [tool_call("toolu_unknown")]}
            ),
        )
    )

    assert assistant_blocks(body) == [
        {"type": "tool_use", "id": "toolu_unknown", "name": "read", "input": {"path": "a.py"}}
    ]


# #533-T07
def test_a_wire_of_another_run_knows_nothing_of_the_blocks() -> None:
    AnthropicMessagesWire(THINKING_SONNET).decode_response(answer([THINK, TOOL_USE]))

    body = AnthropicMessagesWire(THINKING_SONNET).encode_request(
        request(
            THINKING_SONNET,
            messages=history({"role": "assistant", "content": None, "tool_calls": [tool_call()]}),
        )
    )

    assert assistant_blocks(body) == [TOOL_USE]


# #533-T07
def test_the_stored_blocks_are_a_copy_so_the_next_answer_cannot_change_them() -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)
    raw = answer([THINK, TOOL_USE])
    wire.decode_response(raw)
    wire.decode_response(
        answer([{"type": "thinking", "thinking": "", "signature": "sig-else"}, TOOL_USE])
    )

    body = wire.encode_request(
        request(
            THINKING_SONNET,
            messages=history({"role": "assistant", "content": None, "tool_calls": [tool_call()]}),
        )
    )

    # The id repeats (a fake of a test), the latest answer for it is the one that was issued last.
    assert assistant_blocks(body)[0]["signature"] == "sig-else"


# #533-T08
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_thinking_is_configured_by_the_flag_of_the_model(model: Any) -> None:
    wire = AnthropicMessagesWire(model.id)
    body = wire.encode_request(request(model.id))
    headers = wire.headers("dummy-key")

    if model.thinking_disabled:
        assert body["thinking"] == {"type": "disabled"}
        assert "anthropic-beta" not in headers
    else:
        # A call that edits the tool set (the wrap-up) degrades instead of failing the run.
        assert body["thinking"] == {
            "type": "adaptive",
            "block_binding": {"prefix_mismatch_behavior": "drop_block"},
        }
        assert (
            headers["anthropic-beta"]
            == THINKING_BINDING_BETA
            == "thinking-binding-controls-2026-08-01"
        )


# #533-T08
def test_a_model_the_list_does_not_know_gets_neither_the_thinking_setting_nor_the_beta_header() -> (
    None
):
    wire = AnthropicMessagesWire("claude-future-9-9")

    assert "thinking" not in wire.encode_request(request("claude-future-9-9"))
    assert "anthropic-beta" not in wire.headers("dummy-key")


# #533-T09: the breakdown of the output tokens (#534) is a part of them, billed as a whole: it
# travels with the usage as it is and the cost rule prices the call once, by `output_tokens`.
def test_the_thinking_tokens_are_a_part_of_the_output_tokens_and_priced_once() -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)

    usage = json.loads(
        wire.decode_response(
            answer(
                [{"type": "text", "text": "done"}],
                input_tokens=10_000,
                output_tokens=3000,
                output_tokens_details={"thinking_tokens": 2400},
            )
        )
    )["usage"]

    assert usage["completion_tokens"] == 3000
    assert usage["output_tokens_details"] == {"thinking_tokens": 2400}
    # Sonnet 5.5: $2 in and $10 out per million tokens: 10000 x 2 + 3000 x 10.
    assert ANTHROPIC.cost_extractor(THINKING_SONNET, usage) == Decimal("0.05")


# #533-T10
@pytest.mark.parametrize("thinking", [3001, -1, 2.5, True, "600"])
def test_a_thinking_count_that_does_not_fit_the_output_is_an_unknown_cost(thinking: Any) -> None:
    wire = AnthropicMessagesWire(THINKING_SONNET)

    usage = json.loads(
        wire.decode_response(
            answer(
                [{"type": "text", "text": "done"}],
                output_tokens=3000,
                output_tokens_details={"thinking_tokens": thinking},
            )
        )
    )["usage"]

    assert ANTHROPIC.cost_extractor(THINKING_SONNET, usage) is None


# #533-T21
def test_only_a_model_that_always_thinks_reserves_less_output_than_its_allowance() -> None:
    for model in MODELS.values():
        wire = AnthropicMessagesWire(model.id)
        reserved = wire.reserved_output_tokens(32_768)
        if model.thinking_disabled:
            assert reserved == 32_768, model.id
        else:
            assert 0 < reserved < 32_768, model.id
        # Never more than the allowance, and the allowance itself when it is the smaller one.
        assert wire.reserved_output_tokens(1_000) == 1_000, model.id
    assert OpenAiChatWire().reserved_output_tokens(32_768) == 32_768
    assert AnthropicMessagesWire("claude-not-in-the-list").reserved_output_tokens(32_768) == 32_768
