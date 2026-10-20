# SPDX-License-Identifier: Apache-2.0

"""Finalization above the wire with the real pinned OpenCode (#552, spike #547).

The production adapter (`DynamicEngine(plain_final=True)`) drives the stock engine with no `format`,
behind the production passthrough proxy and ledger and the strict Messages fake of `fakes/wire`. The
mechanics are proven for one family; how well each real model follows the instruction is a live
question (`docs/spike/547-plain-json-final.md`, section 7). An engine start costs about five
seconds, so the cases are few and each is a whole run.
"""

import itertools
from pathlib import Path
from typing import Any

import pytest
from fakes.wire.formats import Turn
from opencode_support import opencode_binary
from plain_final_support import (
    NativeRun,
    Reaction,
    Scene,
    native_run,
    reads,
    review,
    tool_names,
    user_texts,
)

from code_reviewer_runner.dynamic_review.final_messages import FINISH_NOW_INSTRUCTION
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.engine

TOOLS = {"read", "grep", "glob"}


@pytest.fixture(autouse=True)
def pinned_engine_is_installed() -> None:
    assert opencode_binary().is_file()


def uncached(value: Any) -> Any:
    """The content without its cache breakpoints, which the engine moves to the newest messages."""
    if isinstance(value, dict):
        return {key: uncached(item) for key, item in value.items() if key != "cache_control"}  # pyright: ignore[reportUnknownVariableType]
    if isinstance(value, list):
        return [uncached(item) for item in value]  # pyright: ignore[reportUnknownVariableType]
    return value


def assert_same_prefix(requests: list[dict[str, Any]]) -> None:
    """Each call is the previous call's whole conversation and something more: the tools, the
    model and every earlier message are identical, so a provider caches the prefix."""
    for earlier, later in itertools.pairwise(requests):
        before, after = uncached(earlier["messages"]), uncached(later["messages"])
        assert after[: len(before)] == before
        for key in ("tools", "model", "max_tokens", "system"):
            assert uncached(later.get(key)) == uncached(earlier.get(key)), key


# #552-T10, #552-T08, #552-T01: a full review ends with valid JSON text and nothing structured
def test_a_full_review_ends_with_valid_json_text_and_no_request_asks_for_a_format(
    tmp_path: Path,
) -> None:
    with native_run(tmp_path, lambda export: [*reads(export, 3), Turn(text=review())]) as run:
        assert run.answer.ok, run.answer.error
        assert run.answer.findings is not None
        assert run.answer.findings.reviewed_sha == "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
        assert len(run.requests) == 4
        for request in run.requests:
            assert tool_names(request) == TOOLS
            assert request.get("tool_choice") in (None, {"type": "auto"})
            assert "StructuredOutput" not in str(request)
            assert not {"response_format", "output_config", "output_format"} & request.keys()
        assert_same_prefix(run.requests)
        # The audit of the native path saw the engine's tool parts on its event stream.
        assert run.ledger.tool_calls == 3
        assert run.ledger.returned_bytes > 0
        assert run.ledger.files >= 1
        assert run.ledger.failure is None
        assert run.ledger.usage(None).stopped_early is None


MODEL_TEXT_MARKER = "MODEL_TEXT_MARKER"
LIMIT = "0.10"


def many_reads(export: Path) -> list[Turn]:
    """More tool calls than the cost limit admits."""
    return [*reads(export, 6) * 6, Turn(text=review())]


def announced(request: dict[str, Any]) -> int:
    """How often the request holds the runner's finish-now message."""
    return sum(1 for text in user_texts(request) if text == FINISH_NOW_INSTRUCTION)


def answer_when_asked(*, times: int) -> Reaction:
    """The model answers with the review once the finish-now message was seen `times` times."""

    def react(scene: Scene, request: dict[str, Any]) -> None:
        if announced(request) >= times:
            scene.answer_next_with(Turn(text=review()))

    return react


def final_calls(run: NativeRun) -> list[bool]:
    trace = run.ledger.usage(None).call_trace
    assert trace is not None
    return [call["final"] for call in trace["modelCalls"]]


# #552-T06 (mechanics): a run near its cost limit is asked to answer by one message, while the
# turn runs; the model answers, nothing is refused, aborted or marked, and the run says why it
# stopped early
def test_a_run_near_its_cost_limit_is_asked_by_a_message_and_a_model_that_complies_ends_there(
    tmp_path: Path,
) -> None:
    with native_run(tmp_path, many_reads, limit=LIMIT, react=answer_when_asked(times=1)) as run:
        assert run.answer.ok, run.answer.error
        # The message appears once, as the last user message of the request that was answered.
        assert [announced(request) for request in run.requests].count(1) == 1
        assert user_texts(run.requests[-1])[-1] == FINISH_NOW_INSTRUCTION
        assert max(announced(request) for request in run.requests) == 1
        assert_same_prefix(run.requests)
        assert all(tool_names(request) == TOOLS for request in run.requests)
        usage = run.ledger.usage(None)
        assert usage.stopped_early == "cost_limit"
        assert usage.limit_exceeded_by is None
        assert run.ledger.failure is None and run.ledger.refusals == 0
        assert final_calls(run) == [False] * len(run.requests)  # no call needed the exemption


