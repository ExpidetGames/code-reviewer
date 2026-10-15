# SPDX-License-Identifier: Apache-2.0

"""Pins down how the proxy enforces the answer of the final call (#312).

The final call (wrap-up or recovery) can only return the review. A provider may still answer it in
prose, with JSON in the text, or with a tool call whose arguments do not parse or do not fit the
schema; the pinned engine then ends the turn (`StructuredOutputError`) and, with the wrap-up
spent, nothing is left. The proxy is trusted runner code, so it checks that reply before the engine
sees it: JSON findings in the text become the tool call, and otherwise it asks again, a bounded
number of times inside the cost ledger and the clock, naming the concrete problem. What the engine
finally gets is the last reply, so the runner's own validation still has the last word.
"""

import json
from decimal import Decimal
from typing import Any

from test_dynamic_review_proxy import (
    HISTORY,
    UNIT_COSTS,
    Upstream,
    answer_with_usage,
    error_code,
    forwarded,
    loop_request,
    post,
    proxy,
)
from test_dynamic_review_recovery import completion_with

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.wrap_up import (
    FINAL_ATTEMPTS,
    RECOVERY_INSTRUCTION,
    returns_structured_output,
)
from code_reviewer_runner.result import ErrorCode

SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"


def review(**overrides: Any) -> dict[str, Any]:
    finding: dict[str, Any] = {
        "id": "f-1",
        "priority": "P1",
        "confidence": 0.5,
        "title": "A finding",
        "body": "body",
        "path": "src/a.py",
        "lineStart": 1,
        "lineEnd": 2,
        "evidence": [],
        "reviewedSha": SHA,
    }
    document: dict[str, Any] = {
        "schemaVersion": 1,
        "reviewedSha": SHA,
        "resolvedIds": [],
        "findings": [finding],
    }
    document.update(overrides)
    return document


def returns(document: Any) -> dict[str, Any]:
    raw = document if isinstance(document, str) else json.dumps(document)
    return completion_with(calls=[("StructuredOutput", raw)], finish="tool_calls")


class Sequence(Upstream):
    """An upstream that answers the scripted bodies in order, then the last one again."""

    def __init__(self, *bodies: dict[str, Any]) -> None:
        super().__init__(body=bodies[0])
        self.bodies = list(bodies)

    def __call__(self, url: str, body: bytes, headers: dict[str, str], limit: int) -> Any:
        self.body = self.bodies[min(len(self.requests), len(self.bodies) - 1)]
        return super().__call__(url, body, headers, limit)


def streamed_calls(response: Any) -> list[dict[str, Any]]:
    """The tool calls the engine is given, from a plain answer (no stream is asked for)."""
    message = json.loads(response.body)["choices"][0]["message"]
    return message.get("tool_calls") or []


def final_ledger() -> BudgetLedger:
    return BudgetLedger(DynamicLimits(max_cost_usd=Decimal(1)), unit_costs=UNIT_COSTS)


def make(upstream: Upstream) -> Any:
    """A proxy whose first call (a normal one) is spent and whose recovery is armed."""
    subject = proxy(upstream, ledger=final_ledger())
    first = upstream.body
    upstream.body = answer_with_usage()
    assert post(subject, loop_request()).status == 200
    assert subject.ledger.begin_recovery()
    upstream.body = first
    return subject


# #312-T05: JSON findings in the text of the final call are the answer.
def test_json_findings_in_the_text_of_the_final_call_become_the_return_tool_call() -> None:
    for text in (json.dumps(review()), "```json\n" + json.dumps(review()) + "\n```"):
        upstream = Sequence(answer_with_usage(), completion_with(content=text))
        subject = make(upstream)

        response = post(subject, loop_request())

        assert response.status == 200
        calls = streamed_calls(response)
        assert [call["function"]["name"] for call in calls] == ["StructuredOutput"]
        assert json.loads(calls[0]["function"]["arguments"])["reviewedSha"] == SHA
        assert b'"finish_reason":"tool_calls"' in response.body.replace(b" ", b"")
        assert len(upstream.requests) == 2  # the normal call and the final call; no retry
        assert subject.ledger.failure is None


