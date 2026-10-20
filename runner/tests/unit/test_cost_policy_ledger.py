# SPDX-License-Identifier: Apache-2.0

"""How the budget ledger carries the cost policy (#553): an unpriced run, the token cap of an own
key, and what an unknown call books for each key.

The ledger of a priced run is the ledger of #540 and is not touched (`test_dynamic_review_budget.py`
and `test_passthrough_ledger.py` keep proving it). Here: with no price there is no dollar to bound
a run by, so tokens are reserved and settled, the run stops at `maxTotalTokens`, and its cost is
unknown (None), never zero.
"""

from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
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

BOOK: dict[str, Any] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": None,
    "reasoning": None,
    "inputAudio": None,
    "outputAudio": None,
    "contextOver200k": None,
    "tiers": [],
}


def unpriced(cap: int = 100_000) -> BudgetLedger:
    return build_native_ledger(
        CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=cap),
        DynamicLimits(),
        window_tokens=1_000_000,
        output_tokens=4_096,
    )


def priced_own(cap: int = 100_000, limit: str = "1.00", **options: Any) -> BudgetLedger:
    policy = parse_cost_policy({"keyMode": "own", "priceBook": BOOK, "maxTotalTokens": cap})
    return build_native_ledger(
        policy,
        DynamicLimits(max_cost_usd=Decimal(limit)),
        window_tokens=1_000_000,
        output_tokens=4_096,
        **options,
    )


def managed() -> BudgetLedger:
    policy = parse_cost_policy({"keyMode": "managed", "priceBook": BOOK, "maxTotalTokens": None})
    return build_native_ledger(
        policy, DynamicLimits(), window_tokens=1_000_000, output_tokens=4_096
    )


def reserve(ledger: BudgetLedger, size: int = 30_000, output: int = 1_000) -> Reservation:
    return ledger.reserve_call(b"x" * size, output_tokens=output)


def settle(ledger: BudgetLedger, reservation: Reservation, prompt: int, completion: int) -> None:
    ledger.settle_call(
        reservation,
        prompt_tokens=prompt,
        completion_tokens=completion,
        cost=None,
        allow_unpriced=True,
    )


# #553-T05
def test_an_unpriced_run_reserves_and_settles_tokens_and_its_cost_is_unknown() -> None:
    ledger = unpriced()
    reservation = reserve(ledger)
    assert reservation.cost == 0 and reservation.tokens > 0
    settle(ledger, reservation, prompt=9_000, completion=400)
    usage = ledger.usage("m")
    assert usage.prompt_tokens == 9_000 and usage.completion_tokens == 400
    assert usage.ai_calls == 1
    # Unknown, not zero: the run was never priced.
    assert usage.cost_usd is None
    assert usage.limit_exceeded_by is None


# #553-T05
def test_an_unpriced_run_stops_when_the_token_cap_is_reached() -> None:
    ledger = unpriced(cap=40_000)
    first = reserve(ledger)
    settle(ledger, first, prompt=9_000, completion=500)
    second = reserve(ledger)
    settle(ledger, second, prompt=30_000, completion=500)
    # 40,000 tokens are used: the cap is reached, no call is admitted any more.
    with pytest.raises(LimitError) as raised:
        reserve(ledger)
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "token" in raised.value.detail
    assert ledger.usage("m").cost_usd is None


# #553-T05
def test_a_call_that_could_pass_the_cap_is_refused_before_it_is_sent() -> None:
    ledger = unpriced(cap=20_000)
    # About 10,000 tokens of input at the conservative density and 1,000 of output fit; twice that
    # do not.
    settle(ledger, reserve(ledger, size=30_000), prompt=9_000, completion=500)
    with pytest.raises(LimitError) as raised:
        reserve(ledger, size=60_000)
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #553-T05
def test_a_call_that_settles_over_the_cap_is_delivered_and_ends_the_agent_phase() -> None:
    ledger = unpriced(cap=20_000)
    reservation = reserve(ledger, size=30_000)
    # The provider reports more than was expected: delivered, but nothing follows it.
    settle(ledger, reservation, prompt=25_000, completion=500)
    with pytest.raises(LimitError):
        reserve(ledger, size=30_000)
    assert ledger.usage("m").prompt_tokens == 25_000


