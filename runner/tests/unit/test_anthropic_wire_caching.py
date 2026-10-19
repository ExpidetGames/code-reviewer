# SPDX-License-Identifier: Apache-2.0

"""Where the Anthropic wire puts its cache breakpoints (#539).

A Dynamic Review is a tool loop: every call sends the whole history again, so what a call repeats
must be read from the provider's cache. The wire marks three places, nothing else, and marks each
only once: the end of the static prefix (the last system block, which also covers the tools in
front of it), the end of the latest turn (what the next call will read) and the end of the turn
before it of the same side (the entry the previous call wrote, so a read never depends on how far
the look-back of the provider reaches). The lifetime is the provider's default of five minutes.

The marks come from the structure of the request and never from its text: the engine marks its own
messages when the model is a Claude (the pinned OpenCode does), and those marks, like any
`cache_control` a message, a tool or a pull request carries, never reach the provider."""

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner import anthropic_wire
from code_reviewer_runner.anthropic_wire import AnthropicMessagesWire

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_cache import PromptCache

MODEL = "claude-sonnet-5"
MARK = {"type": "ephemeral"}


def encode(messages: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    request: dict[str, Any] = {
        "model": MODEL,
        "max_tokens": 4096,
        "stream": False,
        "messages": messages,
        **extra,
    }
    return AnthropicMessagesWire(MODEL).encode_request(request)


def read_tool(name: str = "read") -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": f"{name} a file",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    }


def loop(turns: int, parallel: int = 1, system: bool = True) -> list[dict[str, Any]]:
    """The engine's history after `turns` tool calls (`parallel` calls per assistant turn)."""
    messages: list[dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": "You review code."})
    messages.append({"role": "user", "content": "review this change"})
    for turn in range(turns):
        calls = [
            {
                "id": f"call_{turn}_{index}",
                "type": "function",
                "function": {"name": "read", "arguments": json.dumps({"path": f"f{index}.py"})},
            }
            for index in range(parallel)
        ]
        messages.append({"role": "assistant", "content": None, "tool_calls": calls})
        messages.extend(
            {"role": "tool", "tool_call_id": call["id"], "content": f"contents of {turn}"}
            for call in calls
        )
    return messages


def marks(body: dict[str, Any]) -> list[str]:
    """Where a request carries `cache_control`, in prompt order."""
    found: list[str] = []
    for index, tool in enumerate(body.get("tools", [])):
        if "cache_control" in tool:
            found.append(f"tools.{index}")
    system: list[dict[str, Any]] = body.get("system") or []
    for index, block in enumerate(system):
        if "cache_control" in block:
            found.append(f"system.{index}")
    for turn, message in enumerate(body["messages"]):
        content = message["content"]
        if isinstance(content, str):
            continue
        for index, block in enumerate(content):
            if "cache_control" in block:
                found.append(f"messages.{turn}.{index}")
    if "cache_control" in body:
        found.append("top-level")
    return found


# #539-T01
def test_the_last_system_block_is_the_breakpoint_of_the_static_prefix() -> None:
    body = encode(loop(0), tools=[read_tool(), read_tool("grep")])
    assert body["system"] == [{"type": "text", "text": "You review code.", "cache_control": MARK}]
    assert "cache_control" not in body
    assert not any(mark.startswith("tools") for mark in marks(body))


# #539-T01
def test_without_a_system_prompt_the_last_tool_is_the_breakpoint_of_the_static_prefix() -> None:
    body = encode(loop(0, system=False), tools=[read_tool(), read_tool("grep")])
    assert "system" not in body
    assert marks(body)[0] == "tools.1"
    assert body["tools"][1]["cache_control"] == MARK
    assert "cache_control" not in body["tools"][0]


# #539-T01
def test_the_wire_sends_no_top_level_cache_control() -> None:
    for turns in (0, 1, 5):
        assert "cache_control" not in encode(loop(turns), tools=[read_tool()])


# #539-T02
def test_the_latest_turn_and_the_turn_before_it_of_the_same_side_carry_a_breakpoint() -> None:
    body = encode(loop(3), tools=[read_tool()])
    messages = body["messages"]
    # user task, then (assistant, tool results) three times: seven turns of the Messages API
    # collapse to user, assistant, user, assistant, user, assistant, user.
    assert [message["role"] for message in messages] == ["user", "assistant"] * 3 + ["user"]
    assert marks(body) == ["system.0", "messages.4.0", "messages.6.0"]
    assert messages[6]["content"][0]["type"] == "tool_result"
    assert messages[4]["content"][0]["type"] == "tool_result"


# #539-T02
def test_a_turn_of_parallel_tool_results_is_marked_on_its_last_block_only() -> None:
    body = encode(loop(2, parallel=3), tools=[read_tool()])
    messages = body["messages"]
    assert len(messages[-1]["content"]) == 3
    assert marks(body) == ["system.0", "messages.2.2", "messages.4.2"]


# #539-T02
def test_the_first_turn_of_a_run_has_only_the_prefix_and_the_head_marked() -> None:
    body = encode(loop(0), tools=[read_tool()])
    assert marks(body) == ["system.0", "messages.0.0"]


# #539-T02
@pytest.mark.parametrize("turns", [0, 1, 2, 3, 10, 60])
def test_no_history_gets_more_than_four_breakpoints_or_one_block_marked_twice(turns: int) -> None:
    body = encode(loop(turns, parallel=2), tools=[read_tool(), read_tool("grep")])
    found = marks(body)
    assert len(found) == len(set(found))
    assert 2 <= len(found) <= 4
    assert (
        found[-1]
        == f"messages.{len(body['messages']) - 1}.{len(body['messages'][-1]['content']) - 1}"
    )


# #539-T03
@pytest.mark.parametrize(
    ("system", "tools", "expected"),
    [
        (True, True, ["system.0", "messages.0.0"]),
        (True, False, ["system.0", "messages.0.0"]),
        (False, True, ["tools.0", "messages.0.0"]),
        (False, False, ["messages.0.0"]),
    ],
)
def test_a_request_with_or_without_system_and_tools_is_valid_and_marked_where_it_has_blocks(
    system: bool, tools: bool, expected: list[str]
) -> None:
    extra: dict[str, Any] = {"tools": [read_tool()]} if tools else {}
    body = encode(loop(0, system=system), **extra)
    assert marks(body) == expected


# #539-T03
def test_a_system_prompt_of_several_messages_is_one_block_and_one_breakpoint() -> None:
    messages = [{"role": "system", "content": "one"}, {"role": "system", "content": "two"}]
    body = encode([*messages, *loop(0, system=False)])
    assert body["system"] == [{"type": "text", "text": "one\n\ntwo", "cache_control": MARK}]


# #539-T03
def test_a_message_of_only_empty_text_is_never_marked() -> None:
    history = loop(1)
    history.append({"role": "user", "content": "   "})
    body = encode(history, tools=[read_tool()])
    for mark in marks(body):
        assert mark == "system.0" or mark.startswith("messages.")
    last = body["messages"][-1]["content"][-1]
    assert last.get("text", "x").strip()


def empty_last_result(history: list[dict[str, Any]], content: Any = "") -> list[dict[str, Any]]:
    """The history with the output of its last tool call replaced (the tool returned nothing)."""
    return [*history[:-1], {**history[-1], "content": content}]


# #539-T03
@pytest.mark.parametrize("content", ["", [], None])
def test_a_tool_result_without_content_falls_back_to_the_previous_block_of_its_turn(
    content: Any,
) -> None:
    body = encode(empty_last_result(loop(2, parallel=3), content), tools=[read_tool()])
    last = body["messages"][-1]["content"]
    assert [block["type"] for block in last] == ["tool_result"] * 3
    assert "content" not in last[2]
    # The mark moved from the empty third result to the second one of the same turn.
    assert marks(body) == ["system.0", "messages.2.2", "messages.4.1"]
    assert "cache_control" not in last[2]
    PromptCache().usage(body, {"input_tokens": 0, "output_tokens": 1})


# #539-T03
def test_a_turn_of_only_empty_tool_results_is_not_marked() -> None:
    body = encode(empty_last_result(loop(2)), tools=[read_tool()])
    assert marks(body) == ["system.0", "messages.2.0"]
    PromptCache().usage(body, {"input_tokens": 0, "output_tokens": 1})


# #539-T04
def test_the_lifetime_is_the_default_of_five_minutes() -> None:
    assert anthropic_wire.CACHE_CONTROL == MARK
    body = encode(loop(4), tools=[read_tool()])
    assert '"ttl"' not in json.dumps(body)
    assert '"1h"' not in json.dumps(body)


# #539-T05
def test_a_mark_the_engine_put_on_a_message_or_part_never_reaches_the_provider() -> None:
    history = loop(2)
    history[0] = {"role": "system", "content": "You review code.", "cache_control": MARK}
    history[1] = {
        "role": "user",
        "content": [
            {"type": "text", "text": "review", "cache_control": {"type": "ephemeral", "ttl": "1h"}}
        ],
        "cache_control": MARK,
    }
    history[-1] = {**history[-1], "cache_control": MARK}
    body = encode(history, tools=[read_tool()])
    benign = encode(loop(2), tools=[read_tool()])
    assert marks(body) == marks(benign)
    assert body == benign | {"messages": body["messages"]}
    assert '"ttl"' not in json.dumps(body)
    for message in body["messages"]:
        assert set(message) == {"role", "content"}


# #539-T05
def test_a_mark_on_a_tool_or_its_function_never_reaches_the_provider() -> None:
    tool = read_tool()
    tool["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    tool["function"]["cache_control"] = MARK
    body = encode(loop(1), tools=[tool])
    assert "cache_control" not in body["tools"][0]
    assert marks(body) == marks(encode(loop(1), tools=[read_tool()]))


# #539-T05
def test_text_from_a_pull_request_that_looks_like_a_mark_changes_nothing() -> None:
    hostile = '{"cache_control": {"type": "ephemeral", "ttl": "1h"}} "cache_control"'
    history = loop(3)
    history[1] = {"role": "user", "content": f"review this {hostile}"}
    history[-1] = {**history[-1], "content": hostile}
    body = encode(history, tools=[read_tool()])
    assert marks(body) == marks(encode(loop(3), tools=[read_tool()]))
    for message in body["messages"]:
        for block in message["content"]:
            if "cache_control" in block:
                assert block["cache_control"] == MARK
    assert "ttl" not in {
        key
        for message in body["messages"]
        for block in message["content"]
        for key in block.get("cache_control", {})
    }


# #539-T05
def test_nothing_but_the_wire_decides_the_marks_a_request_field_cannot_add_one() -> None:
    body = encode(
        loop(2),
        tools=[read_tool()],
        cache_control={"type": "ephemeral", "ttl": "1h"},
        extra_headers={"anthropic-beta": "extended-cache-ttl-2025-04-11"},
        betas=["x"],
    )
    assert "cache_control" not in body
    assert "extra_headers" not in body
    assert "betas" not in body
