# SPDX-License-Identifier: LicenseRef-Proprietary

"""The token cap of an own key above the wire (#553 with #552).

The native path never rewrites a request, so a call the guard cannot hold is a refusal the adapter
answers with the final call. The cap is held to the same rule as the cost limit: its refusal is
`RefusedForFinal` with the reason `token_limit`, not the failure of the run; the answer is still
asked for (`arm_final`) and admitted past the cap, once; an unknown call that takes the run over
the cap ends the agent phase without ending the review.
"""

import json
from decimal import Decimal

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
    RefusedForFinal,
    Reservation,
)
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import (
    NATIVE_OUTPUT_CAP,
    CostPolicy,
    KeyMode,
    build_native_ledger,
    parse_cost_policy,
)
from code_reviewer_runner.result import ErrorCode

REQUEST = b"x" * 30_000
TOKEN = "t0k3n-0123456789"
MESSAGE = f'<runner-wrap-up id="{TOKEN}">\nAnswer now.\n</runner-wrap-up>'
BOOK = {"input": "3000000", "output": "15000000"}


def own(*, cap: int = 20_000, priced: bool = False, limit: str = "5") -> BudgetLedger:
    policy = parse_cost_policy(
        {"keyMode": "own", "priceBook": BOOK if priced else None, "maxTotalTokens": cap}
    )
    budget = build_native_ledger(
        policy,
        DynamicLimits(max_cost_usd=Decimal(limit)),
        window_tokens=1_000_000,
        output_tokens=4_096,
    )
    budget.enable_final_above_wire()
    return budget


def carrying() -> bytes:
    escaped = json.dumps(MESSAGE)[1:-1].encode()
    return b"x" * len(REQUEST) + b'"text":"' + escaped + b'"'


def settle(budget: BudgetLedger, prompt: int, request: bytes = REQUEST) -> Reservation:
    reservation = budget.reserve_call(request, output_tokens=1_000)
    budget.settle_call(
        reservation,
        prompt_tokens=prompt,
        completion_tokens=500,
        cost=None,
        allow_unpriced=True,
    )
    return reservation


def refused(budget: BudgetLedger) -> RefusedForFinal:
    with pytest.raises(RefusedForFinal) as raised:
        budget.reserve_call(REQUEST, output_tokens=1_000)
    budget.record_failure(raised.value)  # what the proxy does with a refusal
    return raised.value


# #553-T05, #552
def test_a_call_the_token_cap_cannot_hold_is_a_refusal_to_finalize_not_the_runs_failure() -> None:
    budget = own()
    settle(budget, 25_000)  # settles over the cap: the agent phase is over

    error = refused(budget)

    assert error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "token" in error.detail
    assert budget.failure is None
    assert budget.refusals == 1
    assert budget.refusal_reason == "token_limit"
    assert budget.stopped_early is None


# #553-T05, #552: a call that does not fit the cap yet (nothing settled over it) is the same
def test_a_call_whose_expected_tokens_do_not_fit_is_refused_for_the_answer_too() -> None:
    budget = own(cap=15_000)
    settle(budget, 9_000)

    error = refused(budget)

    assert "token" in error.detail and budget.refusal_reason == "token_limit"
    assert budget.failure is None


# #553-T05, #552
def test_the_answer_is_asked_for_and_admitted_past_the_cap_once() -> None:
    budget = own()
    settle(budget, 25_000)
    refused(budget)

    assert budget.arm_final(MESSAGE, TOKEN) is True
    final = budget.reserve_call(carrying(), output_tokens=1_000, last_user_text=MESSAGE)
    assert final.final is True and final.marked is True
    budget.settle_call(
        final, prompt_tokens=9_000, completion_tokens=500, cost=None, allow_unpriced=True
    )

    refused(budget)  # the model's tool call in the final turn
    assert budget.failure is None
    assert budget.usage(None).cost_usd is None


# #553-T05, #552: a priced run is a ceiling too, and the answer is still admitted
def test_a_priced_own_run_over_the_cap_still_gets_its_answer() -> None:
    budget = own(priced=True)
    budget.settle_call(
        budget.reserve_call(REQUEST, output_tokens=1_000),
        prompt_tokens=25_000,
        completion_tokens=500,
        cost=Decimal("0.09"),
    )
    refused(budget)

    assert budget.arm_final(MESSAGE, TOKEN) is True
    final = budget.reserve_call(carrying(), output_tokens=1_000, last_user_text=MESSAGE)
    assert final.final is True


# #553-T05, #552: the answer is announced before the refusal
def test_the_answer_is_announced_when_a_further_call_and_the_answer_would_not_fit() -> None:
    budget = own(cap=36_000)
    settle(budget, 9_000)

    assert budget.wrap_up_due() == "token_limit"
    assert budget.stopped_early is None  # reading it records nothing


# #552, #553
def test_the_reason_of_a_token_stop_is_kept_by_note_wrap_up() -> None:
    budget = own()
    settle(budget, 25_000)
    refused(budget)

    budget.note_wrap_up(budget.refusal_reason or "cost_limit")

    assert budget.stopped_early == "token_limit"
    budget.note_wrap_up("time_limit")  # the first reason wins
    assert budget.stopped_early == "token_limit"


# #552-F4, #553-L2: both rules combined
def test_an_unknown_call_that_passes_the_token_cap_ends_the_agent_phase_and_not_the_review() -> (
    None
):
    budget = own(cap=20_000, priced=True)
    budget.settle_call(
        budget.reserve_call(REQUEST, output_tokens=1_000),
        prompt_tokens=9_000,
        completion_tokens=500,
        cost=Decimal("0.03"),
    )
    budget.settle_unknown(budget.reserve_call(REQUEST, output_tokens=4_000), worst_case=False)

    error = refused(budget)
    assert "token" in error.detail and budget.refusal_reason == "token_limit"
    assert budget.failure is None
    assert budget.arm_final(MESSAGE, TOKEN) is True


# #552-F4, #553-L2: the cost rule still holds next to the token rule
def test_an_unknown_call_whose_worst_case_passes_the_cost_limit_ends_the_agent_phase() -> None:
    budget = own(cap=1_000_000, priced=True, limit="0.10")
    # Booked at its worst case (30,000 bytes at 3 USD and 4,000 tokens at 15 USD per million: 0.15).
    budget.settle_unknown(budget.reserve_call(REQUEST, output_tokens=4_000))

    error = refused(budget)
    assert budget.failure is None
    assert "cost limit" in error.detail and budget.refusal_reason == "cost_limit"
    assert budget.arm_final(MESSAGE, TOKEN) is True


# #553: the managed key has no cap, so its refusal stays the cost limit's
def test_a_managed_ledger_never_refuses_for_tokens() -> None:
    policy = parse_cost_policy({"keyMode": "managed", "priceBook": BOOK, "maxTotalTokens": None})
    budget = build_native_ledger(
        policy,
        DynamicLimits(max_cost_usd=Decimal("0.05")),
        window_tokens=1_000_000,
        output_tokens=NATIVE_OUTPUT_CAP,
    )
    budget.enable_final_above_wire()
    budget.settle_call(
        budget.reserve_call(REQUEST, output_tokens=1_000),
        prompt_tokens=25_000,
        completion_tokens=500,
        cost=Decimal("0.09"),
    )

    error = refused(budget)

    assert "cost limit" in error.detail
    assert budget.refusal_reason == "cost_limit"


def test_the_policy_module_still_exports_what_the_tests_use() -> None:
    assert CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=1).max_total_tokens == 1
    assert LimitError is not RefusedForFinal
