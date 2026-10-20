# SPDX-License-Identifier: Apache-2.0

"""Cutting the real key out of the few things of the provider's that reach the engine (#550, T10).

An error event or a header may quote the key it was sent, whole or masked (`sk-proj-****abcd`):
OpenAI does, and the spike showed the key arrive unredacted in the engine's error message through a
pure relay. A "part" of the key is any run of at least `MIN_PART` characters of it, so a masked
quote is cut as well; shorter runs are ordinary text.

**Redaction is never applied to content.** If the proxy cut the key out of a normal answer, an
engine that writes guesses of the key into its output would see the cut where a guess is right: the
proxy would be an oracle for the key, one character run at a time. So a successful answer is
relayed unchanged, and this is used only on what no model writes: the events of an error stream
and the headers of an answer. What the provider says in an error *body* is not passed on at all
(`proxy.py`), so there is nothing left to cut there.
"""

import re
from typing import Final

REDACTED: Final = b"[redacted]"
MIN_PART: Final = 8
# A key shorter than this is no key (an empty one would match everywhere): refused at construction.
MIN_KEY_CHARS: Final = 16


class Redactor:
    def __init__(self, key: str) -> None:
        if len(key) < MIN_KEY_CHARS:
            raise ValueError("the key is too short to be cut out of a text")
        self._key = key.encode("utf-8")
        size = min(MIN_PART, len(self._key))
        grams = {self._key[at : at + size] for at in range(len(self._key) - size + 1)}
        # Longest first so a whole key is one match where it can be.
        self._pattern = re.compile(b"|".join(map(re.escape, sorted(grams, key=len, reverse=True))))
        self._size = size

    def redact(self, data: bytes) -> bytes:
        """`data` without the key and without parts of it; `data` itself when it has none."""
        found = self._pattern.search(data)
        if found is None:
            return data
        pieces: list[bytes] = []
        at = 0
        while found is not None:
            start = found.start()
            end = start + self._reach(data, start)
            pieces += [data[at:start], REDACTED]
            at = end
            found = self._pattern.search(data, at)
        pieces.append(data[at:])
        return b"".join(pieces)

    def _reach(self, data: bytes, start: int) -> int:
        """How many bytes from `start` are the same as the key from some place in it."""
        gram = data[start : start + self._size]
        best, offset = self._size, self._key.find(gram)
        while offset != -1:
            length = self._size
            while (
                offset + length < len(self._key)
                and start + length < len(data)
                and data[start + length] == self._key[offset + length]
            ):
                length += 1
            best = max(best, length)
            offset = self._key.find(gram, offset + 1)
        return best
