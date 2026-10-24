# SPDX-License-Identifier: LicenseRef-Proprietary

"""The price book a job's unit costs make (#551, N2 of the review of PR #569).

The per-job prices of the legacy descriptor are read as a one-level book until the claim carries the
confirmed one (#553). A price that is no price (not a number, below zero, above what a book holds)
is a stable error, never an `assert` that `python -O` removes and never a negative price.
"""

from decimal import Decimal

import pytest

from code_reviewer_runner.dynamic_review.budget import UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.price_book import (
    PriceBookError,
    PriceBookErrorCode,
    book_from_unit_costs,
)


def _unit_costs(**overrides: Decimal) -> UnitCosts:
    prices: dict[str, Decimal] = {
        "input_usd_per_mtok": Decimal(3),
        "output_usd_per_mtok": Decimal(15),
    }
    prices.update(overrides)
    return UnitCosts(**prices)  # type: ignore[arg-type]


# #551-R569-N2
@pytest.mark.parametrize(
    "overrides",
    [
        {"input_usd_per_mtok": Decimal("NaN")},
        {"output_usd_per_mtok": Decimal("Infinity")},
        {"input_usd_per_mtok": Decimal(-1)},
        {"output_usd_per_mtok": Decimal("-0.000001")},
        {"cache_read_usd_per_mtok": Decimal(-3)},
        {"cache_write_usd_per_mtok": Decimal("NaN")},
        {"cache_write_1h_usd_per_mtok": Decimal(-6)},
        {"input_usd_per_mtok": Decimal(100_001)},
    ],
)
def test_unit_costs_that_are_no_prices_make_no_book_and_fail_with_a_stable_code(
    overrides: dict[str, Decimal],
) -> None:
    with pytest.raises(PriceBookError) as raised:
        book_from_unit_costs(_unit_costs(**overrides))
    assert raised.value.code is PriceBookErrorCode.UNIT_COSTS_INVALID


# #551-R569-N2
def test_unit_costs_at_the_edges_of_what_a_book_holds_are_a_book() -> None:
    built = book_from_unit_costs(
        _unit_costs(input_usd_per_mtok=Decimal(0), output_usd_per_mtok=Decimal(100_000))
    )
    assert built.base.input == 0 and built.base.output == 100_000 * 1_000_000
