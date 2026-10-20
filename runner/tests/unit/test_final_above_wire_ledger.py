# SPDX-License-Identifier: Apache-2.0

"""What the ledger does for a finalization that happens above the wire (#552, policy of #540/#542).

On the native path the proxy relays the engine's bytes and never rewrites a request, so the final
call of #542 cannot be made by the proxy. The adapter asks for the answer instead (a message, an
abort, one more message) and the ledger admits that one call past the limit when the adapter marks
it (`arm_final`). A run never ends without a review because of the cost guard: after the first
call that settles over the limit, or the first call the guard refuses, no agent call is admitted,
but the final answer and at most one repair are. The bound of #542 is unchanged: the limit, plus
the excess of the last normal call, plus the final call (plus the one repair).
"""

from decimal import Decimal

import pytest

from code_reviewer_runner.dynamic_review.budget import (
    WRAP_UP_RESERVE_SECONDS,
    BudgetLedger,
    DynamicLimits,
    LimitError,
    RefusedForFinal,
    Reservation,
    UnitCosts,
)
from code_reviewer_runner.result import ErrorCode

REQUEST = b"x" * 4000
LIMIT = Decimal("0.10")
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def ledger(*, above_wire: bool = True, clock: Clock | None = None) -> BudgetLedger:
    budget = BudgetLedger(
        DynamicLimits(max_cost_usd=LIMIT),
        window_tokens=1_000_000,
        output_tokens=1_024,
        unit_costs=UNIT_COSTS,
        clock=clock or Clock(),
    )
    if above_wire:
        budget.enable_final_above_wire()
    return budget


def call(budget: BudgetLedger, cost: str, request: bytes = REQUEST) -> Reservation:
    """One call, reserved and settled at `cost` (whatever the reservation was)."""
    reservation = budget.reserve_call(request, output_tokens=1_024)
    budget.settle_call(reservation, prompt_tokens=1000, completion_tokens=100, cost=Decimal(cost))
    return reservation


def refused(budget: BudgetLedger, request: bytes = REQUEST) -> RefusedForFinal:
    with pytest.raises(RefusedForFinal) as raised:
        budget.reserve_call(request, output_tokens=1_024)
    # What the proxy does with a refusal.
    budget.record_failure(raised.value)
    return raised.value


# #552-L01
def test_a_call_the_cost_limit_cannot_hold_is_a_refusal_to_finalize_not_the_runs_failure() -> None:
    budget = ledger()
    call(budget, "0.15")  # settles over the limit: the agent phase is over

    error = refused(budget)

    assert error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert budget.failure is None
    assert budget.take_refusal() is True
    assert budget.take_refusal() is False  # taken once
    assert budget.stopped_early == "cost_limit"


# #552-L02, #552-T11: without the mode the refusal ends the run, as it always did
def test_without_the_mode_the_same_refusal_is_the_failure_of_the_run() -> None:
    budget = ledger(above_wire=False)
    call(budget, "0.15")

    error = refused(budget)

    assert budget.failure is error
    assert budget.take_refusal() is False


# #552-L03
def test_a_refusal_that_is_not_about_the_cost_still_ends_the_run() -> None:
    budget = ledger()
    policy = LimitError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "a rule")

    budget.record_failure(policy)

    assert budget.failure is policy
    assert budget.take_refusal() is False


# #552-L04: the final call is admitted past the limit, once, and only when the adapter marked it
def test_the_marked_call_is_admitted_past_the_limit_as_the_final_call_and_once() -> None:
    budget = ledger()
    call(budget, "0.15")
    refused(budget)

    assert budget.arm_final() is True
    final = budget.reserve_call(REQUEST, output_tokens=1_024)
    assert final.final is True
    budget.settle_call(final, prompt_tokens=1000, completion_tokens=100, cost=Decimal("0.20"))

    # Nothing but the arm admits a call after it: the model's tool call in the final turn is
    # refused, and that refusal is again not the run's failure.
    refused(budget)
    assert budget.failure is None
    assert budget.take_refusal() is True
    assert budget.usage(None).cost_usd == pytest.approx(0.35)  # pyright: ignore[reportUnknownMemberType]


