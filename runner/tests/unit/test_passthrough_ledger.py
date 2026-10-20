# SPDX-License-Identifier: Apache-2.0

"""What the passthrough proxy asks of the budget ledger beyond the legacy path (#550).

The proxy relays the engine's bytes and never builds a request text, so a call is reserved by its
byte size. The engine retries by itself (429, 5xx, cut streams), so a refused or cut call must be
settled without ending the run: a refusal costs nothing, a call whose usage was never seen may have
been billed and is held as spent while the run's cost becomes unknown.
"""

from decimal import Decimal

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
    UnitCosts,
)
from code_reviewer_runner.result import ErrorCode

UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(3), output_usd_per_mtok=Decimal(15))


def ledger(limit: str = "1.00") -> BudgetLedger:
    return BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal(limit)),
        window_tokens=200_000,
        output_tokens=8_192,
        unit_costs=UNIT_COSTS,
    )


# #550-L01
def test_a_call_is_reserved_by_the_bytes_of_its_body() -> None:
    body = bytes(range(128, 256)) * 40  # 5120 bytes that are no UTF-8 text
    by_bytes = ledger().reserve_call(body, output_tokens=1_000)
    by_text = ledger().reserve_call("a" * 5120, output_tokens=1_000)
    assert by_bytes.request_bytes == 5120
    assert by_bytes.byte_bound == by_text.byte_bound
    assert by_bytes.cost == by_text.cost


# #550-L02
def test_a_refused_call_is_released_and_counts_as_a_call_that_cost_nothing() -> None:
    budget = ledger()
    reservation = budget.reserve_call(b"x" * 3000, output_tokens=1_000)
    assert reservation.cost > 0
    budget.settle_unbilled(reservation)
    usage = budget.usage("m")
    assert usage.ai_calls == 1
    assert usage.cost_usd == 0.0
    # What was held is free again: a second call is reserved at the same price as the first.
    assert budget.reserve_call(b"x" * 3000, output_tokens=1_000).cost == reservation.cost


# #550-L03
def test_a_call_without_usage_stays_spent_and_makes_the_run_cost_unknown() -> None:
    budget = ledger("0.05")
    first = budget.reserve_call(b"x" * 3000, output_tokens=1_000)
    budget.settle_unknown(first)
    usage = budget.usage("m")
    assert usage.ai_calls == 1
    assert usage.cost_usd is None
    # The reservation is not given back: the guard still counts it, so a run of cut streams
    # cannot go on for ever.
    with pytest.raises(LimitError) as raised:
        for _ in range(20):
            budget.settle_unknown(budget.reserve_call(b"x" * 3000, output_tokens=1_000))
    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #550-B1-L04
def test_a_call_that_reports_more_output_than_it_reserved_is_booked_before_the_run_stops() -> None:
    budget = ledger()
    reservation = budget.reserve_call(b"x" * 3000, output_tokens=1_000)
    reported = Decimal("0.40")
    with pytest.raises(LimitError) as raised:
        budget.settle_call(
            reservation,
            prompt_tokens=100,
            completion_tokens=reservation.output_tokens + 1,
            cost=reported,
        )
    assert raised.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    # What the provider charged is spent, whatever the run does next; the hold is released.
    usage = budget.usage("m")
    assert usage.cost_usd == pytest.approx(0.40)
    assert budget.reserve_call(b"x" * 3000, output_tokens=1_000).cost == reservation.cost


# #550-B1-L04
def test_a_call_that_reports_more_prompt_than_the_bytes_allow_is_booked_too() -> None:
    budget = ledger()
    reservation = budget.reserve_call(b"x" * 300, output_tokens=1_000)
    with pytest.raises(LimitError):
        budget.settle_call(
            reservation, prompt_tokens=10**6, completion_tokens=10, cost=Decimal("2.5")
        )
    assert budget.usage("m").cost_usd == pytest.approx(2.5)


# #550-B1-L04
def test_an_over_report_without_a_cost_is_booked_at_what_was_reserved() -> None:
    budget = ledger()
    reservation = budget.reserve_call(b"x" * 3000, output_tokens=1_000)
    with pytest.raises(LimitError):
        budget.settle_call(reservation, prompt_tokens=100, completion_tokens=2_000, cost=None)
    # No cost was reported, so none is known: the run's cost is unknown, and the guard keeps
    # counting the reservation as spent.
    assert budget.usage("m").cost_usd is None
    held_after = budget.reserve_call(b"x" * 3000, output_tokens=1_000)
    assert held_after.cost >= reservation.cost


# #550-B3-L05
def test_a_call_without_usage_is_booked_at_its_worst_case_not_its_expected_cost() -> None:
    budget = BudgetLedger(
        DynamicLimits(max_cost_usd=Decimal("1.00")),
        window_tokens=200_000,
        output_tokens=8_192,
        unit_costs=UnitCosts(
            input_usd_per_mtok=Decimal(3),
            output_usd_per_mtok=Decimal(15),
            cache_read_usd_per_mtok=Decimal("0.3"),
            cache_write_usd_per_mtok=Decimal("3.75"),
        ),
    )
    reservation = budget.reserve_call(b"x" * 3000, output_tokens=1_000)
    budget.settle_unknown(reservation)
    # Every byte as a token at the dearest input price (the cache write), plus the whole cap.
    worst = Decimal(3000) * Decimal("3.75") / 1_000_000 + Decimal(1000) * 15 / 1_000_000
    assert budget.worst_case_cost(reservation) == worst
    assert budget._counters.cost == worst  # pyright: ignore[reportPrivateUsage]
    assert worst > reservation.cost
    assert budget.unknown_calls == 1
    assert budget._counters.reserved_cost == 0  # pyright: ignore[reportPrivateUsage]
