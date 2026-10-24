# SPDX-License-Identifier: LicenseRef-Proprietary

"""An independent calculator for the price of a call (#551). Not a test file.

It prices a canned usage from a price book in the JSON form of the app (`priceBookToJson` in
`app/src/model-prices/price-book.ts`: amounts are decimal strings of whole micro-USD per million
tokens) with `Fraction`, written from the rules of the price book README and not from the
implementation under test: the table-driven tests compare the two. The rules:

- a tier applies to a prompt strictly above its `contextOver`; the dearest size that the prompt
  exceeds wins; the older `context_over_200k` is the tier of 200,000;
- a level states its own prices: a tier does not inherit a price it leaves out;
- reasoning tokens are part of the completion; they cost the `reasoning` price of the level, or its
  `output` price when it states none;
- a cache read is priced at `cacheRead`, or as input when the level has none (never cheaper than it
  is); a cache write with no price of its kind is not priced at all (None).
"""

from fractions import Fraction
from typing import Any

MICRO = 10**6


def _usd(level: dict[str, Any], name: str) -> Fraction | None:
    text = level.get(name)
    return None if text is None else Fraction(int(text), MICRO)


def level_for(book: dict[str, Any], prompt: int) -> dict[str, Any] | None:
    tiers: list[tuple[int, dict[str, Any]]] = [
        (tier["contextOver"], tier) for tier in book.get("tiers", [])
    ]
    if book.get("contextOver200k") is not None:
        tiers.append((200_000, book["contextOver200k"]))
    exceeded = sorted((t for t in tiers if prompt > t[0]), key=lambda t: t[0], reverse=True)
    if not exceeded:
        return book
    same = [
        {k: v for k, v in level.items() if k != "contextOver"}
        for size, level in exceeded
        if size == exceeded[0][0]
    ]
    if any(level != same[0] for level in same):
        return None
    return same[0]


def expected_cost(
    book: dict[str, Any],
    *,
    prompt: int,
    completion: int,
    read: int = 0,
    write_5m: int = 0,
    write_1h: int = 0,
    reasoning: int = 0,
) -> Fraction | None:
    """USD, exactly, or None when the call cannot be priced from the book."""
    level = level_for(book, prompt)
    if level is None:
        return None
    price_in, price_out = _usd(level, "input"), _usd(level, "output")
    assert price_in is not None and price_out is not None
    price_read = _usd(level, "cacheRead")
    if price_read is None:
        price_read = price_in
    price_reasoning = _usd(level, "reasoning")
    if price_reasoning is None:
        price_reasoning = price_out
    total = (prompt - read - write_5m - write_1h) * price_in
    total += read * price_read
    for tokens, name in ((write_5m, "cacheWrite5m"), (write_1h, "cacheWrite1h")):
        if tokens == 0:
            continue
        price = _usd(level, name)
        if price is None:
            return None
        total += tokens * price
    total += (completion - reasoning) * price_out + reasoning * price_reasoning
    return total / MICRO
