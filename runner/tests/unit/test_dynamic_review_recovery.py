# SPDX-License-Identifier: LicenseRef-Proprietary

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
    FINAL_ATTEMPTS,
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
    # #309 review F1: the engine does not replay the answer that ended the turn, so the model is
    # not told that it can see its findings; it is told to rely on what it examined.
    assert "so far" not in RECOVERY_INSTRUCTION
    assert "based on what you have examined" in RECOVERY_INSTRUCTION
    # A cut-off answer should not repeat: the recovery asks for a short review.
    assert "Be concise" in RECOVERY_INSTRUCTION
    assert "at most 10 findings" in RECOVERY_INSTRUCTION
    assert "short description" in RECOVERY_INSTRUCTION
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
    ledger = BudgetLedger(DynamicLimits(max_cost_usd=Decimal("0.025")), unit_costs=UNIT_COSTS)
    subject = proxy(upstream, ledger=ledger)
    assert post(subject, loop_request()).status == 200
    assert ledger.stopped_early == "cost_limit"

    again = post(subject, loop_request())

    assert again.status == 403
    assert error_code(again) == ErrorCode.LLM_OUTPUT_INVALID.value
    # The final call itself asked again (#312); the further request forwarded nothing.
    assert len(upstream.requests) == FINAL_ATTEMPTS
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
    ledger = BudgetLedger(DynamicLimits(max_cost_usd=Decimal("0.025")), unit_costs=UNIT_COSTS)
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
    assert b'"finish_reason":"tool_calls"' in stream.replace(b" ", b"")


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


def completion_with(
    *,
    content: Any = None,
    calls: list[tuple[str, str]] | None = None,
    finish: str | None = "stop",
    reasoning: str | None = None,
    cost: float | None = 0.0001,
    **choice: Any,
) -> dict[str, Any]:
    """A provider answer: `calls` are (tool name, raw arguments)."""
    answer = answer_with_usage(prompt=40, completion=7, cost=cost)
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if reasoning is not None:
        message["reasoning_content"] = reasoning
    if calls:
        message["tool_calls"] = [
            {"id": f"c{n}", "type": "function", "function": {"name": name, "arguments": raw}}
            for n, (name, raw) in enumerate(calls)
        ]
    answer["choices"] = [{"message": message, "finish_reason": finish, **choice}]
    return answer


# #312-T03: the proxy sees what the provider really returned; the engine's own report of a turn
# cannot tell a model that wrote prose from one that sent nothing or a broken tool call.
def test_the_proxy_notes_how_each_model_call_ended() -> None:
    answers = [
        completion_with(content="a" * 250),
        completion_with(content="", reasoning="r" * 30),
        completion_with(calls=[("StructuredOutput", '{"findings": [')], finish="length"),
        completion_with(calls=[("StructuredOutput", "{}")], finish="stop"),
    ]
    upstream = Upstream()
    subject = proxy(upstream)
    outcomes: list[str] = []
    for answer in answers:
        upstream.body = answer
        assert post(subject, loop_request()).status == 200
        outcomes.append(subject.ledger.recent_call_outcomes[-1])

    assert outcomes == [
        "finish=stop, tools=none, text=250 chars, reasoning=0 chars, output=7 tokens",
        "finish=stop, tools=none, text=0 chars, reasoning=30 chars, output=7 tokens",
        "finish=length, tools=StructuredOutput(args not json), text=0 chars, reasoning=0 chars, "
        "output=7 tokens",
        "finish=stop, tools=StructuredOutput, text=0 chars, reasoning=0 chars, output=7 tokens",
    ]


# #312-T03
def test_the_note_of_a_call_marks_the_final_call_and_the_provider_reason() -> None:
    upstream = Upstream()
    subject = recovering(upstream)
    upstream.body = completion_with(content="x", native_finish_reason="STOP")

    assert post(subject, loop_request()).status == 200

    assert subject.ledger.recent_call_outcomes[-1].endswith("output=7 tokens, final call")
    assert "native=STOP" in subject.ledger.recent_call_outcomes[-1]


# #312-T03: only the last few calls are kept, and nothing from the model's text, the tool names
# or the arguments is copied.
def test_the_notes_are_bounded_and_never_copy_model_text() -> None:
    upstream = Upstream()
    subject = proxy(upstream)
    upstream.body = completion_with(
        content="SECRET_TEXT",
        calls=[("read<script>SECRET_TOOL", '{"SECRET_ARG": 1}')],
        finish="stop\nSECRET_FINISH",
    )
    for _ in range(6):
        assert post(subject, loop_request()).status == 200

    notes = subject.ledger.recent_call_outcomes
    assert len(notes) == 3
    assert "SECRET" not in " ".join(notes)
    assert "tools=other" in notes[-1] and "finish=other" in notes[-1]
