# SPDX-License-Identifier: Apache-2.0

"""The ledger stand-in of the plain-JSON finalization spike (#547).

`FinalExemptLedger` (`tests/engine/plain_json_engine.py`) is what the engine test uses until #552
gives the plain path the final-call exemption of #542 (which is tied to a request the proxy can
rewrite into the structured-output call, and the plain path has none). It must keep the rules of
the merged ledger: a normal call that settles over the limit is delivered and ends the agent phase,
the next normal call is refused (and is not the run's failure), and the exemption admits exactly
one more call, whatever the limit says.
"""

import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from plain_json_engine import FinalExemptLedger

from code_reviewer_runner.dynamic_review.budget import DynamicLimits, LimitError, UnitCosts
from code_reviewer_runner.result import ErrorCode

REQUEST = "x" * 400
LIMIT = Decimal("0.10")


def make_ledger() -> FinalExemptLedger:
    return FinalExemptLedger(
        DynamicLimits(max_cost_usd=LIMIT),
        window_tokens=1_000_000,
        output_tokens=1_024,
        unit_costs=UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(1)),
    )


def settle(ledger: FinalExemptLedger, cost: str) -> None:
    reservation = ledger.reserve_call(REQUEST, output_tokens=1_024)
    ledger.settle_call(reservation, prompt_tokens=100, completion_tokens=100, cost=Decimal(cost))


# #547-T04 (#552, policy of #540): over the limit, the next normal call is refused without
# failing the run, and the exemption admits one more call and then no other.
def test_the_exemption_admits_exactly_one_call_after_a_normal_call_settled_over_the_limit() -> None:
    ledger = make_ledger()
    settle(ledger, "0.15")

    with pytest.raises(LimitError) as refused:
        ledger.reserve_call(REQUEST, output_tokens=1_024)
    assert refused.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    ledger.record_failure(refused.value)  # what the proxy does with a refusal
    assert ledger.refused_at_limit is True
    assert ledger.failure is None

    ledger.arm_exempt()
    settle(ledger, "0.20")
    assert ledger.exempt_calls == 1
    assert ledger.failure is None

    with pytest.raises(LimitError) as again:
        ledger.reserve_call(REQUEST, output_tokens=1_024)
    assert again.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert ledger.usage(None).cost_usd == pytest.approx(0.35)  # pyright: ignore[reportUnknownMemberType]


# #547-T06: a failure that is not the cost limit is still the run's failure.
def test_a_refusal_that_is_not_the_cost_limit_is_still_recorded() -> None:
    ledger = make_ledger()
    failure = LimitError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "a rule")

    ledger.record_failure(failure)

    assert ledger.refused_at_limit is False
    assert ledger.failure is failure
