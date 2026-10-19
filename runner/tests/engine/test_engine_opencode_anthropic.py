# SPDX-License-Identifier: Apache-2.0

"""The real pinned OpenCode behind the proxy with the models that refuse a forced tool choice
(#533).

The engine asks for `tool_choice: required` on every call; Sonnet 5.5, Opus 5.5 and Fable 5.1
answer that with a 400, and Fable 5 (like those three) cannot run without thinking, which the
engine's history cannot carry. Here the real engine runs a whole review through the proxy's
Messages wire against the strict fake of the Claude Messages API (`fakes/llm/anthropic_rules.py`),
which answers those 400s and wants the thinking blocks back. Asserts what the engine got through
and what the model was sent, never review quality."""

import json
from pathlib import Path
from typing import Any

import pytest
from opencode_support import (
    ScriptedMessagesModel,
    Step,
    asks,
    findings_for,
    opencode_binary,
    run_engine,
    says,
    tool_call,
)
from test_engine_opencode import prepare, reading

from code_reviewer_runner.anthropic_models import MODELS
from code_reviewer_runner.dynamic_review.wrap_up import RECOVERY_INSTRUCTION
from code_reviewer_runner.llm_providers import ANTHROPIC

STEERED = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"]


@pytest.fixture(autouse=True)
def pinned_engine_is_installed() -> None:
    assert opencode_binary().is_file()


def only_return_tool(request: dict[str, Any]) -> bool:
    return {tool["name"] for tool in request.get("tools", [])} == {"StructuredOutput"}


# #533-T15
@pytest.mark.parametrize("model_id", STEERED)
def test_a_review_with_a_model_that_refuses_a_forced_choice_runs_through_the_real_engine(
    tmp_path: Path, model_id: str
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    model = ScriptedMessagesModel(
        steps=reading(content.export, 3), final=findings_for(content.head_sha)
    )
    with model:
        run = run_engine(
            model, content, scratch=tmp_path / "scratch", provider=ANTHROPIC, model_id=model_id
        )

    assert run.answer.ok, run.answer.error
    assert run.answer.findings is not None and len(run.answer.findings.findings) == 1
    assert len(model.requests) == 4
    for request in model.requests:
        # What the real engine asked for was forced (`required`); what the model got was `auto`.
        assert request["tool_choice"] == {"type": "auto"}
        assert request["model"] == model_id
        assert request["system"][-1]["text"].endswith(
            "StructuredOutput tool once with the complete review, "
            "and do not write the review as text."
        )
        returned = next(tool for tool in request["tools"] if tool["name"] == "StructuredOutput")
        # The schema the real engine built from the findings schema is one the strict mode takes.
        assert returned["strict"] is True
        assert returned["input_schema"]["additionalProperties"] is False
        assert request["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}
    # The thinking of every answer went back with its tool call (the strict fake would answer 400).
    assert model.requests[1]["messages"][1]["content"][0]["type"] == "thinking"
    assert run.ledger.recovered is False
    assert run.ledger.stopped_early is None
    assert run.ledger.model_calls == 4
    usage = run.ledger.usage(model_id)
    assert usage.cost_usd is not None
    price = MODELS[model_id].prices
    # Four calls of 50 input and 10 output tokens each, the thinking among the output tokens.
    assert usage.cost_usd == pytest.approx(
        4 * float((50 * price.input + 10 * price.output) / 1_000_000)
    )


# #533-T15: a model that answers in prose where it should call a tool is recovered once, like any.
def test_a_turn_that_ends_in_prose_with_a_steered_model_gets_the_one_recovery_call(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    prose = "I looked at src/app.py and found nothing wrong."
    steps: list[Step] = [*reading(content.export, 2), says(prose)]
    model = ScriptedMessagesModel(steps=steps, final=findings_for(content.head_sha))
    with model:
        run = run_engine(
            model,
            content,
            scratch=tmp_path / "scratch",
            provider=ANTHROPIC,
            model_id="claude-sonnet-5-5",
        )

    assert run.answer.ok, run.answer.error
    assert len(model.requests) == 4
    recovery = model.requests[3]
    # Another tool set than the calls that issued the thinking blocks: `drop_block` is what keeps
    # the strict fake (an account that is checked) from answering 400.
    assert only_return_tool(recovery)
    assert recovery["tool_choice"] == {"type": "auto"}
    # The instruction is runner text, the last block of the last turn.
    last = recovery["messages"][-1]["content"][-1]
    assert last["text"] == RECOVERY_INSTRUCTION and last["type"] == "text"
    # ... and the head of the conversation is a cache breakpoint (#539), a mark and nothing else.
    assert set(last) == {"type", "text", "cache_control"}
    assert run.ledger.recovered is True
    assert run.ledger.model_calls == 4


# #533-T15
def test_a_return_call_that_is_not_the_review_is_recovered_with_the_problem_named(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    wrong = asks(tool_call("bad", "StructuredOutput", {"findings": "none", "resolvedIds": []}))
    model = ScriptedMessagesModel(
        steps=[*reading(content.export, 1), wrong], final=findings_for(content.head_sha)
    )
    with model:
        run = run_engine(
            model,
            content,
            scratch=tmp_path / "scratch",
            provider=ANTHROPIC,
            model_id="claude-opus-5-5",
        )

    assert run.answer.ok, run.answer.error
    assert run.ledger.recovered is True
    last = model.requests[-1]
    assert "was not accepted" in json.dumps(last["messages"])
