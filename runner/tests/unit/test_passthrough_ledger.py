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
