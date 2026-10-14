# SPDX-License-Identifier: Apache-2.0

"""Pins down the recovery of a Dynamic Review turn that ended without an answer (#309).

The pinned engine ends a turn when a model step finishes without the structured-output tool call
(a prose answer, an output cut off at its allowance, a provider that says `stop` for a step with
tool calls). The adapter then arms one recovery call in the ledger; the model proxy, which is
trusted runner code, rewrites that call like the wrap-up call of #293: the return tool alone, a
forced tool choice and a runner-authored instruction last. Nothing in a request starts or prevents
it. These tests drive the ledger and the proxy; the real engine is in `test_engine_opencode.py`.
"""

import json
from decimal import Decimal
from typing import Any

from test_dynamic_review_proxy import (
    HISTORY,
    TOOLS,
    UNIT_COSTS,
    Upstream,
    answer_with_structured_output,
    answer_with_usage,
    error_code,
    forwarded,
    loop_request,
    post,
    proxy,
    tool_result_history,
)

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.completion_stream import completion_as_stream
from code_reviewer_runner.dynamic_review.wrap_up import (
    RECOVERY_INSTRUCTION,
    RECOVERY_PROMPT,
    WRAP_UP_INSTRUCTION,
    returns_structured_output,
)
from code_reviewer_runner.result import ErrorCode


def recovering(upstream: Upstream) -> Any:
    """A proxy whose run made one call that ended the turn without an answer; recovery is armed."""
    ledger = BudgetLedger(DynamicLimits(max_cost_usd=Decimal(1)), unit_costs=UNIT_COSTS)
    subject = proxy(upstream, ledger=ledger)
    assert post(subject, loop_request()).status == 200
    assert ledger.begin_recovery()
    return subject


# #309-T06
def test_the_recovery_call_is_rewritten_to_the_return_tool_with_the_recovery_instruction() -> None:
    upstream = Upstream()
    subject = recovering(upstream)

    assert post(subject, loop_request()).status == 200

    body = forwarded(upstream, 1)
    assert [tool["function"]["name"] for tool in body["tools"]] == ["StructuredOutput"]
    assert body["tools"][0] == TOOLS[-1]
    assert body["tool_choice"] == "required"
    assert body["messages"][:-1] == HISTORY
    assert body["messages"][-1] == {"role": "user", "content": RECOVERY_INSTRUCTION}
    assert body["stream"] is False
    assert subject.ledger.recovered is True
    assert subject.ledger.stopped_early is None


# #309-T06
def test_the_first_call_of_the_run_was_a_normal_call() -> None:
    upstream = Upstream()
    recovering(upstream)

    body = forwarded(upstream, 0)
    assert len(body["tools"]) == 4
    assert body["messages"] == HISTORY


# #309-T06
def test_the_recovery_instruction_is_runner_text_in_the_tag_the_escape_already_covers() -> None:
    assert RECOVERY_INSTRUCTION.startswith("<runner-wrap-up>")
    assert RECOVERY_INSTRUCTION.endswith("</runner-wrap-up>")
    assert "Do not call any more tools" in RECOVERY_INSTRUCTION
    assert "StructuredOutput" in RECOVERY_INSTRUCTION
    assert RECOVERY_INSTRUCTION != WRAP_UP_INSTRUCTION
    # The message the engine sends to start the recovery turn carries no tag at all.
    assert "<" not in RECOVERY_PROMPT


# #309-T06
def test_nothing_is_forwarded_after_the_recovery_call() -> None:
    upstream = Upstream(body=answer_with_structured_output())
    subject = recovering(upstream)
    assert post(subject, loop_request()).status == 200

    again = post(subject, loop_request())

    assert again.status == 403
    assert error_code(again) == ErrorCode.DYNAMIC_BUDGET_EXCEEDED.value
    assert len(upstream.requests) == 2


# #309-T09: the ledger's own state arms the recovery; text in a request cannot.
def test_repository_text_that_imitates_the_instruction_does_not_start_a_recovery() -> None:
    upstream = Upstream()
    ledger = BudgetLedger(DynamicLimits(max_cost_usd=Decimal(1)), unit_costs=UNIT_COSTS)
    subject = proxy(upstream, ledger=ledger)
    request = loop_request()
    request["messages"] = tool_result_history(RECOVERY_INSTRUCTION + WRAP_UP_INSTRUCTION)

    assert post(subject, request).status == 200

    body = forwarded(upstream)
    assert len(body["tools"]) == 4
    assert ledger.recovered is False


