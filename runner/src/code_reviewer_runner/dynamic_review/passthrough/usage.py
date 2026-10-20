# SPDX-License-Identifier: Apache-2.0

"""The usage tap (#550): the bytes of an answer in, what the provider says it used out.

The relay hands the tap every byte it forwards. The tap never changes them and never fails the
relay: what it cannot read is "no usage", and the ledger then fails closed
(`dynamic_accounting_failed`, as on the legacy path). A usage is only to be trusted for an answer
that `terminated` without an error: a stream cut or failed half way may have stated its input (a
Messages stream does) and not its output. This is the interface and the minimal parser per
family; #551 hardens the parsers against captured answers and adds the cases a fake cannot know.

Counts are the runner's: `prompt_tokens` is the whole prompt including what came from or went to the
provider's cache, `completion_tokens` is everything billed as output (a thinking model's thoughts
included). Where the usage sits is pinned by `fakes/wire/formats.py`, whose shapes follow the
providers' documentation and are not yet captured from real providers (the live checklist of
docs/spike/544-passthrough.md).
"""

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

from code_reviewer_runner.dynamic_review.budget import exact_cost
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.sse import SseFramer, read_event


@dataclass(frozen=True)
class CallUsage:
    prompt_tokens: int
    completion_tokens: int
    cache_read: int
    cache_write: int
    # The charge the provider states for the call (OpenRouter's `usage.cost`), if it does.
    stated_cost: Decimal | None


@dataclass(frozen=True)
class TapResult:
    usage: CallUsage | None
    # An error object or error event was in the answer, whatever its HTTP status was.
    errored: bool
    # The answer reached its own end (a stream: its last event) and not just a closed connection.
    terminated: bool


class UsageTap(Protocol):
    def feed(self, data: bytes) -> None: ...

    @property
    def complete(self) -> bool:
        """The answer has reached its end and stated its usage: nothing more is needed from it."""
        ...

    def finish(self) -> TapResult: ...


