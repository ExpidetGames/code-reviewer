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
from typing import Any, Final, Protocol, cast

from code_reviewer_runner.dynamic_review.passthrough.call_usage import CallUsage
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.finish_reason import (
    chat_finish,
    google_finish,
    messages_finish,
    responses_finish,
)
from code_reviewer_runner.dynamic_review.passthrough.sse import SseFramer, read_event
from code_reviewer_runner.dynamic_review.passthrough.usage_normalize import (
    STANDARD_OPENAI_TIERS,
    audit,
    normalize,
    went_backwards,
)

__all__ = ["CallUsage", "TapResult", "UsageTap", "is_error_event", "tap_for"]


@dataclass(frozen=True)
class TapResult:
    usage: CallUsage | None
    # An error object or error event was in the answer, whatever its HTTP status was.
    errored: bool
    # The answer reached its own end (a stream: its last event) and not just a closed connection.
    terminated: bool
    # Why the answer ended, as the call trace names it (`finish_reason.py`); None if it never said.
    finish_reason: str | None = None


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


# What the tap adds to `unknown_fields` for an answer whose events are not the ones the family
# sends: a usage stated more often or in another place than the family does, and one that states
# less than an earlier statement of the same call.
EVENTS: Final = "usage_events"
BACKWARDS: Final = "usage_backwards"
# Events that carry no meaning for the order of a Messages stream.
_IDLE: Final = ("ping", "error")


