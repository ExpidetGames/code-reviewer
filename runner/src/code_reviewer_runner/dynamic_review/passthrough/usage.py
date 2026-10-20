# SPDX-License-Identifier: Apache-2.0

"""The usage tap (#550, #551): the bytes of an answer in, what the provider says it used out.

The relay hands the tap every byte it forwards. The tap never changes them and never fails the
relay: what it cannot read is "no usage", and the ledger then fails closed
(`dynamic_accounting_failed`, as on the legacy path). A usage is only to be trusted for an answer
that `terminated` without an error and whose usage is `complete`: a stream cut or failed half way
may have stated its input (a Messages stream does) and not its output.

Only the structure of the provider's answer counts. The usage is read from the one place the family
puts it (the last chunk of a Chat stream, `response.completed`, `message_start` and `message_delta`,
`usageMetadata`) and never from a value the model wrote: text and tool arguments are JSON strings or
sit below a key no usage is read from, and an event of a kind that carries no usage is not looked at
for one. The usage object is then read by `usage_normalize.py`, which fails closed. What the answer
says besides the usage that makes the call unattributable (a second choice, a service tier other
than the standard one) is added to the usage's `unknown_fields`.

Where the usage sits is pinned by `fakes/wire/formats.py`, whose shapes follow the providers'
documentation and are not yet captured from real providers (the live checklist of
docs/spike/544-passthrough.md, L3 and L14).
"""

import json
from dataclasses import dataclass, replace
from typing import Any, Protocol

from code_reviewer_runner.dynamic_review.passthrough.call_usage import CallUsage
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.sse import SseFramer, read_event
from code_reviewer_runner.dynamic_review.passthrough.usage_normalize import (
    STANDARD_OPENAI_TIERS,
    normalize,
)

__all__ = ["CallUsage", "TapResult", "UsageTap", "is_error_event", "tap_for"]


@dataclass(frozen=True)
class TapResult:
    usage: CallUsage | None
    # An error object or error event was in the answer, whatever its HTTP status was.
    errored: bool
    # The answer reached its own end (a stream: its last event) and not just a closed connection.
    terminated: bool


class UsageTap(Protocol):
    def feed(self, data: bytes) -> None: ...

    def finish(self) -> TapResult: ...


