# SPDX-License-Identifier: Apache-2.0

"""The real pinned OpenCode with a Claude model, behind the proxy, against a cache (#539).

When the model id says `claude` or `anthropic`, the pinned OpenCode puts a `cache_control` on the
system message and on its last two messages (on the message object, which no provider API has a
field for). The runner's wires must neither forward those nor add to them: the provider gets the
breakpoints the wire places, each once, and the run reads its own earlier prefix from turn two on.
The fakes keep the rules of the docs (`fakes/llm/anthropic_cache.py`): more than four breakpoints, a
mark on a message object or a thinking block is a 400."""

import itertools
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

from opencode_support import (
    ScriptedClaude,
    ScriptedModel,
    asks,
    findings_for,
    run_engine,
    tool_call,
)
from test_engine_opencode import prepare

from code_reviewer_runner.anthropic_models import model_for
from code_reviewer_runner.llm_providers import ANTHROPIC

CLAUDE = "claude-sonnet-5"
READS = 4


def reads(export: Path) -> list[Any]:
    return [
        asks(tool_call(f"r{index}", "read", {"filePath": str(export / "src/app.py")}))
        for index in range(READS)
    ]


def engine_marks(requests: list[dict[str, Any]]) -> list[str]:
    """Where the engine itself marked a request, by role of the message."""
    return [
        message["role"]
        for request in requests
        for message in request["messages"]
        if "cache_control" in message
    ]


def blocks_marked(body: dict[str, Any]) -> int:
    count = sum(1 for tool in body.get("tools", []) if "cache_control" in tool)
    count += sum(1 for block in body.get("system", []) if "cache_control" in block)
    for message in body["messages"]:
        content = message["content"]
        count += sum(1 for block in content if isinstance(block, dict) and "cache_control" in block)
    return count + (1 if "cache_control" in body else 0)


# #539-T18
def test_the_real_engine_marks_a_claude_model_but_the_anthropic_wire_places_its_own_marks_only(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    model = ScriptedClaude(steps=reads(content.export), final=findings_for(content.head_sha))
    engine_requests: list[dict[str, Any]] = []
    with model:
        run = run_engine(
            model,
            content,
            scratch=tmp_path / "scratch",
            provider=ANTHROPIC,
            model_id=CLAUDE,
            engine_requests=engine_requests,
        )

    assert run.answer.ok, run.answer.error
    assert not model.rejected
    # The premise: the engine does mark its system message and its last messages for a Claude.
    assert "system" in engine_marks(engine_requests)
    assert len(engine_marks(engine_requests)) >= 2 * len(engine_requests)
    # The provider got none of them: the messages are plain, and the wire's marks are the system
    # block, the latest turn and the turn before it of the same side.
    assert len(model.requests) == READS + 1
    for number, body in enumerate(model.requests):
        for message in body["messages"]:
            assert set(message) == {"role", "content"}
        assert "cache_control" not in body
        assert blocks_marked(body) == (2 if number == 0 else 3)
        assert body["system"][-1]["cache_control"] == {"type": "ephemeral"}


# #539-T07
def test_the_real_engine_reads_its_own_earlier_prefix_from_the_second_call_on(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    model = ScriptedClaude(steps=reads(content.export), final=findings_for(content.head_sha))
    with model:
        run = run_engine(
            model, content, scratch=tmp_path / "scratch", provider=ANTHROPIC, model_id=CLAUDE
        )

    assert run.answer.ok, run.answer.error
    usages = model.usages
    assert usages[0]["cache_read_input_tokens"] == 0
    assert usages[0]["cache_creation_input_tokens"] > 0
    for before, now in itertools.pairwise(usages):
        assert now["cache_read_input_tokens"] >= before["cache_read_input_tokens"]
        assert now["cache_read_input_tokens"] > 0
    # Every call of the run was priced exactly from what it read, wrote and did not cache.
    entry = model_for(CLAUDE)
    assert entry is not None
    expected = sum(
        (
            Decimal(u["input_tokens"]) * entry.prices.input
            + Decimal(u["cache_read_input_tokens"]) * entry.prices.cache_read
            + Decimal(u["cache_creation"]["ephemeral_5m_input_tokens"])
            * entry.prices.cache_write_5m
            + Decimal(u["output_tokens"]) * entry.prices.output
        )
        / Decimal(1_000_000)
        for u in usages
    )
    cost = run.ledger.usage(CLAUDE).cost_usd
    assert cost is not None and Decimal(repr(cost)) == expected


# #539-T18
def test_the_engine_marks_never_double_the_openrouter_breakpoints_of_a_claude_model(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    model = ScriptedModel(steps=reads(content.export), final=findings_for(content.head_sha))
    engine_requests: list[dict[str, Any]] = []
    with model:
        run = run_engine(
            model,
            content,
            scratch=tmp_path / "scratch",
            model_id="anthropic/claude-sonnet-5",
            engine_requests=engine_requests,
        )

    assert run.answer.ok, run.answer.error
    assert "system" in engine_marks(engine_requests)
    for body in model.requests:
        assert engine_marks([body]) == []
        # The system part and the top-level mark: two breakpoints, each once.
        assert body["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}
        assert body["cache_control"] == {"type": "ephemeral"}
        assert json.dumps(body).count("cache_control") == 2


# #539-T12
def test_a_model_that_caches_by_itself_gets_no_mark_from_the_engine_or_the_wire(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    model = ScriptedModel(steps=reads(content.export)[:2], final=findings_for(content.head_sha))
    engine_requests: list[dict[str, Any]] = []
    with model:
        run = run_engine(
            model, content, scratch=tmp_path / "scratch", engine_requests=engine_requests
        )

    assert run.answer.ok, run.answer.error
    assert engine_marks(engine_requests) == []
    assert all("cache_control" not in json.dumps(body) for body in model.requests)
