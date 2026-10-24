# SPDX-License-Identifier: LicenseRef-Proprietary

"""The prompt cache of the Anthropic fake (#539): the rules of the Claude docs, as the fakes keep
them. A test of the wire is only worth what the fake it runs against knows, so the fake's rules
have tests of their own: breakpoints, minimum length, lifetime, look-back, and what it refuses."""

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.llm.anthropic_cache import (
    FIVE_MINUTES,
    LOOKBACK_BLOCKS,
    ONE_HOUR,
    CacheRequestRejected,
    PromptCache,
)

MODEL = "claude-sonnet-5"
MARK: dict[str, Any] = {"type": "ephemeral"}
BASE: dict[str, Any] = {"input_tokens": 0, "output_tokens": 50}


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def text(label: str, size: int = 6000) -> str:
    return f"{label} " + "x" * size


def block(label: str, size: int = 6000, **extra: Any) -> dict[str, Any]:
    return {"type": "text", "text": text(label, size), **extra}


def request(*turns: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    messages = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": content}
        for index, content in enumerate(turns)
    ]
    return {"model": MODEL, "max_tokens": 1000, "messages": messages, **extra}


def run(cache: PromptCache, body: dict[str, Any]) -> dict[str, Any]:
    return cache.usage(body, BASE)


# #539-T06
def test_a_marked_prefix_is_written_once_and_read_by_the_next_request() -> None:
    cache = PromptCache(Clock())
    first = run(cache, request([block("task", cache_control=MARK)]))
    assert first["cache_read_input_tokens"] == 0
    assert first["cache_creation_input_tokens"] > 1024
    assert first["input_tokens"] == 0

    second = run(
        cache,
        request([block("task", cache_control=MARK)], [block("answer")], [block("next")]),
    )
    assert second["cache_read_input_tokens"] == first["cache_creation_input_tokens"]
    assert second["cache_creation_input_tokens"] == 0
    assert second["input_tokens"] > 0


# #539-T06
def test_a_prefix_that_differs_anywhere_before_the_mark_is_not_read() -> None:
    cache = PromptCache(Clock())
    run(cache, request([block("task one", cache_control=MARK)]))
    other = run(cache, request([block("task two", cache_control=MARK)]))
    assert other["cache_read_input_tokens"] == 0
    assert other["cache_creation_input_tokens"] > 0


# #539-T06
def test_the_usage_has_the_real_shape_with_the_split_of_the_written_tokens() -> None:
    usage = run(PromptCache(Clock()), request([block("task", cache_control=MARK)]))
    split = usage["cache_creation"]
    assert split == {
        "ephemeral_5m_input_tokens": usage["cache_creation_input_tokens"],
        "ephemeral_1h_input_tokens": 0,
    }
    assert usage["output_tokens"] == 50


# #539-T06
def test_a_prompt_below_the_minimum_of_the_model_is_not_cached_and_no_error_is_said() -> None:
    cache = PromptCache(Clock())
    small = request([block("task", size=100, cache_control=MARK)])
    usage = run(cache, small)
    assert usage["cache_creation_input_tokens"] == 0
    assert usage["cache_read_input_tokens"] == 0
    assert usage["input_tokens"] > 0


# #539-T06
def test_the_minimum_depends_on_the_model() -> None:
    body = request([block("task", size=5000, cache_control=MARK)])
    sonnet_five = PromptCache(Clock()).usage({**body, "model": "claude-sonnet-5"}, BASE)
    opus_four_six = PromptCache(Clock()).usage({**body, "model": "claude-opus-4-6"}, BASE)
    assert sonnet_five["cache_creation_input_tokens"] > 0
    assert opus_four_six["cache_creation_input_tokens"] == 0


# #539-T06
def test_an_entry_lives_five_minutes_and_a_read_renews_it() -> None:
    clock = Clock()
    cache = PromptCache(clock)
    body = request([block("task", cache_control=MARK)])
    run(cache, body)
    clock.now += FIVE_MINUTES - 1
    assert run(cache, body)["cache_read_input_tokens"] > 0
    clock.now += FIVE_MINUTES - 1
    assert run(cache, body)["cache_read_input_tokens"] > 0
    clock.now += FIVE_MINUTES + 1
    expired = run(cache, body)
    assert expired["cache_read_input_tokens"] == 0
    assert expired["cache_creation_input_tokens"] > 0