# #552-L05
def test_an_unmarked_call_is_never_admitted_as_the_final_call_by_what_it_carries() -> None:
    budget = ledger()
    call(budget, "0.15")

    # No request, whatever its size, is the final call unless the adapter marked it.
    for request in (REQUEST, b"", b"x" * 100_000):
        with pytest.raises(RefusedForFinal):
            budget.reserve_call(request, output_tokens=1_024, can_wrap_up=False)


# #552-L06: the call that does not fit, but whose spend is within the limit, is final too
def test_the_marked_call_is_admitted_when_only_its_expected_cost_does_not_fit() -> None:
    budget = ledger()
    call(budget, "0.099")  # within the limit by a hair
    error = refused(budget)
    assert error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED

    assert budget.arm_final() is True
    final = budget.reserve_call(REQUEST, output_tokens=1_024)
    assert final.final is True


# #552-L07: the repair is the other half of the policy; no third marked call
def test_the_repair_is_admitted_after_the_final_call_and_then_nothing() -> None:
    budget = ledger()
    call(budget, "0.15")
    refused(budget)
    assert budget.arm_final() is True
    final = budget.reserve_call(REQUEST, output_tokens=1_024)
    budget.settle_call(final, prompt_tokens=1000, completion_tokens=100, cost=Decimal("0.20"))

    assert budget.arm_final() is True  # the repair, although the spend is over the limit
    repair = budget.reserve_call(REQUEST, output_tokens=1_024)
    assert repair.final is True
    budget.settle_call(repair, prompt_tokens=1000, completion_tokens=100, cost=Decimal("0.01"))

    assert budget.arm_final() is False


# #552-L08, #552-T05: a run within the limit that needs a repair is repaired without the
# wrap-up having happened
def test_a_repair_inside_the_limit_is_marked_like_the_final_call_and_does_not_stop_early() -> None:
    budget = ledger()
    call(budget, "0.01")

    assert budget.arm_final() is True
    repair = budget.reserve_call(REQUEST, output_tokens=1_024)

    assert repair.final is True
    assert budget.stopped_early is None


# #552-L09: the mark only counts for a call that can be told apart: fail closed
def test_the_mark_is_refused_while_a_call_is_in_flight_or_after_the_deadline() -> None:
    clock = Clock()
    budget = ledger(clock=clock)
    in_flight = budget.reserve_call(REQUEST, output_tokens=1_024)

    assert budget.arm_final() is False
    budget.settle_unbilled(in_flight)
    assert budget.arm_final() is True

    late = Clock()
    other = ledger(clock=late)
    late.now = other.limits.deadline_seconds + 1
    assert other.arm_final() is False


# #552-L10: the mark is one call; an unused mark is not a second one
def test_an_armed_mark_is_consumed_by_exactly_one_call() -> None:
    budget = ledger()
    call(budget, "0.15")
    assert budget.arm_final() is True
    assert budget.arm_final() is False  # armed already

    first = budget.reserve_call(REQUEST, output_tokens=1_024)
    assert first.final is True
    with pytest.raises(RefusedForFinal):
        budget.reserve_call(REQUEST, output_tokens=1_024)


# #552-L11, #552-T06: the soft question is read only and answers before the hard refusal
def test_wrap_up_is_due_before_the_next_call_would_leave_no_room_for_the_final_one() -> None:
    budget = ledger()
    assert budget.wrap_up_due() is None  # nothing seen yet
    call(budget, "0.01")
    assert budget.wrap_up_due() is None
    call(budget, "0.0895")  # within the limit, but a further call and a final one would not fit

    assert budget.wrap_up_due() == "cost_limit"
    assert budget.stopped_early is None  # asking changes nothing
    # The hard refusal comes later or at the same time, never earlier than the question.
    with pytest.raises(RefusedForFinal):
        budget.reserve_call(REQUEST, output_tokens=1_024)


