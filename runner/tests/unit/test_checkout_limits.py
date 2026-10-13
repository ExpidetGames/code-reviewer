# SPDX-License-Identifier: Apache-2.0
"""Exact byte envelopes and cancellation cannot reset or extend a preparation lifetime."""

import pytest

from code_reviewer_runner.dynamic_review.limits import Budget, CheckoutError, Limits


# #196-T04 #196-T12
@pytest.mark.parametrize("exposed", [False, True])
def test_exact_byte_limit_is_accepted_and_one_over_is_refused(exposed: bool) -> None:
    budget = Budget(Limits(preparation_bytes=10, exposed_bytes=10))
    budget.charge(9, exposed=exposed)
    budget.charge(1, exposed=exposed)
    with pytest.raises(CheckoutError):
        budget.charge(1, exposed=exposed)


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
