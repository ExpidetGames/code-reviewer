# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a call cost, from its usage and a price book (#550, #551).

The prices are a price book (`price_book.py`, the form of #549: whole micro-USD per million tokens,
a reasoning price, the two cache write lifetimes, tiers by prompt size) or, until the claim carries
the confirmed book (#553), the per-job `UnitCosts` read as a one-level book. The cost is exact
integer arithmetic: every count times a price in micro-USD per million tokens is a whole number of
10^-12 USD, so the USD amount is an exact `Decimal`, never a float and never rounded.

A call that cannot be priced exactly has no cost (None), which stops the run: it is never read as
zero and never priced lower than it may have been. That is a usage with fields nobody could price
(`unknown_fields`), one that is not `complete`, counts that cannot be true (a cache above the
prompt, reasoning above the completion), a cache write whose lifetime the level has no price for,
and a prompt whose size two tiers of one size price differently.

- A **tier** applies to a prompt strictly above its size (`PriceBook.level_for`), with that
  level's own prices: a price the tier leaves out is not the base price.
- **Reasoning** tokens are part of the completion and cost the level's reasoning price, or its
  output price when it states none.
- A **cache read** without a read price costs the input price (never less than it is), except in the
  book of a claim (`strict_cache_read`, #553), where the call has no cost; a **cache write**
  without a price of its kind has no cost.
- A **call the book cannot price** has no cost (None), whether the provider states a charge or not:
  the proxy books its worst case and counts it as unknown (review of PR #569, S3).
- A **charge the provider states** (OpenRouter's `usage.cost`) is held against what the book
  expects for the same call, and the dearer of the two is booked (S4). When the two differ by more
  than `DRIFT_RELATIVE` (and `DRIFT_ABSOLUTE` USD) the call is a `price_drift` (the proxy counts
  them, counts only). A stated charge more than `IMPLAUSIBLE_BELOW` (10) times below the book's
  price is not a price: zero, 1e-300 and "a little less than nothing" are all the call being
  unknown, never a cheap call. A model the book prices at zero may state zero.
"""

from dataclasses import dataclass
from decimal import Context, Decimal
from typing import Final

from code_reviewer_runner.dynamic_review.budget import UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.call_usage import CallUsage
from code_reviewer_runner.dynamic_review.passthrough.price_book import (
    PriceBook,
    PriceLevel,
    book_from_unit_costs,
)

# Counts times micro-USD per million tokens: a whole number of 10^-12 USD.
_PICO: Final = -12
_EXACT: Final = Context(prec=100)
# A stated charge within 1 % of the book's price, or within a micro-USD of it, is no drift. The
# tolerance is a guess until a live capture shows how far OpenRouter's charge strays (live L14).
DRIFT_RELATIVE: Final = Decimal("0.01")
DRIFT_ABSOLUTE: Final = Decimal("0.000001")
# A stated charge more than this many times below what the book expects is not believed.
IMPLAUSIBLE_BELOW: Final = Decimal(10)


@dataclass(frozen=True)
class PricedCall:
    cost: Decimal | None
    # The provider's stated charge and the book's price disagree beyond the tolerance.
    drift: bool = False


def _book_cost(usage: CallUsage, level: PriceLevel, *, strict_cache_read: bool) -> int | None:
    """The price of the call at one level in 10^-12 USD, or None when it has no price there."""
    read, w5, w1 = usage.cache_read, usage.cache_write_5m, usage.cache_write_1h
    plain_input = usage.prompt_tokens - read - w5 - w1
    plain_output = usage.completion_tokens - usage.reasoning_tokens
    if min(plain_input, plain_output) < 0:
        return None  # counts that cannot be true
    # A read without its own price is priced as input, which is never less than a read costs; the
    # book of a claim does not guess (#553): the call has no cost.
    if read and level.cache_read is None and strict_cache_read:
        return None
    total = plain_input * level.input + read * (
        level.input if level.cache_read is None else level.cache_read
    )
    for tokens, price in ((w5, level.cache_write_5m), (w1, level.cache_write_1h)):
        if tokens == 0:
            continue
        if price is None:
            return None
        total += tokens * price
    reasoning_price = level.output if level.reasoning is None else level.reasoning
    return total + plain_output * level.output + usage.reasoning_tokens * reasoning_price


def _usd(pico: int) -> Decimal:
    return _EXACT.scaleb(Decimal(pico), _PICO)


def book_price(usage: CallUsage, book: PriceBook) -> Decimal | None:
    """What the book says the call costs, whatever the provider states; None when it has no
    price."""
    if usage.unknown_fields or not usage.complete:
        return None
    level = book.level_for(usage.prompt_tokens)
    if level is None:
        return None
    pico = _book_cost(usage, level, strict_cache_read=book.strict_cache_read)
    return None if pico is None else _usd(pico)


def _drifts(stated: Decimal, expected: Decimal) -> bool:
    allowed = max(_EXACT.multiply(expected, DRIFT_RELATIVE), DRIFT_ABSOLUTE)
    return abs(_EXACT.subtract(stated, expected)) > allowed


def price_call(usage: CallUsage, prices: PriceBook | UnitCosts) -> PricedCall:
    book = prices if isinstance(prices, PriceBook) else book_from_unit_costs(prices)
    if usage.unknown_fields or not usage.complete:
        return PricedCall(None)
    expected = book_price(usage, book)
    if expected is None:
        # The book cannot price the call (no price for a kind it used, no single tier): the call is
        # unknown, a charge the provider states or not. With nothing to hold that charge against
        # there is nothing to believe it by.
        return PricedCall(None)
    stated = usage.stated_cost
    if stated is None:
        return PricedCall(expected)
    if _EXACT.multiply(stated, IMPLAUSIBLE_BELOW) < expected:
        return PricedCall(None)
    return PricedCall(max(stated, expected), drift=_drifts(stated, expected))


def call_cost(usage: CallUsage, prices: PriceBook | UnitCosts) -> Decimal | None:
    return price_call(usage, prices).cost
