# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a call costs, from its usage and a price book (#551).

The runner reads the price book in the form the app writes it (`app/src/model-prices/`, #549):
whole micro-USD per million tokens, tiers, reasoning, the two cache write lifetimes. The cost is
exact (no float anywhere), a call that needs a price the book lacks has no cost, and every table row
below is priced a second time by an independent calculator (`usage_calc.py`).
"""

import json
import sys
from collections.abc import Sequence
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from code_reviewer_runner.dynamic_review.budget import UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.price_book import (
    PriceBook,
    parse_price_book,
)
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost, price_call
from code_reviewer_runner.dynamic_review.passthrough.usage import CallUsage
from usage_calc import expected_cost

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "fakes/fixtures/price-books.json").read_text()
)


def level(
    inp: int,
    out: int,
    read: int | None = None,
    w5: int | None = None,
    w1: int | None = None,
    reasoning: int | None = None,
) -> dict[str, Any]:
    def text(value: int | None) -> str | None:
        return None if value is None else str(value)

    return {
        "input": str(inp),
        "output": str(out),
        "cacheRead": text(read),
        "cacheWrite5m": text(w5),
        "cacheWrite1h": text(w1),
        "reasoning": text(reasoning),
        "inputAudio": None,
        "outputAudio": None,
    }


def book(
    base: dict[str, Any],
    *,
    over_200k: dict[str, Any] | None = None,
    tiers: Sequence[tuple[int, dict[str, Any]]] = (),
) -> dict[str, Any]:
    return {
        **base,
        "contextOver200k": over_200k,
        "tiers": [{"contextOver": size, **tier} for size, tier in tiers],
    }


BASE = level(3_000_000, 15_000_000, 300_000, 3_750_000, 6_000_000)
FLAT = book(BASE)
OVER_200K = book(BASE, over_200k=level(6_000_000, 22_500_000, 600_000, 7_500_000))
TIERS = book(
    level(1_000_000, 4_000_000, 100_000, 1_250_000, 2_000_000),
    tiers=[
        (128_000, level(2_000_000, 8_000_000, 200_000, 2_500_000)),
        (256_000, level(4_000_000, 16_000_000, 400_000, 5_000_000, 8_000_000)),
    ],
)
REASONING = book(level(3_000_000, 15_000_000, 300_000, 3_750_000, 6_000_000, 20_000_000))
NO_CACHE = book(level(3_000_000, 15_000_000))
NO_WRITE = book(level(3_000_000, 15_000_000, 300_000))
FREE = book(level(0, 0))
FINE = book(level(1, 3))
AMBIGUOUS = book(
    BASE,
    over_200k=level(6_000_000, 22_500_000),
    tiers=[(200_000, level(7_000_000, 22_500_000))],
)
SAME_TWICE = book(
    BASE,
    over_200k=level(6_000_000, 22_500_000),
    tiers=[(200_000, level(6_000_000, 22_500_000))],
)

# (name, book, usage). The usage is what the parsers hand over: the prompt counts the cache.
CASES: list[tuple[str, dict[str, Any], dict[str, int]]] = [
    ("flat, plain input and output", FLAT, {"prompt": 1000, "completion": 20}),
    ("flat, a cache read", FLAT, {"prompt": 1000, "completion": 20, "read": 300}),
    ("flat, a 5-minute write", FLAT, {"prompt": 1000, "completion": 20, "write_5m": 100}),
    ("flat, a 1-hour write", FLAT, {"prompt": 1000, "completion": 20, "write_1h": 100}),
    (
        "flat, read and both writes",
        FLAT,
        {"prompt": 1000, "completion": 20, "read": 300, "write_5m": 50, "write_1h": 8},
    ),
    (
        "flat, reasoning at the output price",
        FLAT,
        {"prompt": 1000, "completion": 50, "reasoning": 30},
    ),
    (
        "a reasoning price",
        REASONING,
        {"prompt": 1000, "completion": 50, "reasoning": 30},
    ),
    ("a reasoning price, none used", REASONING, {"prompt": 1000, "completion": 50}),
    ("everything is reasoning", REASONING, {"prompt": 10, "completion": 50, "reasoning": 50}),
    (
        "a cache read without a read price is input",
        NO_CACHE,
        {"prompt": 1000, "completion": 20, "read": 300},
    ),
    ("no write price, no write", NO_WRITE, {"prompt": 1000, "completion": 20, "read": 300}),
    (
        "no write price, a write: no cost",
        NO_WRITE,
        {"prompt": 1000, "completion": 20, "write_5m": 5},
    ),
    (
        "no 1-hour price, a 1-hour write: no cost",
        book(level(1, 2, 1, 1)),
        {"prompt": 100, "completion": 1, "write_1h": 5},
    ),
    ("a free model", FREE, {"prompt": 1000, "completion": 20, "read": 300}),
    ("the finest prices", FINE, {"prompt": 7, "completion": 3}),
    ("a million of everything", FLAT, {"prompt": 10**9, "completion": 10**8, "read": 5 * 10**8}),
    ("nothing used", FLAT, {"prompt": 0, "completion": 0}),
    (
        "200k: at the size is not above it",
        OVER_200K,
        {"prompt": 200_000, "completion": 20, "read": 100},
    ),
    ("200k: one above is the tier", OVER_200K, {"prompt": 200_001, "completion": 20, "read": 100}),
    (
        "200k: the tier has no 1-hour price",
        OVER_200K,
        {"prompt": 250_000, "completion": 20, "write_1h": 10},
    ),
    (
        "200k: the tier prices its own writes",
        OVER_200K,
        {"prompt": 250_000, "completion": 20, "write_5m": 10},
    ),
    ("tiers: below the first", TIERS, {"prompt": 128_000, "completion": 20}),
    ("tiers: the first", TIERS, {"prompt": 128_001, "completion": 20, "read": 1000}),
    ("tiers: between", TIERS, {"prompt": 256_000, "completion": 20}),
    ("tiers: the second", TIERS, {"prompt": 256_001, "completion": 20, "write_1h": 1}),
    (
        "tiers: the first has no 1-hour price",
        TIERS,
        {"prompt": 200_000, "completion": 20, "write_1h": 1},
    ),
    ("tiers: far above", TIERS, {"prompt": 900_000, "completion": 20, "reasoning": 5}),
    (
        "a tier at 200000 that equals the older one",
        SAME_TWICE,
        {"prompt": 300_000, "completion": 20},
    ),
    (
        "a tier at 200000 that differs from the older one: no cost",
        AMBIGUOUS,
        {"prompt": 300_000, "completion": 20},
    ),
    ("a tier at 200000 that differs, below it", AMBIGUOUS, {"prompt": 100_000, "completion": 20}),
]


def usage_of(counts: dict[str, int]) -> CallUsage:
    return CallUsage(
        prompt_tokens=counts["prompt"],
        completion_tokens=counts["completion"],
        cache_read=counts.get("read", 0),
        cache_write_5m=counts.get("write_5m", 0),
        cache_write_1h=counts.get("write_1h", 0),
        reasoning_tokens=counts.get("reasoning", 0),
    )


def parsed(document: dict[str, Any]) -> PriceBook:
    result = parse_price_book(document)
    assert result is not None
    return result


# #551-T08
@pytest.mark.parametrize(("name", "document", "counts"), CASES, ids=[c[0] for c in CASES])
def test_every_price_shape_prices_a_usage_like_the_independent_calculator(
    name: str, document: dict[str, Any], counts: dict[str, int]
) -> None:
    expected = expected_cost(
        document,
        prompt=counts["prompt"],
        completion=counts["completion"],
        read=counts.get("read", 0),
        write_5m=counts.get("write_5m", 0),
        write_1h=counts.get("write_1h", 0),
        reasoning=counts.get("reasoning", 0),
    )
    cost = call_cost(usage_of(counts), parsed(document))
    if expected is None:
        assert cost is None
        return
    assert cost is not None
    assert isinstance(cost, Decimal)
    # Exactly equal as rational numbers: no float and no rounding took part.
    assert Fraction(cost) == expected


# #551-T08
def test_the_dearer_tier_changes_the_cost_only_above_its_size() -> None:
    below = call_cost(CallUsage(200_000, 0), parsed(OVER_200K))
    above = call_cost(CallUsage(200_001, 0), parsed(OVER_200K))
    assert below == Decimal("0.6")
    assert above is not None and above == Decimal("1.200006")


# #551-T08
def test_reasoning_tokens_cost_the_reasoning_price_and_otherwise_the_output_price() -> None:
    usage = CallUsage(100, 50, reasoning_tokens=30)
    # 100 in at 3, 20 out at 15, 30 reasoning at 20: (300 + 300 + 600) / 1e6
    assert call_cost(usage, parsed(REASONING)) == Decimal("0.0012")
    # No reasoning price: all 50 at the output price: (300 + 750) / 1e6
    assert call_cost(usage, parsed(FLAT)) == Decimal("0.00105")


# #551-T08
def test_a_cost_is_an_exact_decimal_and_not_a_float() -> None:
    cost = call_cost(CallUsage(7, 3), parsed(FINE))
    assert cost == Decimal("0.000000000016")
    assert isinstance(cost, Decimal)


# #551-T08
@pytest.mark.parametrize(
    "usage",
    [
        CallUsage(100, 10, cache_read=101),
        CallUsage(100, 10, cache_read=60, cache_write_5m=50),
        CallUsage(100, 10, cache_write_1h=101),
        CallUsage(100, 10, reasoning_tokens=11),
        CallUsage(100, 10, unknown_fields=("usage.x",)),
        CallUsage(100, 10, complete=False),
    ],
)
def test_counts_that_cannot_be_true_or_a_usage_that_is_not_whole_have_no_cost(
    usage: CallUsage,
) -> None:
    assert call_cost(usage, parsed(FLAT)) is None


# #551-T08
def test_the_prices_of_a_job_without_a_book_are_read_as_one_and_priced_the_same() -> None:
    prices = UnitCosts(
        input_usd_per_mtok=Decimal(3),
        output_usd_per_mtok=Decimal(15),
        cache_read_usd_per_mtok=Decimal("0.3"),
        cache_write_usd_per_mtok=Decimal("3.75"),
        cache_write_1h_usd_per_mtok=Decimal(6),
    )
    usage = CallUsage(1000, 20, cache_read=300, cache_write_5m=100, cache_write_1h=8)
    assert call_cost(usage, prices) == call_cost(usage, parsed(FLAT))
    # 592 fresh * 3 + 300 * 0.3 + 100 * 3.75 + 8 * 6 + 20 * 15, per million tokens.
    assert call_cost(usage, prices) == Decimal("0.002589")


# #551-T08
def test_a_price_finer_than_a_micro_usd_is_rounded_up_never_down() -> None:
    prices = UnitCosts(input_usd_per_mtok=Decimal("0.0000001"), output_usd_per_mtok=Decimal(1))
    cost = call_cost(CallUsage(1_000_000, 0), prices)
    assert cost is not None and cost == Decimal("0.000001")


# #551-T08
def test_a_job_price_for_one_write_lifetime_leaves_the_other_without_a_price() -> None:
    prices = UnitCosts(
        input_usd_per_mtok=Decimal(3),
        output_usd_per_mtok=Decimal(15),
        cache_write_usd_per_mtok=Decimal("3.75"),
    )
    assert call_cost(CallUsage(100, 1, cache_write_5m=5), prices) is not None
    assert call_cost(CallUsage(100, 1, cache_write_1h=5), prices) is None


# -- the price book reader -----------------------------------------------------------------------


# #551-T08
@pytest.mark.parametrize("entry", FIXTURE["valid"], ids=[e["name"] for e in FIXTURE["valid"]])
def test_the_runner_reads_every_book_the_app_accepts(entry: dict[str, Any]) -> None:
    assert parse_price_book(entry["book"]) is not None


# #551-T08
@pytest.mark.parametrize("entry", FIXTURE["invalid"], ids=[e["name"] for e in FIXTURE["invalid"]])
def test_the_runner_refuses_every_book_the_app_refuses(entry: dict[str, Any]) -> None:
    assert parse_price_book(entry["book"]) is None


# #551-T08
def test_a_book_is_read_into_whole_micro_usd_and_null_stays_null() -> None:
    read = parsed(book(level(3_000_000, 15_000_000, 300_000)))
    assert read.base.input == 3_000_000 and isinstance(read.base.input, int)
    assert read.base.cache_read == 300_000
    assert read.base.cache_write_5m is None and read.base.reasoning is None
    assert read.tiers == () and read.over_200k is None
    free = parsed(FREE)
    assert free.base.input == 0 and free.base.output == 0


# -- T09: the charge the provider states ---------------------------------------------------------

# 100 in at 3 and 10 out at 15 is 450 micro-USD.
PLAIN = parsed(book(level(3_000_000, 15_000_000)))


def stated(cost: str, *, cache_write_5m: int = 0) -> CallUsage:
    return CallUsage(100, 10, cache_write_5m=cache_write_5m, stated_cost=Decimal(cost))


# #551-T09
def test_a_charge_the_provider_states_is_the_cost_and_is_never_recomputed() -> None:
    priced = price_call(stated("0.00045"), PLAIN)
    assert priced.cost == Decimal("0.00045") and not priced.drift
    # Within the tolerance of the book: the stated charge is still the cost.
    priced = price_call(stated("0.000452"), PLAIN)
    assert priced.cost == Decimal("0.000452") and not priced.drift


# #551-T09
# #551-R569-S4
@pytest.mark.parametrize("figure", ["0.0012", "0.002", "0.46"])
def test_a_stated_charge_above_the_book_is_the_cost_and_is_counted_as_drift(figure: str) -> None:
    priced = price_call(stated(figure), PLAIN)
    assert priced.cost == Decimal(figure)
    assert priced.drift


# #551-R569-S4
@pytest.mark.parametrize("figure", ["0.0003", "0.0001", "0.000045"])
def test_a_stated_charge_below_the_book_by_at_most_ten_times_books_what_the_book_says(
    figure: str,
) -> None:
    # The book says 0.00045: the dearer of the two is booked, never less than the book expects.
    priced = price_call(stated(figure), PLAIN)
    assert priced.cost == Decimal("0.00045")
    assert priced.drift


# #551-R569-S4
def test_a_stated_charge_a_little_below_the_book_is_no_drift_and_books_the_book() -> None:
    priced = price_call(stated("0.000448"), PLAIN)
    assert priced.cost == Decimal("0.00045") and not priced.drift


# #551-R569-S4
@pytest.mark.parametrize(
    "figure",
    ["0", "0.000044999", "0.00001", "0.000000000001", "1e-300", "1E-1000", "0.0000000000000001"],
)
def test_a_stated_charge_more_than_ten_times_below_the_book_is_unknown(figure: str) -> None:
    # Tiny but not zero is as little to believe as zero: the call has no cost, the run books its
    # worst case.
    assert price_call(stated(figure), PLAIN).cost is None


# #551-R569-S4
def test_a_model_the_book_prices_at_zero_may_state_zero_and_must_not_state_more_for_free() -> None:
    free = price_call(stated("0"), parsed(FREE))
    assert free.cost == Decimal(0) and not free.drift
    dear = price_call(stated("0.5"), parsed(FREE))
    assert dear.cost == Decimal("0.5") and dear.drift


# #551-R569-S3
# #551-R569-S4
def test_a_stated_charge_does_not_make_a_call_the_book_cannot_price_known() -> None:
    # Nothing to hold it against (no ten-times check is possible): the call is unknown.
    priced = price_call(stated("0.0003", cache_write_5m=5), parsed(NO_WRITE))
    assert priced.cost is None


# #551-T09
def test_a_charge_the_provider_states_does_not_hide_a_usage_that_is_unknown() -> None:
    usage = CallUsage(100, 10, stated_cost=Decimal("0.0003"), unknown_fields=("usage.x",))
    assert price_call(usage, PLAIN).cost is None


# #551-T09
def test_a_call_without_a_stated_charge_never_counts_as_drift() -> None:
    assert not price_call(CallUsage(100, 10), PLAIN).drift


# -- T12: a cache makes a call cheaper -----------------------------------------------------------


# #551-T12
@pytest.mark.parametrize("document", [FLAT, OVER_200K, TIERS, REASONING])
def test_a_call_that_reads_the_earlier_prefix_costs_less_than_the_same_call_without_a_cache(
    document: dict[str, Any],
) -> None:
    plain = call_cost(CallUsage(5000, 100), parsed(document))
    cached = call_cost(CallUsage(5000, 100, cache_read=4000), parsed(document))
    assert plain is not None and cached is not None
    assert cached < plain
    # Writing the prefix costs more than not caching it, and it pays back on the next read.
    written = call_cost(CallUsage(5000, 100, cache_write_5m=4000), parsed(document))
    assert written is not None and written > plain
    assert written + cached < 2 * plain
