# SPDX-License-Identifier: Apache-2.0

"""How much of the input of a job was read from the provider's prompt cache (#539).

Caching is on wherever the provider has it, and what it saves is invisible in the total: a cost is
one number. So every job counts, call by call, the input tokens it read from the cache, the ones it
wrote to it and the ones it paid in full, and logs one line of counts at the end (the Dynamic proxy
and the Diff meter each keep a `CacheTally`). Counts only: no text of a prompt, an answer or a
key, and no price (the cost of a call is the provider's charge or the exact price of its usage,
`anthropic_cost.py`, and this module never touches it).

A usage is read in the shapes the runner sees. After the Anthropic wire, and as LiteLLM reports
Anthropic, it has `cache_read_input_tokens` and `cache_creation_input_tokens` and `prompt_tokens`
holds all three kinds. An OpenAI-shaped answer (OpenRouter) says
`prompt_tokens_details.cached_tokens` and `cache_write_tokens` (LiteLLM's own object says
`cache_creation_tokens`). A count that is not a non-negative integer, or counts that exceed the
prompt, are not trusted: the call is counted as paid in full, never as cheaper than it may have
been.
"""

import threading
from typing import NamedTuple

from code_reviewer_runner.usage_access import usage_field

_READ_NAMES = ("cache_read_input_tokens",)
_WRITE_NAMES = ("cache_creation_input_tokens",)
_DETAIL_READ_NAMES = ("cached_tokens",)
_DETAIL_WRITE_NAMES = ("cache_write_tokens", "cache_creation_tokens")


class Counts(NamedTuple):
    """The input of one call, or of a job: tokens read from the cache, written to it, not cached."""

    read: int
    written: int
    uncached: int


class Tally(NamedTuple):
    calls: int
    read: int
    written: int
    uncached: int


def _count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _first(source: object, names: tuple[str, ...]) -> int | None:
    for name in names:
        found = _count(usage_field(source, name))
        if found is not None:
            return found
    return None


def counts_of(usage: object) -> Counts | None:
    """The cached, written and uncached input tokens of a call, None when its usage has no count
    of prompt tokens."""
    if usage is None:
        return None
    prompt = _count(usage_field(usage, "prompt_tokens"))
    if prompt is None:
        return None
    read, written = _first(usage, _READ_NAMES), _first(usage, _WRITE_NAMES)
    details = usage_field(usage, "prompt_tokens_details")
    if read is None and details is not None:
        read = _first(details, _DETAIL_READ_NAMES)
    if written is None and details is not None:
        written = _first(details, _DETAIL_WRITE_NAMES)
    read, written = read or 0, written or 0
    if read + written > prompt:
        return Counts(0, 0, prompt)
    return Counts(read, written, prompt - read - written)


class CacheTally:
    """The counts of every call of one job. Safe to add to from several threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._calls = 0
        self._read = 0
        self._written = 0
        self._uncached = 0

    def add(self, usage: object) -> None:
        counts = counts_of(usage)
        if counts is None:
            return
        with self._lock:
            self._calls += 1
            self._read += counts.read
            self._written += counts.written
            self._uncached += counts.uncached

    def counts(self) -> Tally:
        with self._lock:
            return Tally(self._calls, self._read, self._written, self._uncached)

    def describe(self) -> str | None:
        """The line a job logs, None when no call reported a usage."""
        tally = self.counts()
        if tally.calls == 0:
            return None
        calls = "call" if tally.calls == 1 else "calls"
        return (
            f"prompt cache: {tally.calls} {calls}, {tally.read} input tokens read from the cache, "
            f"{tally.written} written to the cache, {tally.uncached} not cached"
        )
