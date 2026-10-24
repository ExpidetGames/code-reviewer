# SPDX-License-Identifier: LicenseRef-Proprietary

"""What one call used, in the runner's counts (#551): the same typed value for every family.

`prompt_tokens` is the whole prompt including what came from or went to the provider's cache;
`completion_tokens` is everything billed as output, a thinking model's thoughts included, and
`reasoning_tokens` says how many of those were reasoning (so that a reasoning price can apply).
The two cache write lifetimes are apart because they cost differently. Nothing here is ever a guess:
a count the provider did not state in a field it must state is not a `CallUsage` at all, and what it
stated that the parser cannot price is in `unknown_fields` (the names of the fields, never a value).
"""

from dataclasses import dataclass, field
from decimal import Decimal


@dataclass(frozen=True)
class CallUsage:
    prompt_tokens: int
    completion_tokens: int
    cache_read: int = 0
    cache_write_5m: int = 0
    cache_write_1h: int = 0
    reasoning_tokens: int = 0
    # The charge the provider states for the call (OpenRouter's `usage.cost`), if it does.
    stated_cost: Decimal | None = None
    # The total the provider states (`total_tokens`, `totalTokenCount`), if it does. It can be above
    # the sum of the counts (reasoning on top, a part the parser does not model): the token cap of
    # an own key (#553) books the larger. Not part of equality: it is a fact about the statement,
    # not about what the call used.
    stated_total: int | None = field(default=None, compare=False)
    # Fields of the usage that hold something the parser does not know how to price (or a value it
    # cannot trust, or a split that disagrees with its total): the call's cost is unknown.
    unknown_fields: tuple[str, ...] = ()
    # The answer reached its end and stated its usage there: false for a stream that was cut,
    # failed, or stopped before the usage event. A usage that is not complete is never a usage to
    # settle with.
    complete: bool = True

    @property
    def cache_write(self) -> int:
        return self.cache_write_5m + self.cache_write_1h
