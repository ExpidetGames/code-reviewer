# SPDX-License-Identifier: Apache-2.0

"""The cache tokens a provider reports for one call (#540), as the cost guard reads them.

Two shapes carry them. The Anthropic wire translates its counts to `cache_read_input_tokens` and
`cache_creation_input_tokens` at the top of the usage (`anthropic_wire.py`); the chat protocol,
OpenRouter among the providers that speak it, reports `prompt_tokens_details.cached_tokens` and,
for some providers, `cache_write_tokens`. A provider that reports neither has no cache signal and
its calls are priced as plain input: absence is never read as a cache hit or as zero reads that
were reported.

Only a whole, non-negative number is a count. Anything else (a boolean, a string, a float, a
negative number) is no count (`None`). Whether the counts fit the prompt is for the ledger to say.
"""

from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object


def _count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def cache_tokens(usage: Mapping[str, Any]) -> tuple[int | None, int | None]:
    """The tokens of the prompt read from and written to the provider's cache, each `None` when the
    provider did not report a usable count. The provider's own names win over the details."""
    details = as_object(usage.get("prompt_tokens_details")) or {}
    read = _count(usage.get("cache_read_input_tokens"))
    if read is None:
        read = _count(details.get("cached_tokens"))
    written = _count(usage.get("cache_creation_input_tokens"))
    if written is None:
        written = _count(details.get("cache_write_tokens"))
    return read, written