# #553-T10
def test_the_deadline_ends_an_unpriced_run_exactly_as_a_priced_one() -> None:
    clock = [0.0]
    ledger = build_native_ledger(
        CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=1_000_000),
        DynamicLimits(deadline_seconds=100.0),
        window_tokens=1_000_000,
        output_tokens=4_096,
        clock=lambda: clock[0],
    )
    reserve(ledger)
    clock[0] = 100.0
    with pytest.raises(LimitError) as raised:
        reserve(ledger)
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert ledger.expired()


# #553-T04
def test_a_priced_own_run_is_bound_by_dollars_and_the_token_cap_does_not_apply() -> None:
    # Far more tokens than the cap: the price is known, so the dollar limit of #540 is the bound.
    ledger = priced_own(cap=1_000, limit="5.00")
    for _ in range(3):
        reservation = reserve(ledger, size=30_000)
        ledger.settle_call(
            reservation,
            prompt_tokens=9_000,
            completion_tokens=500,
            cost=Decimal("0.0345"),
        )
    usage = ledger.usage("m")
    assert usage.prompt_tokens == 27_000 > 1_000
    assert usage.cost_usd == pytest.approx(0.1035)


# #553-T04
def test_a_priced_own_run_stops_at_its_dollar_limit_as_before() -> None:
    ledger = priced_own(cap=10_000_000, limit="0.05")
    with pytest.raises(LimitError) as raised:
        for _ in range(100):
            reservation = reserve(ledger, size=30_000)
            ledger.settle_call(
                reservation, prompt_tokens=9_000, completion_tokens=500, cost=Decimal("0.0345")
            )
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "cost" in raised.value.detail


# #553-T05
def test_an_unknown_call_of_an_own_key_books_its_expected_tokens_and_not_its_worst_case() -> None:
    ledger = priced_own(cap=1_000_000, limit="0.50")
    reservation = reserve(ledger, size=30_000)
    assert ledger.settle_unknown(reservation, worst_case=False) is True
    counters = ledger._counters  # pyright: ignore[reportPrivateUsage]
    assert counters.cost == reservation.cost < ledger.worst_case_cost(reservation)
    assert ledger.unknown_calls == 1
    assert ledger.usage("m").cost_usd is None
    assert counters.unknown_tokens == reservation.tokens


# #553-T05
def test_once_a_call_is_unknown_the_token_cap_binds_a_priced_own_run_too() -> None:
    ledger = priced_own(cap=30_000, limit="5.00")
    ledger.settle_unknown(reserve(ledger, size=30_000), worst_case=False)
    with pytest.raises(LimitError) as raised:
        for _ in range(20):
            settle(ledger, reserve(ledger, size=30_000), prompt=9_000, completion=500)
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "token" in raised.value.detail


# #553-T03
def test_a_managed_ledger_has_no_token_cap_and_books_the_worst_case_of_an_unknown_call() -> None:
    ledger = managed()
    reservation = reserve(ledger, size=30_000)
    assert ledger.settle_unknown(reservation) is True
    counters = ledger._counters  # pyright: ignore[reportPrivateUsage]
    assert counters.cost == ledger.worst_case_cost(reservation) > reservation.cost
    assert ledger.usage("m").cost_usd is None


# #553-T03
def test_a_managed_ledger_refuses_a_settlement_without_a_price() -> None:
    ledger = managed()
    reservation = reserve(ledger)
    with pytest.raises(LimitError) as raised:
        ledger.settle_call(reservation, prompt_tokens=9_000, completion_tokens=500, cost=None)
    assert raised.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #553-T03