# #539-T06
def test_a_one_hour_entry_outlives_five_minutes_and_is_reported_in_its_own_split() -> None:
    clock = Clock()
    cache = PromptCache(clock)
    body = request([block("task", cache_control={"type": "ephemeral", "ttl": "1h"})])
    written = run(cache, body)
    assert written["cache_creation"]["ephemeral_1h_input_tokens"] > 0
    assert written["cache_creation"]["ephemeral_5m_input_tokens"] == 0
    clock.now += ONE_HOUR - 1
    assert run(cache, body)["cache_read_input_tokens"] > 0


# #539-T06
def test_tools_and_system_come_before_the_messages_in_the_cached_prefix() -> None:
    cache = PromptCache(Clock())
    tools = [{"name": "read", "description": "d" * 3000, "input_schema": {"type": "object"}}]
    system = [block("rules", cache_control=MARK)]
    run(cache, request([block("first")], tools=tools, system=system))
    changed = [{**tools[0], "description": "e" * 3000}]
    assert (
        run(cache, request([block("first")], tools=changed, system=system))[
            "cache_read_input_tokens"
        ]
        == 0
    )
    assert (
        run(cache, request([block("other")], tools=tools, system=system))["cache_read_input_tokens"]
        > 0
    )


# #539-T06
def test_a_breakpoint_looks_back_at_most_twenty_blocks_for_an_entry() -> None:
    cache = PromptCache(Clock())
    run(cache, request([block("task", cache_control=MARK)]))
    unmarked = [block("task")]
    near_turns = [[block(f"turn {n}", size=50)] for n in range(LOOKBACK_BLOCKS - 2)]
    near = request(unmarked, *near_turns, [block("head", cache_control=MARK)])
    assert run(PromptCache(Clock()), near)["cache_read_input_tokens"] == 0
    assert run(cache, near)["cache_read_input_tokens"] > 0

    far_turns = [[block(f"turn {n}", size=50)] for n in range(LOOKBACK_BLOCKS + 2)]
    far = request(unmarked, *far_turns, [block("head", cache_control=MARK)])
    assert run(cache, far)["cache_read_input_tokens"] == 0


# #539-T06
def test_a_second_breakpoint_near_the_old_write_reads_it_however_far_the_head_moved() -> None:
    cache = PromptCache(Clock())
    first = [block("task", cache_control=MARK)]
    run(cache, request(first))
    turns = [[block(f"turn {n}", size=50)] for n in range(LOOKBACK_BLOCKS + 2)]
    body = request([block("task", cache_control=MARK)], *turns, [block("head", cache_control=MARK)])
    assert run(cache, body)["cache_read_input_tokens"] > 0


# #539-T06
def test_the_top_level_cache_control_marks_the_last_block() -> None:
    cache = PromptCache(Clock())
    first = run(cache, request([block("task")], cache_control=MARK))
    assert first["cache_creation_input_tokens"] > 0
    assert first["input_tokens"] == 0
    second = run(
        cache, request([block("task")], [block("answer")], [block("q")], cache_control=MARK)
    )
    assert second["cache_read_input_tokens"] == first["cache_creation_input_tokens"]


# #539-T06
def test_the_top_level_mark_on_a_marked_last_block_with_the_same_ttl_adds_nothing() -> None:
    cache = PromptCache(Clock())
    usage = run(
        cache,
        request([block("task", cache_control=MARK)], cache_control=MARK),
    )
    assert usage["cache_creation_input_tokens"] > 0