# #552-T06, lead case of #552: the model ignores the message, the ledger refuses its next call,
# the adapter aborts the turn and asks once more, the ledger admits that call past the guard, and
# the run still ends with a delivered review
def test_a_model_that_ignores_the_message_still_ends_with_a_delivered_review(
    tmp_path: Path,
) -> None:
    with native_run(tmp_path, many_reads, limit=LIMIT, react=answer_when_asked(times=2)) as run:
        assert run.answer.ok, run.answer.error
        final = run.requests[-1]
        # The announcement and then the message of the final call, which only the refusal of the
        # ledger makes the adapter send: both are last, and nothing else follows them.
        assert user_texts(final)[-2:] == [FINISH_NOW_INSTRUCTION] * 2
        assert announced(final) == 2
        assert tool_names(final) == TOOLS  # the tool set is unchanged: the cache prefix stays
        assert final.get("tool_choice") in (None, {"type": "auto"})
        assert_same_prefix(run.requests)
        # Exactly one call was admitted by the exemption, and it is the last one.
        assert final_calls(run) == [False] * (len(run.requests) - 1) + [True]
        assert run.ledger.failure is None
        usage = run.ledger.usage(None)
        assert usage.stopped_early == "cost_limit"
        # The overshoot bound of #542: what was spent before the final call is within the limit
        # (the refusal was the fit test), plus the final call itself, and nothing else.
        trace = usage.call_trace
        assert trace is not None
        final_cost = trace["modelCalls"][-1]["costUsd"]
        assert usage.cost_usd is not None
        assert usage.cost_usd - final_cost <= float(LIMIT)


# #552-T07: the final turn answers with a tool call; the ledger refuses the next call and the
# adapter repairs once (never a silent failure), the repair is admitted and delivers the review
def test_a_tool_call_in_the_final_turn_is_refused_and_followed_by_one_repair(
    tmp_path: Path,
) -> None:
    def react(scene: Scene, request: dict[str, Any]) -> None:
        asked_to_repair = any("called a tool" in text for text in user_texts(request))
        if asked_to_repair:
            scene.answer_next_with(Turn(text=review()))

    with native_run(tmp_path, many_reads, limit=LIMIT, react=react) as run:
        assert run.answer.ok, run.answer.error
        texts = user_texts(run.requests[-1])
        # The announcement, the final message that got the tool call, and then the one repair.
        assert texts[-3:-1] == [FINISH_NOW_INSTRUCTION] * 2
        assert "called a tool, and no tool may be called now" in texts[-1]
        # The final call and the repair are the two calls the exemption admitted.
        assert final_calls(run)[-2:] == [True, True]
        assert final_calls(run).count(True) == 2
        assert run.ledger.failure is None
        assert_same_prefix(run.requests)


# #552-T04, #552-T03: a failed answer gets exactly one repair in the same session, with a stable
# prefix; the engine recorded the bad answer, and the runner's message names the class only
def test_a_failed_answer_gets_one_repair_message_and_the_repair_succeeds(tmp_path: Path) -> None:
    bad = f"Here is my review, {MODEL_TEXT_MARKER}:\n{review()}"
    with native_run(
        tmp_path, lambda export: [*reads(export, 2), Turn(text=bad), Turn(text=review())]
    ) as run:
        assert run.answer.ok, run.answer.error
        assert len(run.requests) == 4
        assert_same_prefix(run.requests)
        before, repair = run.requests[2]["messages"], run.requests[3]["messages"]
        assert [message["role"] for message in repair[len(before) :]] == ["assistant", "user"]
        text = user_texts(run.requests[3])[-1]
        assert text.startswith("<runner-wrap-up>\n")
        assert "text next to the JSON object" in text
        assert MODEL_TEXT_MARKER not in text
        assert not run.ledger.usage(None).stopped_early


# #552-T04: a repair that fails too ends the run with the stable code, never a second repair, and
# nothing the model wrote is in the error
def test_a_failed_repair_ends_the_run_with_the_stable_code_and_no_model_text(
    tmp_path: Path,
) -> None:
    with native_run(
        tmp_path,
        lambda export: [
            *reads(export, 1),
            Turn(text=f"{MODEL_TEXT_MARKER} no json"),
            Turn(text=f"{MODEL_TEXT_MARKER} still no json"),
        ],
    ) as run:
        assert run.answer.error is not None
        assert run.answer.error.code is ErrorCode.LLM_OUTPUT_INVALID
        assert MODEL_TEXT_MARKER not in run.answer.error.detail
        assert "no_json_object" in run.answer.error.detail
        assert len(run.requests) == 3  # the read, the prose, the repair: no second repair