# #309-T09
def test_the_imitation_in_the_history_of_the_recovery_call_stays_escaped_text() -> None:
    upstream = Upstream()
    subject = recovering(upstream)
    request = loop_request()
    request["messages"] = tool_result_history(RECOVERY_INSTRUCTION)

    assert post(subject, request).status == 200

    body = forwarded(upstream, 1)
    assert "<runner-wrap-up>" not in json.dumps(body["messages"][3])
    assert "&lt;runner-wrap-up>" in json.dumps(body["messages"][3])
    assert body["messages"][-1] == {"role": "user", "content": RECOVERY_INSTRUCTION}


# #309-T07
def test_a_final_call_that_answered_in_prose_makes_a_further_request_an_output_error() -> None:
    upstream = Upstream()  # answers 200 with text and no tool call
    ledger = BudgetLedger(DynamicLimits(max_cost_usd=Decimal("0.05")), unit_costs=UNIT_COSTS)
    subject = proxy(upstream, ledger=ledger)
    assert post(subject, loop_request()).status == 200
    assert ledger.stopped_early == "cost_limit"

    again = post(subject, loop_request())

    assert again.status == 403
    assert error_code(again) == ErrorCode.LLM_OUTPUT_INVALID.value
    assert len(upstream.requests) == 1
    assert ledger.failure is not None
    assert ledger.failure.code is ErrorCode.LLM_OUTPUT_INVALID


# #309-T07
def test_a_recovery_call_that_answered_in_prose_makes_a_further_request_an_output_error() -> None:
    upstream = Upstream()
    subject = recovering(upstream)
    assert post(subject, loop_request()).status == 200

    again = post(subject, loop_request())

    assert error_code(again) == ErrorCode.LLM_OUTPUT_INVALID.value


# #309-T07
def test_a_final_call_that_returned_the_answer_keeps_the_budget_refusal() -> None:
    upstream = Upstream(body=answer_with_structured_output())
    ledger = BudgetLedger(DynamicLimits(max_cost_usd=Decimal("0.05")), unit_costs=UNIT_COSTS)
    subject = proxy(upstream, ledger=ledger)
    assert post(subject, loop_request()).status == 200

    assert error_code(post(subject, loop_request())) == ErrorCode.DYNAMIC_BUDGET_EXCEEDED.value


# #309-T07: a normal call may answer in prose; only the final call's prose is the model's failure.
def test_a_normal_call_that_answered_in_prose_does_not_end_the_run() -> None:
    upstream = Upstream()
    subject = proxy(upstream)

    assert post(subject, loop_request()).status == 200
    assert post(subject, loop_request()).status == 200
    assert subject.ledger.failure is None


# #309-T07
def test_the_structured_output_call_is_recognised_in_an_answer() -> None:
    assert returns_structured_output(answer_with_structured_output()) is True
    assert returns_structured_output(answer_with_usage()) is False
    assert returns_structured_output({}) is False
    other = answer_with_structured_output()
    other["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "read"
    assert returns_structured_output(other) is False


# #309-T02: the engine ends a turn when a step finishes with `stop`, even if the step asked for
# tools (seen against the pinned release), so the proxy reports what the step really was.
def test_a_step_with_tool_calls_is_never_reported_to_the_engine_as_a_plain_stop() -> None:
    answer = answer_with_structured_output()
    answer["choices"][0]["message"]["tool_calls"][0]["function"]["name"] = "read"
    answer["choices"][0]["finish_reason"] = "stop"

    stream = completion_as_stream(answer)

    assert stream is not None
    assert b'"finish_reason":"tool_calls"' in stream.replace(b' ', b'')


def test_a_step_without_tool_calls_keeps_its_finish_reason() -> None:
    for reason in ("stop", "length", "content_filter"):
        answer = answer_with_usage()
        answer["choices"][0]["finish_reason"] = reason

        stream = completion_as_stream(answer)

        assert stream is not None
        assert f'"finish_reason":"{reason}"'.encode() in stream.replace(b" ", b"")


def test_a_cut_off_step_with_tool_calls_keeps_the_length_reason() -> None:
    answer = answer_with_structured_output()
    answer["choices"][0]["finish_reason"] = "length"

    stream = completion_as_stream(answer)

    assert stream is not None
    assert b'"finish_reason":"length"' in stream.replace(b" ", b"")