def _object(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None  # pyright: ignore[reportUnknownVariableType]


# -- what one JSON value of an answer says ---------------------------------------------------------


def _entries(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [entry for item in items if (entry := _object(item)) is not None]  # pyright: ignore[reportUnknownVariableType]


def _several(items: Any) -> bool:
    """Whether `items` (the choices or the candidates of an answer) is about more than one. The
    request asks for exactly one, so a second, or one that is not the first, is a usage the proxy
    cannot attribute to the request."""
    entries = _entries(items)
    return len(entries) > 1 or any(entry.get("index", 0) not in (0, None) for entry in entries)


def _finished(candidates: Any) -> bool:
    """Whether a Google chunk has a candidate that says why it ended."""
    return any(bool(candidate.get("finishReason")) for candidate in _entries(candidates))


def _chat_finished(choices: Any) -> bool:
    return any(bool(choice.get("finish_reason")) for choice in _entries(choices))


def _chat_failed(choices: Any) -> bool:
    """A choice that finished with `error` (a gateway's way to end a stream it could not finish)."""
    return any(choice.get("finish_reason") == "error" for choice in _entries(choices))


def _real_error(value: Any) -> bool:
    """Whether the value of an `error` key is an error: an object is one, text or a count is one
    when it says something, and `null` (which some providers send in every chunk) or `false` is
    not."""
    return isinstance(value, dict) or bool(value)


def _is_error(name: str | None, document: dict[str, Any]) -> bool:
    """Whether one event (or the whole document) of an answer is an error, whatever the HTTP status
    of the answer was."""
    return (
        _real_error(document.get("error"))
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
    except (ValueError, RecursionError):
        # Unreadable (or nested deeper than the parser goes) is not an error event we can see.
        return False
    document = _object(value)
    return document is not None and _is_error(event.name, document)


class _Reading:
    """What has been seen of an answer so far; the same for a stream and for a document."""

    def __init__(self, family: WireFamily, *, whole: bool) -> None:
        self.family = family
        # A whole document is one value that is the answer; a stream's values are its events.
        self.whole = whole
        self.usage: dict[str, Any] = {}
        self.unknown: set[str] = set()
        self.errored = False
        self.terminated = False
        self.finished = False
        # The usage that is there is the final one (the answer's own end has stated it).
        self.usage_final = whole
        self._output_stated = False

    def see(self, name: str | None, value: Any) -> None:
        """One JSON value: an event's data, or the whole document."""
        document = _object(value)
        if document is None:
            return
        if _is_error(name, document):
            self.errored = True
        family = self.family
        if family is WireFamily.OPENAI_CHAT:
            self._chat(document)
        elif family is WireFamily.GOOGLE:
            self._google(document)
        elif family is WireFamily.OPENAI_RESPONSES:
            self._responses(name, document)
        else:
            self._messages(name, document)

    def _chat(self, document: dict[str, Any]) -> None:
        choices = document.get("choices")
        self._merge(document.get("usage"), replace=True)
        if _several(choices):
            self.unknown.add("choices")
        if _chat_failed(choices):
            self.errored = True
        self._service_tier(document)
        # Not every OpenAI-compatible provider ends with `[DONE]`: the usage that comes after a
        # finish reason is an end as well.
        self.finished = self.finished or _chat_finished(choices)
        if self.finished and self.usage:
            self.terminated = True
            self.usage_final = True

    def _google(self, document: dict[str, Any]) -> None:
        # UNCONFIRMED live (L14): `usageMetadata` on every chunk (cumulative) or only on the last.
        usage = _object(document.get("usageMetadata"))
        candidates = document.get("candidates")
        if _several(candidates):
            self.unknown.add("candidates")
        self._merge(usage, replace=True)
        if _finished(candidates):
            # The usage must be stated at the end (the last chunk, or the cumulative one): one from
            # before it is a part of the count.
            self.terminated = True
            self.usage_final = usage is not None
        elif self.terminated and usage is not None:
            self.usage_final = True

    def _responses(self, name: str | None, document: dict[str, Any]) -> None:
        if self.whole:
            self._merge(document.get("usage"), replace=True)
            self._service_tier(document)
            return
        # Only the event that ends the response carries its usage (`response.created` has none, and
        # a usage in any other event is not read).
        if (document.get("type") or name) not in ("response.completed", "response.incomplete"):
            return
        response = _object(document.get("response")) or {}
        usage = _object(response.get("usage"))
        self._merge(usage, replace=True)
        self._service_tier(response)
        self.terminated = True
        self.usage_final = usage is not None

    def _messages(self, name: str | None, document: dict[str, Any]) -> None:
        if self.whole:
            self._merge(document.get("usage"))
            return
        kind = document.get("type") or name
        if kind == "message_start":
            message = _object(document.get("message"))
            self._merge(message.get("usage") if message else None)
        elif kind == "message_delta":
            # UNCONFIRMED live (L14): the delta may state only `output_tokens` (the fakes) or repeat
            # the input and cache fields cumulatively; either way a later statement replaces an
            # earlier one, and the output counts only once a delta has stated it.
            usage = _object(document.get("usage"))
            self._merge(usage)
            # The output of `message_start` is a placeholder: only a delta states the real one.
            if usage is not None and usage.get("output_tokens") is not None:
                self._output_stated = True
        elif kind == "message_stop":
            self.terminated = True
            self.usage_final = self._output_stated

    def _service_tier(self, holder: dict[str, Any]) -> None:
        if holder.get("service_tier") not in STANDARD_OPENAI_TIERS:
            self.unknown.add("service_tier")

    def _merge(self, usage: Any, *, replace: bool = False) -> None:
        found = _object(usage)
        if found is None:
            return
        # Messages states the input first and the output at the end, each in its own object:
        # fields add up by name, a later value replacing an earlier one.
        self.usage = dict(found) if replace else {**self.usage, **found}


def _result(reading: _Reading) -> TapResult:
    usage = normalize(reading.family, reading.usage, reading.unknown) if reading.usage else None
    terminated = reading.terminated and not reading.errored
    if usage is not None:
        usage = replace(usage, complete=terminated and reading.usage_final)
    return TapResult(usage=usage, errored=reading.errored, terminated=terminated)


class _StreamTap:
    def __init__(self, family: WireFamily) -> None:
        self._reading = _Reading(family, whole=False)
        self._framer = SseFramer()
        self._done = family is WireFamily.OPENAI_CHAT

    def feed(self, data: bytes) -> None:
        for raw in self._framer.feed(data):
            self._take(raw)

    def _take(self, raw: bytes) -> None:
        event = read_event(raw)
        if event.data == "[DONE]":
            reading = self._reading
            reading.terminated = reading.terminated or self._done
            # A Chat stream that states its usage and then ends has ended with its usage.
            reading.usage_final = reading.usage_final or (self._done and bool(reading.usage))
            return
        try:
            value: Any = json.loads(event.data)
        except (ValueError, RecursionError):
            # An error event with a text body is still an error; one nested too deep to parse is
            # unreadable, which is "no usage" and no crash.
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

    def finish(self) -> TapResult:
        reading = _Reading(self._family, whole=True)
        try:
            reading.see(None, json.loads(bytes(self._body)))
        except (ValueError, RecursionError):
            return TapResult(usage=None, errored=False, terminated=False)
        reading.terminated = not reading.errored
        return _result(reading)


def tap_for(family: WireFamily, *, sse: bool) -> UsageTap:
    """The tap for an answer of this family: a stream of events, or a plain JSON document."""
    return _StreamTap(family) if sse else _DocumentTap(family)
