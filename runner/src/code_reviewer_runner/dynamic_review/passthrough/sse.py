# SPDX-License-Identifier: LicenseRef-Proprietary

"""Server-sent events, framed for the relay and read for the tee (#550).

The relay forwards the bytes of a stream unchanged, but it forwards them one whole event at a time:
that is what lets it look at an event (is it an error that quotes the key?) before the engine sees
it. `SseFramer` cuts a byte stream into events at the blank line, at any chunk boundary and with any
of the three line ends, and loses no byte: the events and what `finish()` returns put together are
the input. `read_event` reads one framed event as the SSE format defines it.
"""

import re
from dataclasses import dataclass
from typing import Final

# A line end followed by a line end is the blank line that closes an event.
# (`\r` not before `\n` in the first: `\r\n` is one line end, never two.)
_BOUNDARY: Final = re.compile(rb"(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r|\n)")
_LINE_END: Final = re.compile(rb"\r\n|\r|\n")


class SseFramer:
    def __init__(self) -> None:
        self._buffer = b""

    def feed(self, data: bytes) -> list[bytes]:
        """The events that `data` completes, each with its closing blank line."""
        self._buffer += data
        events: list[bytes] = []
        while True:
            found = _BOUNDARY.search(self._buffer)
            if found is None:
                return events
            end = found.end()
            # A lone `\r` at the very end may be the first half of `\r\n`: wait for the next byte.
            if end == len(self._buffer) and self._buffer.endswith(b"\r"):
                return events
            events.append(self._buffer[:end])
            self._buffer = self._buffer[end:]

    def finish(self) -> bytes:
        """What is left when the stream ends: a last event without its blank line, or nothing."""
        rest, self._buffer = self._buffer, b""
        return rest


@dataclass(frozen=True)
class SseEvent:
    name: str | None
    data: str


def read_event(raw: bytes) -> SseEvent:
    """The event name and the data of one framed event (data lines joined with a newline)."""
    name: str | None = None
    data: list[str] = []
    for line in _LINE_END.split(raw):
        text = line.decode("utf-8", errors="replace")
        if not text or text.startswith(":"):
            continue
        field, _, value = text.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            name = value
        elif field == "data":
            data.append(value)
    return SseEvent(name, "\n".join(data))
