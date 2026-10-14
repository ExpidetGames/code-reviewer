# SPDX-License-Identifier: Apache-2.0

"""Escapes instruction-shaped framing in tool-result text, matched on a normalised copy (#243).

What it finds, after folding (see `README.md`, "Dynamic Review", for what is and is not covered):

- the `<runner-wrap-up>` tag of the runner's own wrap-up instruction (#293), in the same spellings,
  so that no repository text can pose as the instruction;
- the `<system-reminder>` tag the pinned engine's prompt blesses, in any spelling a reader or model
  would take for it: case, whitespace and slashes after the bracket, `_` or a dash lookalike for the
  hyphen, full-width and other `<` lookalikes, and invisible characters anywhere inside;
- a chat-template control token, `<|name|>` and its full-width form (`<|im_start|>`, `<|system|>`,
  DeepSeek's `<U+FF5C begin U+2581 of U+2581 sentence U+FF5C>`), which must stay text. Only the
  closed form is matched, so `<|` in code (a regex alternation `/<|>/g`, F#'s `<|`, Haskell's `<|>`)
  is left alone.

The text is **normalised for matching only**. A match rewrites its opening bracket to `&lt;` and
nothing else, so the rest of the text, including every other character that happens to be
non-ASCII or invisible, is returned as it was. `&lt;` is also what the output looks like when the
file already held it, so the transformation is idempotent and entity text is left alone.

Linear time: the folding is one `str.translate`, the invisible characters are removed with a single
`+` run per match of one character class, and the offsets of removed characters are tracked by one
sweep. The match itself is linear because a bracket scans only its own run: whitespace and slashes
after it are one `[\\s/]` run (the earlier form with two adjacent `\\s*` was quadratic), and a
template token name is capped at 64 characters. The run is written possessive to rule out
backtracking over it; the pattern would be linear without it.

A tag split across the text parts of one result is found by matching over the parts joined, and
the bracket is rewritten in the part that holds it.
"""

import re
from collections.abc import Sequence

from code_reviewer_runner.dynamic_review.ignorable import (
    CONTROL_RANGES,
    DEFAULT_IGNORABLE_RANGES,
    character_class,
)

_ESCAPED = "&lt;"

_FULL_WIDTH = range(0xFF01, 0xFF5F)
# Small, single-angle-quote, CJK, math, heavy, ornament, double and Canadian syllabics forms of `<`.
_BRACKETS = "\ufe64\u2039\u2329\u3008\u27e8\u276e\u02c2\u300a\u27ea\u276c\u1438"
_DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2043\u2212\ufe58\ufe63\u058a_"
_SLASHES = "\u2044\u2215"

_FOLD = {
    **{char: chr(char - 0xFEE0) for char in _FULL_WIDTH},
    **{ord(char): "<" for char in _BRACKETS},
    **{ord(char): "-" for char in _DASHES},
    ord("\uff3f"): "-",  # U+FF3F, full-width low line
    **{ord(char): "/" for char in _SLASHES},
}

# Characters that render as nothing (`ignorable.py`). Ignored for matching, never removed from the
# text.
_IGNORABLE = re.compile(
    "[" + character_class(DEFAULT_IGNORABLE_RANGES) + character_class(CONTROL_RANGES) + "]+"
)
# A bracket in any form: the quick exit for text that cannot hold a match.
_ANY_BRACKET = re.compile("[<\uff1c" + _BRACKETS + "]")
# On the folded text: the tag, or a closed chat-template token (a name without brackets, pipes and
# whitespace, at most 64 characters).
_MATCH = re.compile(
    r"<(?:[\s/]*+(?:system-reminder|runner-wrap-up)|\|[^<>|\s]{1,64}\|>)", re.IGNORECASE
)


def escape_text(text: str) -> str:
    return escape_texts([text])[0]


def escape_texts(texts: Sequence[str]) -> list[str]:
    """Each text with the opening bracket of every match rewritten; matches may span texts."""
    joined = texts[0] if len(texts) == 1 else "".join(texts)
    if _ANY_BRACKET.search(joined) is None:
        return list(texts)
    brackets = _bracket_positions(joined)
    if not brackets:
        return list(texts)
    return _rewrite(texts, brackets)


def _bracket_positions(text: str) -> list[int]:
    """Where, in the original text, the opening bracket of each match is."""
    folded = text.translate(_FOLD)
    removed = [(run.start(), run.end() - run.start()) for run in _IGNORABLE.finditer(folded)]
    if removed:
        folded = _IGNORABLE.sub("", folded)
    positions: list[int] = []
    run = 0
    gone = 0  # characters removed in front of the folded offset being mapped
    for match in _MATCH.finditer(folded):
        offset = match.start()
        # A run was removed in front of this offset when its start, less what was removed before
        # it, is at or before the offset.
        while run < len(removed) and removed[run][0] - gone <= offset:
            gone += removed[run][1]
            run += 1
        positions.append(offset + gone)
    return positions


def _rewrite(texts: Sequence[str], positions: list[int]) -> list[str]:
    out: list[str] = []
    base = 0
    taken = 0
    for text in texts:
        end = base + len(text)
        pieces: list[str] = []
        cursor = 0
        while taken < len(positions) and positions[taken] < end:
            local = positions[taken] - base
            pieces.append(text[cursor:local])
            pieces.append(_ESCAPED)
            cursor = local + 1
            taken += 1
        if not pieces:
            out.append(text)
        else:
            pieces.append(text[cursor:])
            out.append("".join(pieces))
        base = end
    return out
