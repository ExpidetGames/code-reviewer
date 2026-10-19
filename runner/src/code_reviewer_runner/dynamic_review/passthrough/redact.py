# SPDX-License-Identifier: Apache-2.0

"""Cutting the real key out of what the provider says (#550, T10).

An error body or an error event may quote the key it was sent, whole or masked (`sk-proj-****abcd`):
OpenAI does, and the spike showed the key arrive unredacted in the engine's error message through a
pure relay. Whatever the provider says about an error is therefore passed through this before the
engine, or any line of ours, sees it. A "part" of the key is any run of at least `MIN_PART`
characters of it, so a masked quote is cut as well; shorter runs are ordinary text.
"""

import re
from typing import Final

REDACTED: Final = b"[redacted]"
MIN_PART: Final = 8


class Redactor:
    def __init__(self, key: str) -> None:
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