# #552-L12: the clock: the question is answered a little before the reserve starts
def test_the_clock_asks_for_the_answer_before_the_reserve_and_refuses_inside_it() -> None:
    clock = Clock()
    budget = ledger(clock=clock)
    reserve = min(WRAP_UP_RESERVE_SECONDS, 0.25 * budget.limits.deadline_seconds)
    clock.now = budget.limits.deadline_seconds - reserve * 1.5
    assert budget.wrap_up_due() is None

    clock.now = budget.limits.deadline_seconds - reserve * 1.3
    assert budget.wrap_up_due() == "time_limit"
    call(budget, "0.001")  # still a normal call: the reserve has not started

    clock.now = budget.limits.deadline_seconds - reserve + 1
    error = refused(budget)
    assert error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert budget.failure is None
    assert budget.stopped_early == "time_limit"
    assert budget.arm_final() is True


# #552-L13: the mode is the adapter's declaration; the legacy ledger never refuses on the clock
def test_the_clock_reserve_is_not_a_refusal_without_the_mode() -> None:
    clock = Clock()
    budget = ledger(above_wire=False, clock=clock)
    clock.now = budget.limits.deadline_seconds - 1

    reservation = budget.reserve_call(REQUEST, output_tokens=1_024)

    assert reservation.final is False


# #552-L14: announcing is recorded as the reason the run stopped early; the first reason wins
def test_the_announcement_is_the_reason_the_run_stopped_early() -> None:
    budget = ledger()
    budget.note_wrap_up("time_limit")
    budget.note_wrap_up("cost_limit")

    assert budget.stopped_early == "time_limit"
    assert budget.usage(None).stopped_early == "time_limit"


# #552-L15: the overshoot is the bound of #542 and not a call more
def test_the_overshoot_stays_within_the_excess_of_the_last_call_the_final_call_and_the_repair() -> (
    None
):
    budget = ledger()
    call(budget, "0.05")
    expected = budget.reserve_call(REQUEST, output_tokens=1_024)
    budget.settle_call(
        expected, prompt_tokens=1000, completion_tokens=100, cost=expected.cost + Decimal("0.08")
    )
    excess_of_last_normal = Decimal("0.05") + expected.cost + Decimal("0.08") - LIMIT
    assert excess_of_last_normal > 0
    refused(budget)

    final_cost = Decimal("0.03")
    assert budget.arm_final() is True
    final = budget.reserve_call(REQUEST, output_tokens=1_024)
    budget.settle_call(final, prompt_tokens=1000, completion_tokens=100, cost=final_cost)
    assert budget.arm_final() is True
    repair = budget.reserve_call(REQUEST, output_tokens=1_024)
    repair_cost = Decimal("0.02")
    budget.settle_call(repair, prompt_tokens=1000, completion_tokens=100, cost=repair_cost)
    refused(budget)  # a tool call in the repair turn

    spent = Decimal(str(budget.usage(None).cost_usd))
    bound = LIMIT + excess_of_last_normal + final_cost + repair_cost
    assert spent <= bound + Decimal("0.000001")
    assert budget.limit_exceeded_by is not None


# #552-T09 (audit): on the native path a recorded failure stops every later call at the ledger
def test_no_call_is_reserved_once_the_run_has_failed() -> None:
    budget = ledger()
    budget.record_failure(
        LimitError(
            ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "a tool result exceeds the per-result byte bound"
        )
    )

    with pytest.raises(LimitError) as raised:
        budget.reserve_call(REQUEST, output_tokens=1_024)

    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert "per-result byte bound" in raised.value.detail
    assert budget.arm_final() is False