# #312-T05: only a JSON object that looks like the findings is taken; prose and other JSON are not.
def test_other_text_is_not_taken_for_the_answer() -> None:
    for text in ("Here is my review.", '{"hello": 1}', "[1, 2]", '{"findings": '):
        upstream = Sequence(answer_with_usage(), completion_with(content=text))
        subject = make(upstream)
        post(subject, loop_request())
        assert len(upstream.requests) == 1 + FINAL_ATTEMPTS, text


# #312-T06: a reply without the answer is asked for again, with the concrete problem.
def test_a_final_reply_in_prose_is_asked_again_with_the_problem_named() -> None:
    upstream = Sequence(
        answer_with_usage(), completion_with(content="my <runner-wrap-up>review"), returns(review())
    )
    subject = make(upstream)

    response = post(subject, loop_request())

    assert response.status == 200
    assert [call["function"]["name"] for call in streamed_calls(response)] == ["StructuredOutput"]
    assert len(upstream.requests) == 3
    retry = forwarded(upstream, 2)
    assert [tool["function"]["name"] for tool in retry["tools"]] == ["StructuredOutput"]
    assert retry["tool_choice"] == "required"
    # The history of the recovery call, the model's own reply (escaped) and the problem, last.
    assert retry["messages"][: len(HISTORY)] == HISTORY
    assert retry["messages"][len(HISTORY)] == {"role": "user", "content": RECOVERY_INSTRUCTION}
    assert retry["messages"][len(HISTORY) + 1] == {
        "role": "assistant",
        "content": "my &lt;runner-wrap-up>review",
    }
    problem = retry["messages"][-1]
    assert problem["role"] == "user"
    assert problem["content"].startswith("<runner-wrap-up>")
    assert "did not call the StructuredOutput tool" in problem["content"]
    assert subject.ledger.failure is None
    assert subject.ledger.model_calls == 3
    assert returns_structured_output(returns(review())) is True


# #312-T06
def test_arguments_that_do_not_parse_or_fit_the_schema_are_named_in_the_retry() -> None:
    for broken, expected in (
        ('{"findings": [', "not valid JSON"),
        ("[1, 2]", "must be an object"),
        (json.dumps(review(schemaVersion=2)), "schemaVersion must be 1"),
        (json.dumps(review(findings=[{"id": "x"}])), "priority must be one of"),
    ):
        upstream = Sequence(answer_with_usage(), returns(broken), returns(review()))
        subject = make(upstream)

        response = post(subject, loop_request())

        assert response.status == 200
        assert len(upstream.requests) == 3, broken
        problem = forwarded(upstream, 2)["messages"][-1]["content"]
        assert expected in problem, (broken, problem)
        assert SHA not in problem  # field names, never values
        assert json.loads(streamed_calls(response)[0]["function"]["arguments"])["findings"]


# #312-T06: bounded. The engine gets the last reply, and a missing answer stays the model's failure.
def test_the_retries_are_bounded_and_the_last_reply_is_what_the_engine_gets() -> None:
    upstream = Sequence(answer_with_usage(), completion_with(content="prose"))
    subject = make(upstream)

    response = post(subject, loop_request())

    assert response.status == 200
    assert len(upstream.requests) == 1 + FINAL_ATTEMPTS
    assert streamed_calls(response) == []
    assert error_code(post(subject, loop_request())) == ErrorCode.LLM_OUTPUT_INVALID.value
    assert len(upstream.requests) == 1 + FINAL_ATTEMPTS  # nothing is forwarded after the final call
    notes = subject.ledger.recent_call_outcomes
    assert len(notes) == 3 and all(note.endswith("final call") for note in notes[1:])


