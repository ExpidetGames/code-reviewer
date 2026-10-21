# SPDX-License-Identifier: Apache-2.0

"""The price book of a model, as the runner reads it (#551, the form of #549).

The app holds the confirmed price of a managed model as a price book
(`app/src/model-prices/price-book.ts`) and hands it on as JSON: every amount is a decimal string of
**whole micro-USD per million tokens** (USD 2.50 per million tokens is `"2500000"`), `null` is "not
priced" and never zero, and the older `context_over_200k` tier and a list of tiers (each for a
prompt above its size) sit beside the base level. This module reads that JSON exactly as strictly
as the app does (`parsePriceBookJson`; both read `fakes/fixtures/price-books.json` in their tests)
into integers, so that no float ever takes part in a price: a book that is not exactly a book is
None.

`book_from_unit_costs` turns the per-job prices of the legacy descriptor (`UnitCosts`, USD per
million tokens as `Decimal`) into a book until the claim carries the confirmed one (#553); a price
finer than a micro-USD is rounded **up**, never down.
"""

import re
from dataclasses import dataclass
from decimal import ROUND_CEILING, Context, Decimal
from enum import StrEnum
from typing import Any, Final

from code_reviewer_runner.dynamic_review.budget import UnitCosts

# Counts times micro-USD per million tokens: a whole number of 10^-12 USD, exactly.
_EXACT: Final = Context(prec=100)

# The bounds of the app's schema: whole micro-USD in at most 12 digits and at most USD 100,000 per
# million tokens; at most 64 tiers; a tier above at least one token and below 100 million.
MAX_MICRO_USD_PER_MTOK: Final = 100_000 * 1_000_000
MAX_TIERS: Final = 64
MAX_CONTEXT_OVER: Final = 100_000_000
# The older `context_over_200k` of models.dev is the tier of this size.
OVER_200K_SIZE: Final = 200_000
_AMOUNT: Final = re.compile(r"(0|[1-9][0-9]{0,11})")
_LEVEL_KEYS: Final = (
    "input",
    "output",
    "cacheRead",
    "cacheWrite5m",
    "cacheWrite1h",
    "reasoning",
    "inputAudio",
    "outputAudio",
)


class PriceBookErrorCode(StrEnum):
    """Why prices could not be made a price book; callers branch on the code, never on the text."""

    UNIT_COSTS_INVALID = "unit_costs_invalid"