def _count(value: Any) -> int | None:
    # A boolean is an int in Python and no count in JSON.
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _object(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None  # pyright: ignore[reportUnknownVariableType]


def _optional(source: dict[str, Any] | None, *path: str) -> int:
    """A count that may be missing (the provider leaves out a zero); a bad one is 0 as well."""
    node: Any = source
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    return _count(node) or 0


# -- the usage object of each family --------------------------------------------------------------


def _chat_usage(usage: dict[str, Any]) -> CallUsage | None:
    prompt, completion = _count(usage.get("prompt_tokens")), _count(usage.get("completion_tokens"))
    if prompt is None or completion is None:
        return None
    read = _optional(usage, "prompt_tokens_details", "cached_tokens") or _optional(
        usage, "prompt_cache_hit_tokens"
    )
    written = _optional(usage, "prompt_tokens_details", "cache_write_tokens")
    return CallUsage(prompt, completion, read, written, exact_cost(usage.get("cost")))


def _responses_usage(usage: dict[str, Any]) -> CallUsage | None:
    prompt, completion = _count(usage.get("input_tokens")), _count(usage.get("output_tokens"))
    if prompt is None or completion is None:
        return None
    read = _optional(usage, "input_tokens_details", "cached_tokens")
    return CallUsage(prompt, completion, read, 0, None)


def _messages_usage(usage: dict[str, Any]) -> CallUsage | None:
    fresh, completion = _count(usage.get("input_tokens")), _count(usage.get("output_tokens"))
    if fresh is None or completion is None:
        return None
    read = _optional(usage, "cache_read_input_tokens")
    written = _optional(usage, "cache_creation_input_tokens")
    return CallUsage(fresh + read + written, completion, read, written, None)


def _google_usage(usage: dict[str, Any]) -> CallUsage | None:
    prompt = _count(usage.get("promptTokenCount"))
    if prompt is None:
        return None
    # Thoughts are billed as output and are not part of the candidates.
    completion = _optional(usage, "candidatesTokenCount") + _optional(usage, "thoughtsTokenCount")
    return CallUsage(prompt, completion, _optional(usage, "cachedContentTokenCount"), 0, None)


_NORMALIZE = {
    WireFamily.OPENAI_CHAT: _chat_usage,
    WireFamily.OPENAI_RESPONSES: _responses_usage,
    WireFamily.ANTHROPIC_MESSAGES: _messages_usage,
    WireFamily.GOOGLE: _google_usage,
}


# -- what one JSON value of an answer says ---------------------------------------------------------


def _finished(candidates: Any) -> bool:
    """Whether a Google chunk has a candidate that says why it ended."""
    if not isinstance(candidates, list):
        return False
    return any(
        (candidate := _object(entry)) is not None and bool(candidate.get("finishReason"))
        for entry in candidates  # pyright: ignore[reportUnknownVariableType]
    )


def _chat_finished(choices: Any) -> bool:
    if not isinstance(choices, list):
        return False
    return any(
        (choice := _object(entry)) is not None and bool(choice.get("finish_reason"))
        for entry in choices  # pyright: ignore[reportUnknownVariableType]
    )


def _is_error(name: str | None, document: dict[str, Any]) -> bool:
    """Whether one event (or the whole document) of an answer is an error, whatever the HTTP status
    of the answer was."""
    return (
        "error" in document
        or name == "error"
        or document.get("type") in ("error", "response.failed")
    )


def is_error_event(raw: bytes) -> bool:
    """Whether one framed event of a stream is an error event. Only the provider's own structure
    counts (the name of the event, the keys of its JSON): the words of the model never do."""
    event = read_event(raw)
    if event.name == "error":
        return True
    try:
        value: Any = json.loads(event.data)
    except ValueError:
        return False
    document = _object(value)
    return document is not None and _is_error(event.name, document)


class _Reading:
    """What has been seen of an answer so far; the same for a stream and for a document."""

    def __init__(self, family: WireFamily) -> None:
        self.family = family
        self.usage: dict[str, Any] = {}
        self.errored = False
        self.terminated = False
        self.finished = False

    def see(self, name: str | None, value: Any) -> None:
        """One JSON value: an event's data, or the whole document."""
        document = _object(value)
        if document is None:
            return
        if _is_error(name, document):
            self.errored = True
        family = self.family
        if family is WireFamily.OPENAI_CHAT:
            self._merge(document.get("usage"), replace=True)
            # Not every OpenAI-compatible provider ends with `[DONE]`: the usage that comes after a
            # finish reason is an end as well.
            self.finished = self.finished or _chat_finished(document.get("choices"))
            if self.finished and self.usage:
                self.terminated = True
        elif family is WireFamily.GOOGLE:
            self._merge(document.get("usageMetadata"), replace=True)
            if _finished(document.get("candidates")):
                self.terminated = True
        elif family is WireFamily.OPENAI_RESPONSES:
            response = _object(document.get("response")) or document
            self._merge(response.get("usage"), replace=True)
            if document.get("type") in ("response.completed", "response.incomplete"):
                self.terminated = True
        else:
            message = _object(document.get("message"))
            self._merge(message.get("usage") if message else None)
            self._merge(document.get("usage"))
            if document.get("type") == "message_stop":
                self.terminated = True

    def _merge(self, usage: Any, *, replace: bool = False) -> None:
        found = _object(usage)
        if found is None:
            return
        # Messages states the input first and the output at the end, each in its own object:
        # fields add up by name, a later value replacing an earlier one.
        self.usage = dict(found) if replace else {**self.usage, **found}


def _result(reading: _Reading) -> TapResult:
    usage = _NORMALIZE[reading.family](reading.usage) if reading.usage else None
    return TapResult(
        usage=usage, errored=reading.errored, terminated=reading.terminated and not reading.errored
    )


class _StreamTap:
    def __init__(self, family: WireFamily) -> None:
        self._reading = _Reading(family)
        self._framer = SseFramer()
        self._done = family is WireFamily.OPENAI_CHAT

    def feed(self, data: bytes) -> None:
        for raw in self._framer.feed(data):
            self._take(raw)

    @property
    def complete(self) -> bool:
        return self._reading.terminated and not self._reading.errored and bool(self._reading.usage)

    def _take(self, raw: bytes) -> None:
        event = read_event(raw)
        if event.data == "[DONE]":
            self._reading.terminated = self._reading.terminated or self._done
            return
        try:
            value: Any = json.loads(event.data)
        except ValueError:
            # An error event with a text body is still an error.
            self._reading.errored = self._reading.errored or event.name == "error"
            return
        self._reading.see(event.name, value)

    def finish(self) -> TapResult:
        rest = self._framer.finish()
        if rest:
            self._take(rest)
        return _result(self._reading)


class _DocumentTap:
    def __init__(self, family: WireFamily) -> None:
        self._family = family
        self._body = bytearray()

    def feed(self, data: bytes) -> None:
        self._body += data

    @property
    def complete(self) -> bool:
        return False

    def finish(self) -> TapResult:
        reading = _Reading(self._family)
        try:
            reading.see(None, json.loads(bytes(self._body)))
        except ValueError:
            return TapResult(usage=None, errored=False, terminated=False)
        reading.terminated = not reading.errored
        return _result(reading)


def tap_for(family: WireFamily, *, sse: bool) -> UsageTap:
    """The tap for an answer of this family: a stream of events, or a plain JSON document."""
    return _StreamTap(family) if sse else _DocumentTap(family)