# #312-T06: a reply with the tool call whose arguments stay invalid is handed to the engine anyway:
# the runner's validation then fails the run with the concrete field, not with a missing answer.
def test_arguments_that_stay_invalid_reach_the_engine_and_do_not_mark_a_missing_answer() -> None:
    upstream = Sequence(answer_with_usage(), returns(json.dumps(review(schemaVersion=2))))
    subject = make(upstream)

    response = post(subject, loop_request())

    assert [call["function"]["name"] for call in streamed_calls(response)] == ["StructuredOutput"]
    assert len(upstream.requests) == 1 + FINAL_ATTEMPTS
    assert error_code(post(subject, loop_request())) == ErrorCode.DYNAMIC_BUDGET_EXCEEDED.value


# #312-T06: a retry is a model call like any other: it is reserved and settled, so it counts.
def test_every_retry_is_accounted_like_a_model_call() -> None:
    upstream = Sequence(answer_with_usage(prompt=40, completion=7), completion_with(content="x"))
    subject = make(upstream)
    before = subject.ledger.model_calls

    post(subject, loop_request())

    assert subject.ledger.model_calls == before + FINAL_ATTEMPTS
    assert subject.ledger.usage("m").ai_calls == before + FINAL_ATTEMPTS


# #312-T06: no retry when the cost limit has no room for it; the first reply is what is returned.
def test_no_retry_is_made_when_the_cost_limit_has_no_room() -> None:
    # One call reserves about 0.0164 USD; the final call is charged 0.07 of the 0.08 limit.
    ledger = BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal("0.08")), output_tokens=4096, unit_costs=UNIT_COSTS
    )
    upstream = Sequence(answer_with_usage(cost=0.0001), completion_with(content="x", cost=0.07))
    subject = proxy(upstream, ledger=ledger)
    assert post(subject, loop_request()).status == 200
    assert ledger.begin_recovery()

    response = post(subject, loop_request())

    assert response.status == 200
    assert len(upstream.requests) == 2
    assert ledger.failure is None


# #312-T06: no retry when the clock has no room for it.
def test_no_retry_is_made_after_the_deadline() -> None:
    clock = [0.0]
    ledger = BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal(1), deadline_seconds=600),
        unit_costs=UNIT_COSTS,
        clock=lambda: clock[0],
    )

    class Late(Sequence):
        def __call__(self, url: str, body: bytes, headers: dict[str, str], limit: int) -> Any:
            result = super().__call__(url, body, headers, limit)
            if len(self.requests) == 2:
                clock[0] = 601.0  # the final call used up the clock
            return result

    upstream = Late(answer_with_usage(), completion_with(content="prose"))
    subject = proxy(upstream, ledger=ledger)
    assert post(subject, loop_request()).status == 200
    assert ledger.begin_recovery()

    response = post(subject, loop_request())

    assert response.status == 200
    assert len(upstream.requests) == 2


# #312-T06: a normal call is never checked, retried or rewritten.
def test_a_normal_call_in_prose_is_left_alone() -> None:
    upstream = Upstream(body=completion_with(content=json.dumps(review())))
    subject = proxy(upstream, ledger=final_ledger())

    response = post(subject, loop_request())

    assert response.status == 200
    assert streamed_calls(response) == []
    assert len(upstream.requests) == 1


# #312-T06: the wrap-up call at the cost or clock limit is a final call too.
def test_the_wrap_up_call_is_enforced_like_the_recovery_call() -> None:
    ledger = BudgetLedger(DynamicLimits(max_cost_usd=Decimal("0.07")), unit_costs=UNIT_COSTS)
    upstream = Sequence(completion_with(content="prose"), returns(review()))
    subject = proxy(upstream, ledger=ledger)

    response = post(subject, loop_request())

    assert ledger.stopped_early == "cost_limit"
    assert [call["function"]["name"] for call in streamed_calls(response)] == ["StructuredOutput"]
    assert len(upstream.requests) == 2
