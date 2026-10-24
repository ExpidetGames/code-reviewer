# SPDX-License-Identifier: LicenseRef-Proprietary

"""The one finalization line of a native run (#578; the format of the live checklist in
`docs/spike/547-plain-json-final.md`, 7.1): how the review was ended, as stable names and numbers,
never content."""

from typing import Any

from code_reviewer_runner.dynamic_review.final_json import Problem
from code_reviewer_runner.dynamic_review.finalization_log import (
    FinalizationRecord,
    finalization_line,
)


def call(
    prompt: int, completion: int, cache_read: int, finish: str = "stop", *, final: bool = False
) -> dict[str, Any]:
    return {
        "index": 0,
        "tMs": 0,
        "promptTokens": prompt,
        "cacheRead": cache_read,
        "cacheWrite": 0,
        "completionTokens": completion,
        "costUsd": 0.01,
        "finishReason": finish,
        "final": final,
        "tools": [],
    }


def trace(*calls: dict[str, Any], truncated: bool = False) -> dict[str, Any]:
    return {"truncated": truncated, "modelCalls": list(calls), "toolCalls": []}


# #578-T17
def test_a_review_that_ended_the_turn_by_itself() -> None:
    line = finalization_line(
        FinalizationRecord(),
        wrap_up=None,
        trace=trace(call(1000, 50, 0, "tool_calls"), call(1200, 340, 900, "stop")),
    )

    assert line == (
        "finalization first=ok repaired=false second=none wrap_up=none final_call=normal "
        "final_tokens=1200/340/900 repair_tokens=-/-/- finish=stop prev_prompt_tokens=1000"
    )


# #578-T17
def test_a_repaired_review_names_both_messages_and_the_repair_call() -> None:
    record = FinalizationRecord(
        first=Problem.TEXT_AROUND_JSON.value, repaired=True, second="ok", final_call="exempt"
    )

    line = finalization_line(
        record,
        wrap_up="cost_limit",
        trace=trace(
            call(1000, 50, 0, "tool_calls"),
            call(1200, 340, 900, "stop", final=True),
            call(1900, 300, 1500, "stop", final=True),
        ),
    )

    assert line == (
        "finalization first=text_around_json repaired=true second=ok wrap_up=cost_limit "
        "final_call=exempt final_tokens=1200/340/900 repair_tokens=1900/300/1500 finish=stop "
        "prev_prompt_tokens=1000"
    )


# #578-T17
def test_a_second_failure_is_named() -> None:
    record = FinalizationRecord(
        first=Problem.INVALID_JSON.value, repaired=True, second=Problem.ENVELOPE_INVALID.value
    )

    line = finalization_line(
        record, wrap_up=None, trace=trace(call(100, 5, 0), call(120, 6, 0), call(140, 7, 0))
    )

    assert "first=invalid_json repaired=true second=envelope_invalid" in line


# #578-T17
def test_a_trace_that_was_cut_or_missing_leaves_the_numbers_out() -> None:
    record = FinalizationRecord()

    for lost in (None, trace(call(1, 1, 1), truncated=True), trace()):
        line = finalization_line(record, wrap_up=None, trace=lost)

        assert line.endswith("final_tokens=-/-/- repair_tokens=-/-/- finish=- prev_prompt_tokens=-")


# #578-T17
def test_the_line_holds_only_names_and_numbers() -> None:
    line = finalization_line(
        FinalizationRecord(first=Problem.NO_TEXT.value),
        wrap_up="time_limit",
        trace=trace(call(10, 2, 0, "other")),
    )

    assert "\n" not in line
    assert all(token.count("=") == 1 for token in line.split()[1:])