class _Reading:
    """What has been seen of an answer so far; the same for a stream and for a document.

    A call has one usage. Chat and Responses state it once (one chunk at or after the finish, one
    terminal event); Messages states the input in `message_start`, exactly once and first, and the
    output in the `message_delta` events that follow, until `message_stop`; Google may state its
    cumulative usage again. A usage that is stated more often, in the wrong place or order, or less
    than before, is not the usage of one call, and it is never settled with (review of PR #569).
    """

    def __init__(self, family: WireFamily, *, whole: bool) -> None:
        self.family = family
        # A whole document is one value that is the answer; a stream's values are its events.
        self.whole = whole
        self.usage: dict[str, Any] = {}
        # Everything any statement of the call said that cannot be priced or trusted: the union
        # over the events, so that a later event cannot overwrite what an earlier one revealed.
        self.unknown: set[str] = set()
        self.errored = False
        self.terminated = False
        self.finished = False
        self.finish_reason: str | None = None
        # The usage that is there is the final one (the answer's own end has stated it).
        self.usage_final = whole
        self._statements = 0
        self._terminals = 0
        self._output_stated = False
        self._started = False
        self._stopped = False

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
        self.finished = self.finished or _chat_finished(choices)
        for choice in _entries(choices)[:1]:
            self._finish(chat_finish(choice.get("finish_reason")))
        raw = document.get("usage")
        if raw is not None:
            # One statement, at or after the finish: an earlier one is a part of the count.
            self._state(raw, replace=True, once=True, in_order=self.finished or self.whole)
        if _several(choices):
            self.unknown.add("choices")
        if _chat_failed(choices):
            self.errored = True
        self._service_tier(document)
        # Not every OpenAI-compatible provider ends with `[DONE]`: the usage that comes after a
        # finish reason is an end as well.
        if self.finished and self.usage:
            self.terminated = True
            self.usage_final = True

    def _google(self, document: dict[str, Any]) -> None:
        # UNCONFIRMED live (L14): `usageMetadata` on every chunk (cumulative) or only on the last.
        raw = document.get("usageMetadata")
        candidates = document.get("candidates")
        if _several(candidates):
            self.unknown.add("candidates")
        for candidate in _entries(candidates)[:1]:
            self._finish(google_finish(candidate.get("finishReason")))
        if raw is not None:
            self._state(raw, replace=True)
        if _finished(candidates):
            # The usage must be stated at the end (the last chunk, or the cumulative one): one from
            # before it is a part of the count.
            self.terminated = True
            self.usage_final = raw is not None
        elif self.terminated and raw is not None:
            self.usage_final = True

    def _responses(self, name: str | None, document: dict[str, Any]) -> None:
        if self.whole:
            raw = document.get("usage")
            if raw is not None:
                self._state(raw, replace=True)
            self._service_tier(document)
            self._finish(responses_finish(document))
            return
        # Only the event that ends the response carries its usage (`response.created` has none, and
        # a usage in any other event is not read), and a response ends once.
        kind = document.get("type") or name
        if kind not in ("response.completed", "response.incomplete", "response.failed"):
            return
        self._terminals += 1
        if self._terminals > 1:
            self.unknown.add(EVENTS)
        if kind == "response.failed":
            return
        response = _object(document.get("response")) or {}
        raw = response.get("usage")
        if raw is not None:
            self._state(raw, replace=True)
        self._service_tier(response)
        self._finish(responses_finish(response))
        self.terminated = True
        self.usage_final = isinstance(raw, dict)

    def _messages(self, name: str | None, document: dict[str, Any]) -> None:
        if self.whole:
            self._state(document.get("usage"), replace=False)
            self._finish(messages_finish(document.get("stop_reason")))
            return
        kind = document.get("type") or name
        if kind in _IDLE:
            return
        if self._stopped:
            # Nothing comes after `message_stop`: a second message in the stream is a second usage.
            self.unknown.add(EVENTS)
            return
        if kind == "message_start":
            if self._started:
                self.unknown.add(EVENTS)  # exactly once
                return
            self._started = True
            message = _object(document.get("message"))
            self._state(message.get("usage") if message else None, replace=False)
        elif not self._started:
            self.unknown.add(EVENTS)  # the start comes first
        elif kind == "message_delta":
            # UNCONFIRMED live (L14): the delta may state only `output_tokens` (the fakes) or repeat
            # the input and cache fields cumulatively; either way it may only state more than the
            # start did, and the output counts only once a delta has stated it.
            usage = document.get("usage")
            self._state(usage, replace=False)
            delta = _object(document.get("delta"))
            self._finish(messages_finish(delta.get("stop_reason") if delta else None))
            # The output of `message_start` is a placeholder: only a delta states the real one.
            if isinstance(usage, dict) and usage.get("output_tokens") is not None:  # pyright: ignore[reportUnknownMemberType]
                self._output_stated = True
        elif kind == "message_stop":
            self._stopped = True
            self.terminated = True
            self.usage_final = self._output_stated

    def _finish(self, reason: str | None) -> None:
        """The reason the answer ended with; a later statement of one replaces an earlier."""
        if reason is not None:
            self.finish_reason = reason

    def _service_tier(self, holder: dict[str, Any]) -> None:
        if holder.get("service_tier") not in STANDARD_OPENAI_TIERS:
            self.unknown.add("service_tier")

    def _state(self, raw: Any, *, replace: bool, once: bool = False, in_order: bool = True) -> None:
        """One statement of the usage. `replace`: it stands in place of the earlier one (otherwise
        it adds to it, a field stated again taking the later value); `once`: it is the only one a
        call may have; `in_order`: it came where the family states it."""
        self._statements += 1
        if (once and self._statements > 1) or not in_order:
            self.unknown.add(EVENTS)
        found = _object(raw)
        if found is None:
            self.unknown.add("usage")  # a usage that is not an object is not understood
            return
        self.unknown |= audit(self.family, found)
        # The output of a Messages start is a placeholder, whatever it says.
        placeholder = () if self._output_stated or self.whole else ("output_tokens",)
        if self.usage and went_backwards(
            self.usage, found, replaced=replace, ignore=placeholder if not replace else ()
        ):
            self.unknown.add(BACKWARDS)
        self.usage = dict(found) if replace else _joined(self.usage, found)


def _joined(earlier: dict[str, Any], later: dict[str, Any]) -> dict[str, Any]:
    """`later` over `earlier`, one level of objects deep (a split of the cache stated again)."""
    joined = dict(earlier)
    for key, value in later.items():
        old = joined.get(key)
        if isinstance(old, dict) and isinstance(value, dict):
            joined[key] = {**cast("dict[str, Any]", old), **cast("dict[str, Any]", value)}
        else:
            joined[key] = value
    return joined


def _result(reading: _Reading) -> TapResult:
    usage: CallUsage | None = None
    if reading.usage:
        try:
            usage = normalize(reading.family, reading.usage, reading.unknown)
        except RecursionError:
            # Nothing in the normalizer recurses over what the provider sent; if something ever
            # did, the call has no usage (unknown), and the relay is not touched.
            usage = None
    terminated = reading.terminated and not reading.errored
    if usage is not None:
        usage = replace(usage, complete=terminated and reading.usage_final)
    return TapResult(
        usage=usage,
        errored=reading.errored,
        terminated=terminated,
        finish_reason=reading.finish_reason,
    )


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
