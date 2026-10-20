# SPDX-License-Identifier: Apache-2.0

"""What a call cost, from its usage and the prices of the job (#550).

The prices are what the job brings (`UnitCosts`: input, output and, when it has them, the cache read
and write prices); the catalog's own prices come with #549 and #553. A charge the provider states
(OpenRouter's `usage.cost`) is the cost and is never recomputed. Otherwise the cost is exact decimal
arithmetic over the counts, and a call that cannot be priced exactly has no cost (None, which stops
the run: it is never read as zero and never priced lower than it may have been).
"""

from decimal import Context, Decimal

from code_reviewer_runner.dynamic_review.budget import UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.usage import CallUsage

_EXACT = Context(prec=100)
_MILLION = Decimal(1_000_000)


def call_cost(usage: CallUsage, prices: UnitCosts) -> Decimal | None:
    if usage.stated_cost is not None:
        return usage.stated_cost
    read, written = usage.cache_read, usage.cache_write
    if read + written > usage.prompt_tokens:
        # Counts that cannot be true are no cache signal: the whole prompt is plain input.
        read = written = 0
    if written > 0 and prices.cache_write_usd_per_mtok is None:
        return None
    # A read without its own price is priced as input, which is never less than a read costs.
    read_price = prices.cache_read_usd_per_mtok
    total = _EXACT.multiply(
        Decimal(usage.prompt_tokens - read - written), prices.input_usd_per_mtok
    )
    total = _EXACT.add(
        total,
        _EXACT.multiply(
            Decimal(read), prices.input_usd_per_mtok if read_price is None else read_price
        ),
    )
    if written > 0 and prices.cache_write_usd_per_mtok is not None:
        total = _EXACT.add(
            total, _EXACT.multiply(Decimal(written), prices.cache_write_usd_per_mtok)
        )
    total = _EXACT.add(
        total, _EXACT.multiply(Decimal(usage.completion_tokens), prices.output_usd_per_mtok)
    )
    return _EXACT.divide(total, _MILLION)
