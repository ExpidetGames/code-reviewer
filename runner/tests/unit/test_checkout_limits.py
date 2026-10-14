# SPDX-License-Identifier: Apache-2.0
"""Exact byte envelopes and cancellation cannot reset or extend a preparation lifetime."""

import pytest

from code_reviewer_runner.dynamic_review.limits import (
    Budget,
    CheckoutError,
    CheckoutReason,
    Limits,
)


# #196-T04 #196-T12
@pytest.mark.parametrize("exposed", [False, True])
def test_exact_byte_limit_is_accepted_and_one_over_is_refused(exposed: bool) -> None:
    budget = Budget(Limits(preparation_bytes=10, exposed_bytes=10))
    budget.charge(9, exposed=exposed)
    budget.charge(1, exposed=exposed)
    with pytest.raises(CheckoutError):
        budget.charge(1, exposed=exposed)


# #296-T04
def test_transfer_and_preparation_are_separate_budgets() -> None:
    budget = Budget(Limits(transfer_bytes=10, preparation_bytes=10, exposed_bytes=10))
    budget.charge_transfer(10)
    budget.charge(10)
    budget.charge(10, exposed=True)
    assert (budget.transfer, budget.preparation, budget.exposed) == (10, 10, 10)
    with pytest.raises(CheckoutError) as transfer:
        budget.charge_transfer(1)
    assert transfer.value.reason is CheckoutReason.BUDGET_TRANSFER
    with pytest.raises(CheckoutError) as preparation:
        budget.charge(1)
    assert preparation.value.reason is CheckoutReason.BUDGET_PREPARATION


# #296-T04
def test_the_transfer_budget_is_charged_per_chunk_and_never_below_zero() -> None:
    budget = Budget(Limits(transfer_bytes=10))
    budget.charge_transfer(4)
    budget.charge_transfer(6)
    with pytest.raises(CheckoutError):
        budget.charge_transfer(-1)


# #296-T04
def test_the_fixed_envelope_gives_the_transfer_budget_the_former_maximum() -> None:
    assert Limits().transfer_bytes == 256 * 1024 * 1024
    assert Limits().preparation_bytes == 256 * 1024 * 1024
    with pytest.raises(ValueError):
        Limits(transfer_bytes=256 * 1024 * 1024 + 1)


# #196-T08
def test_cancellation_prevents_another_write() -> None:
    budget = Budget(Limits(), cancelled=lambda: True)
    with pytest.raises(CheckoutError):
        budget.charge(1)
    assert budget.preparation == 0


# #196-T08
def test_deadline_is_not_renewed_by_repeated_operations(monkeypatch: pytest.MonkeyPatch) -> None:
    now = 10.0
    monkeypatch.setattr("code_reviewer_runner.dynamic_review.limits.time.monotonic", lambda: now)
    budget = Budget(Limits(seconds=2))
    now = 11.0
    budget.charge(1)
    now = 12.0
    with pytest.raises(CheckoutError, match="timeout"):
        budget.charge(1)


# #196-T04
def test_invalid_limits_are_refused() -> None:
    with pytest.raises(ValueError):
        Limits(entries=0)


# #196-T04
@pytest.mark.parametrize(
    "changes",
    [
        {"entries": 20_001},
        {"file_bytes": 524_289},
        {"seconds": float("inf")},
        {"seconds": float("nan")},
    ],
)
def test_trusted_overrides_may_only_lower_the_fixed_checkout_envelope(
    changes: dict[str, int | float],
) -> None:
    from dataclasses import replace

    with pytest.raises(ValueError):
        replace(Limits(), **changes)