class PriceBookError(Exception):
    def __init__(self, code: PriceBookErrorCode, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code


@dataclass(frozen=True)
class PriceLevel:
    """The prices of one level, micro-USD per million tokens; None is "not priced"."""

    input: int
    output: int
    cache_read: int | None = None
    cache_write_5m: int | None = None
    cache_write_1h: int | None = None
    reasoning: int | None = None


@dataclass(frozen=True)
class PriceTier:
    """A level that applies to a prompt above `context_over` tokens."""

    context_over: int
    level: PriceLevel


@dataclass(frozen=True)
class PriceBook:
    base: PriceLevel
    # The older tier of 200,000 tokens, as stated.
    over_200k: PriceLevel | None = None
    # From the smallest size up.
    tiers: tuple[PriceTier, ...] = ()
    # The book of a claim (#553): a cache read the level states no price for is not priced as input
    # (the descriptor of a legacy job still is), the call has no cost.
    strict_cache_read: bool = False

    def level_for(self, prompt_tokens: int) -> PriceLevel | None:
        """The level that prices a prompt of this size, or None when two of one size disagree.

        A tier applies to a prompt strictly above its size and the largest size the prompt exceeds
        wins; below every size the base level applies. The older tier of 200,000 tokens counts as a
        tier of that size, and a tier of the same size that states another price makes the book
        ambiguous for such a prompt: no guess.
        """
        sized = [(tier.context_over, tier.level) for tier in self.tiers]
        if self.over_200k is not None:
            sized.append((OVER_200K_SIZE, self.over_200k))
        exceeded = [entry for entry in sized if prompt_tokens > entry[0]]
        if not exceeded:
            return self.base
        largest = max(size for size, _ in exceeded)
        levels = {level for size, level in exceeded if size == largest}
        return next(iter(levels)) if len(levels) == 1 else None

    def worst_case(self, prompt_tokens: int, completion_tokens: int) -> Decimal:
        """The most a call of at most `prompt_tokens` of prompt and `completion_tokens` of output
        can cost at these prices, in USD, exactly (review of PR #569, N8).

        Each token is priced at the dearest kind there is: a prompt token as plain input, a cache
        read or either cache write; an output token as output or reasoning. A prompt may be any size
        up to `prompt_tokens`, so every level it can reach counts: the base, and each tier its size
        can exceed (a tier may be cheaper than the level below it, then the base is the dearer).
        """
        levels = [self.base]
        levels += [tier.level for tier in self.tiers if prompt_tokens > tier.context_over]
        if self.over_200k is not None and prompt_tokens > OVER_200K_SIZE:
            levels.append(self.over_200k)
        pico = max(_worst_pico(level, prompt_tokens, completion_tokens) for level in levels)
        return _EXACT.scaleb(Decimal(pico), -12)


def _dearest(*prices: int | None) -> int:
    return max((price for price in prices if price is not None), default=0)


def _worst_pico(level: PriceLevel, prompt_tokens: int, completion_tokens: int) -> int:
    # Every prompt token at the dearest kind of input there is (plain, a cache read, either write),
    # every output token at the output or the reasoning price, whichever is dearer.
    dearest_in = _dearest(level.input, level.cache_read, level.cache_write_5m, level.cache_write_1h)
    dearest_out = _dearest(level.output, level.reasoning)
    return prompt_tokens * dearest_in + completion_tokens * dearest_out


def _amount(value: Any, *, required: bool) -> tuple[bool, int | None]:
    """Whether `value` is an acceptable amount, and what it is: a decimal string of whole micro-USD
    as an int, or None for a `null` that is allowed."""
    if value is None:
        return (not required), None
    if not isinstance(value, str) or _AMOUNT.fullmatch(value) is None:
        return False, None
    amount = int(value)
    return amount <= MAX_MICRO_USD_PER_MTOK, amount


def _level(value: Any) -> PriceLevel | None:
    if not isinstance(value, dict):
        return None
    given: dict[str, Any] = value  # pyright: ignore[reportUnknownVariableType]
    return _read_level(given, extra=())


def _read_level(value: dict[str, Any], *, extra: tuple[str, ...]) -> PriceLevel | None:
    if any(key not in _LEVEL_KEYS and key not in extra for key in value):
        return None
    read: dict[str, int | None] = {}
    for key in _LEVEL_KEYS:
        ok, amount = _amount(value.get(key), required=key in ("input", "output"))
        if not ok:
            return None
        read[key] = amount
    # The audio prices are read, validated and not used: audio is a charge the ledger does not price
    # (a call with audio tokens is unknown), whatever the book says about it.
    inp, out = read["input"], read["output"]
    if inp is None or out is None:
        return None  # not reachable (both are required above); a book that lacks one is no book
    return PriceLevel(
        input=inp,
        output=out,
        cache_read=read["cacheRead"],
        cache_write_5m=read["cacheWrite5m"],
        cache_write_1h=read["cacheWrite1h"],
        reasoning=read["reasoning"],
    )


def _tier(value: Any) -> PriceTier | None:
    if not isinstance(value, dict):
        return None
    given: dict[str, Any] = value  # pyright: ignore[reportUnknownVariableType]
    size = given.get("contextOver")
    if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_CONTEXT_OVER:
        return None
    level = _read_level({k: v for k, v in given.items() if k != "contextOver"}, extra=())
    return None if level is None else PriceTier(size, level)


def parse_price_book(document: object, *, strict_cache_read: bool = False) -> PriceBook | None:
    """The price book of this JSON (the form of `priceBookToJson`), or None when it is not exactly
    one: an unknown key, an amount that is not whole micro-USD digits, a missing input or output
    price, a tier that is not above the one before it. `strict_cache_read` is set for the book of a
    claim (#553)."""
    if not isinstance(document, dict):
        return None
    given: dict[str, Any] = document  # pyright: ignore[reportUnknownVariableType]
    base = _read_level(given, extra=("contextOver200k", "tiers"))
    if base is None:
        return None
    over_200k: PriceLevel | None = None
    if given.get("contextOver200k") is not None:
        over_200k = _level(given["contextOver200k"])
        if over_200k is None:
            return None
    listed: Any = given.get("tiers", [])
    if not isinstance(listed, list) or len(listed) > MAX_TIERS:  # pyright: ignore[reportUnknownArgumentType]
        return None
    tiers: list[PriceTier] = []
    for entry in listed:  # pyright: ignore[reportUnknownVariableType]
        tier = _tier(entry)
        if tier is None or (tiers and tier.context_over <= tiers[-1].context_over):
            return None
        tiers.append(tier)
    return PriceBook(
        base=base, over_200k=over_200k, tiers=tuple(tiers), strict_cache_read=strict_cache_read
    )


def _micro_usd(usd_per_mtok: Decimal | None, name: str) -> int | None:
    """Whole micro-USD per million tokens, rounded up; None for no price."""
    if usd_per_mtok is None:
        return None
    if not usd_per_mtok.is_finite() or usd_per_mtok < 0:
        raise PriceBookError(PriceBookErrorCode.UNIT_COSTS_INVALID, f"{name} is not a price")
    micro = int((usd_per_mtok * 1_000_000).to_integral_value(rounding=ROUND_CEILING))
    if micro > MAX_MICRO_USD_PER_MTOK:
        raise PriceBookError(PriceBookErrorCode.UNIT_COSTS_INVALID, f"{name} is above any price")
    return micro


def book_from_unit_costs(prices: UnitCosts) -> PriceBook:
    """The price book of a job's per-model prices: one level, no tiers. The legacy descriptor has
    one cache write price, the 5-minute one the runner's requests use; the 1-hour price is its own
    field and stays unpriced without it. A price that is no price (not finite, below zero, above
    what a book holds) is a `PriceBookError`."""
    inp = _micro_usd(prices.input_usd_per_mtok, "input")
    out = _micro_usd(prices.output_usd_per_mtok, "output")
    if inp is None or out is None:
        raise PriceBookError(PriceBookErrorCode.UNIT_COSTS_INVALID, "input or output has no price")
    return PriceBook(
        base=PriceLevel(
            input=inp,
            output=out,
            cache_read=_micro_usd(prices.cache_read_usd_per_mtok, "cache read"),
            cache_write_5m=_micro_usd(prices.cache_write_usd_per_mtok, "cache write"),
            cache_write_1h=_micro_usd(prices.cache_write_1h_usd_per_mtok, "cache write 1h"),
        )
    )