def test_a_priced_ledger_refuses_an_unpriced_settlement_unless_it_is_asked_to_allow_it() -> None:
    # `allow_unpriced` belongs to an own key; a managed ledger never gets there.
    ledger = managed()
    with pytest.raises(LimitError) as raised:
        ledger.settle_call(
            reserve(ledger),
            prompt_tokens=9_000,
            completion_tokens=500,
            cost=None,
            allow_unpriced=True,
        )
    assert raised.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED


# #553-R05
def test_an_unpriced_ledger_cannot_be_built_for_a_managed_key() -> None:
    with pytest.raises(LimitError) as raised:
        build_native_ledger(
            CostPolicy(key_mode=KeyMode.MANAGED, book=None, max_total_tokens=None),
            DynamicLimits(),
            window_tokens=1_000_000,
            output_tokens=4_096,
        )
    assert raised.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #553-R05
def test_an_own_ledger_cannot_be_built_without_a_token_cap() -> None:
    with pytest.raises(LimitError) as raised:
        build_native_ledger(
            CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=None),
            DynamicLimits(),
            window_tokens=1_000_000,
            output_tokens=4_096,
        )
    assert raised.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #553-R06
def test_the_output_a_call_may_use_is_the_cap_the_engine_really_sends() -> None:
    # Spike #546: the engine sends min(limit.output, 32000), and the ledger holds the call to it.
    assert NATIVE_OUTPUT_CAP == 32_000
    ledger = build_native_ledger(
        CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=10_000_000),
        DynamicLimits(),
        window_tokens=2_000_000,
        output_tokens=NATIVE_OUTPUT_CAP,
    )
    assert reserve(ledger, output=NATIVE_OUTPUT_CAP).output_tokens == NATIVE_OUTPUT_CAP


# #548-comment (reasoning): a reasoning model's thinking tokens count as output, so its first call
# is reserved at the output cap and not at the floor of a model that does not think.
def test_a_reasoning_model_reserves_more_than_the_same_model_without_the_flag() -> None:
    plain = priced_own(cap=10_000_000, limit="5.00", reasoning=False)
    thinking = priced_own(cap=10_000_000, limit="5.00", reasoning=True)
    cheap = reserve(plain, size=3_000, output=NATIVE_OUTPUT_CAP)
    dear = reserve(thinking, size=3_000, output=NATIVE_OUTPUT_CAP)
    assert dear.cost > cheap.cost
    assert dear.tokens > cheap.tokens


# #548-comment (reasoning): a run that goes beyond its reservation stops under the token cap.
def test_a_reasoning_run_that_goes_beyond_its_reservation_stops_under_the_token_cap() -> None:
    ledger = build_native_ledger(
        CostPolicy(key_mode=KeyMode.OWN, book=None, max_total_tokens=100_000),
        DynamicLimits(),
        window_tokens=1_000_000,
        output_tokens=NATIVE_OUTPUT_CAP,
        reasoning=True,
    )
    with pytest.raises(LimitError) as raised:
        for _ in range(20):
            reservation = reserve(ledger, size=3_000, output=NATIVE_OUTPUT_CAP)
            settle(ledger, reservation, prompt=1_000, completion=NATIVE_OUTPUT_CAP)
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert ledger.usage("m").completion_tokens <= 100_000 + NATIVE_OUTPUT_CAP


# #553-T05
def test_a_run_that_can_be_rewritten_is_wrapped_up_before_the_token_cap_is_passed() -> None:
    # The legacy-shaped path: a request that can become the final answer is granted as the final
    # call when a further normal call and a final one would not fit the cap, and says why.
    ledger = unpriced(cap=36_000)
    settle(ledger, reserve(ledger, size=30_000), prompt=9_000, completion=500)
    final = ledger.reserve_call(
        b"x" * 30_000, output_tokens=1_000, can_wrap_up=True, wrap_up_text="Answer now."
    )
    assert final.final is True
    assert ledger.stopped_early == "token_limit"
    # Nothing is granted after it.
    with pytest.raises(LimitError):
        reserve(ledger)