@pytest.mark.parametrize(
    "build",
    [
        pytest.param(
            lambda: request(*[[block(f"t{n}", cache_control=MARK)] for n in range(5)]),
            id="five blocks",
        ),
        pytest.param(
            lambda: request(
                *[[block(f"t{n}", cache_control=MARK)] for n in range(4)] + [[block("x")]],
                cache_control=MARK,
            ),
            id="four blocks and the top-level mark",
        ),
        pytest.param(
            lambda: request([{"type": "text", "text": "", "cache_control": MARK}]),
            id="an empty text block",
        ),
        pytest.param(
            lambda: request([{"type": "thinking", "thinking": "t", "cache_control": MARK}]),
            id="a thinking block",
        ),
        pytest.param(
            lambda: request(
                [block("task")],
                [{"type": "tool_use", "id": "t1", "name": "read", "input": {}}],
                [{"type": "tool_result", "tool_use_id": "t1", "cache_control": MARK}],
            ),
            id="a tool result without content",
        ),
        pytest.param(
            lambda: request(
                [block("task")],
                [{"type": "tool_use", "id": "t1", "name": "read", "input": {}}],
                [
                    {
                        "type": "tool_result",
                        "tool_use_id": "t1",
                        "content": "",
                        "cache_control": MARK,
                    }
                ],
            ),
            id="a tool result with an empty string",
        ),
        pytest.param(
            lambda: request(
                [block("task")],
                [{"type": "tool_use", "id": "t1", "name": "read", "input": {}}],
                [
                    {
                        "type": "tool_result",
                        "tool_use_id": "t1",
                        "content": [],
                        "cache_control": MARK,
                    }
                ],
            ),
            id="a tool result with no blocks",
        ),
        pytest.param(
            lambda: request([block("task", cache_control={"type": "ephemeral", "ttl": "2h"})]),
            id="an unknown ttl",
        ),
        pytest.param(
            lambda: request(
                [block("a", cache_control=MARK)],
                [block("b", cache_control={"type": "ephemeral", "ttl": "1h"})],
            ),
            id="one hour after five minutes",
        ),
        pytest.param(
            lambda: request(
                [block("a", cache_control=MARK)], cache_control={"type": "ephemeral", "ttl": "1h"}
            ),
            id="the top-level mark with another ttl than the last block",
        ),
        pytest.param(
            lambda: {
                **request([block("a")]),
                "messages": [{"role": "user", "content": "x", "cache_control": MARK}],
            },
            id="a mark on the message itself",
        ),
    ],
)
# #539-T06
def test_a_request_the_api_would_refuse_is_refused(build: Any) -> None:
    with pytest.raises(CacheRequestRejected):
        run(PromptCache(Clock()), build())


# #539-T06
def test_four_breakpoints_are_allowed() -> None:
    body = request(*[[block(f"t{n}", cache_control=MARK)] for n in range(4)])
    assert run(PromptCache(Clock()), body)["cache_creation_input_tokens"] > 0


# #539-T06
def test_a_run_of_tool_results_counts_as_one_position_for_the_look_back() -> None:
    cache = PromptCache(Clock())
    run(cache, request([block("task", cache_control=MARK)]))
    calls: list[dict[str, Any]] = [
        {"type": "tool_use", "id": f"t{n}", "name": "read", "input": {}}
        for n in range(LOOKBACK_BLOCKS * 2)
    ]
    results = [
        {"type": "tool_result", "tool_use_id": f"t{n}", "content": "x"}
        for n in range(LOOKBACK_BLOCKS * 2)
    ]
    body = request(
        [block("task")],
        calls,
        [*results[:-1], {**results[-1], "cache_control": MARK}],
    )
    assert run(cache, body)["cache_read_input_tokens"] > 0


def tool(name: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "input_schema": {"type": "object"}, **extra}


def stable_prefix(**extra: Any) -> dict[str, Any]:
    """Tools, a marked system prompt and a marked first turn: a second request can reuse each."""
    return request(
        [block("task", cache_control=MARK)],
        tools=[tool("read"), tool("grep")],
        system=[block("system", cache_control=MARK)],
        **extra,
    )


# #539-T06
@pytest.mark.parametrize(
    "changed",
    [
        pytest.param({"tool_choice": {"type": "none"}}, id="tool_choice"),
        pytest.param({"thinking": {"type": "enabled", "budget_tokens": 2048}}, id="thinking"),
    ],
)
def test_a_changed_tool_choice_or_thinking_invalidates_the_messages_but_not_the_system(
    changed: dict[str, Any],
) -> None:
    settings: dict[str, Any] = {"tool_choice": {"type": "auto"}, "thinking": {"type": "disabled"}}
    # What the system breakpoint covers: the tools and the system prompt.
    system_only = request(
        [block("task")],
        tools=[tool("read"), tool("grep")],
        system=[block("system", cache_control=MARK)],
    )
    covered = run(PromptCache(Clock()), {**system_only, **settings})["cache_creation_input_tokens"]

    cache = PromptCache(Clock())
    first = run(cache, stable_prefix(**settings))
    assert first["cache_creation_input_tokens"] > covered
    same = run(cache, stable_prefix(**settings))
    assert same["cache_read_input_tokens"] == first["cache_creation_input_tokens"]

    other = run(cache, stable_prefix(**{**settings, **changed}))
    assert other["cache_read_input_tokens"] == covered
    assert other["cache_creation_input_tokens"] == first["cache_creation_input_tokens"] - covered


# #539-T06
def test_a_changed_tool_set_invalidates_everything() -> None:
    cache = PromptCache(Clock())
    first = run(cache, stable_prefix())
    assert first["cache_creation_input_tokens"] > 0
    body = stable_prefix()
    body["tools"] = [tool("read"), tool("grep"), tool("write")]
    other = run(cache, body)
    assert other["cache_read_input_tokens"] == 0
    assert other["cache_creation_input_tokens"] > 0
