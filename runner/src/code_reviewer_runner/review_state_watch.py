# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""Notices when PR-Agent had to shorten the review comment to make it fit GitHub's size limit.

PR-Agent keeps a hidden record of every finding it has seen in the review comment, so a later run
can recognise them. The record grows with every run. Near GitHub's limit of 65,536 characters
PR-Agent has two ways out, and neither one fails the run:

- the record plus the review no longer fit, so the visible review is cut to make room for the
  record (no log line at all), or
- the record alone no longer fits, so it is not advanced any more (one warning in the log) and the
  review is posted with the old record, or as a "Standalone PR Review" without any record.

Either way findings are lost without an error. The one function that does the shortening,
`append_review_state` (called by the review tool with a character limit), is wrapped here to record
that it happened. The wrapper only observes: the result, and the error PR-Agent expects, are the
original ones.
"""

import inspect
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

_FUNCTION = "append_review_state"
_EXPECTED_PARAMETERS = ["review_body", "state", "max_chars"]


class WatchError(Exception):
    """The function the watch relies on is not what the runner was written for."""


@dataclass
class ReviewStateWatch:
    # The hidden record of findings did not fit: it was not advanced (findings seen in this run are
    # not recorded), and the review was posted with the old record or without any.
    state_did_not_fit: bool = False
    # The visible review was cut so that the record fits into the comment.
    text_cut: bool = False


def install_review_state_watch(
    module: Any | None = None,
) -> tuple[ReviewStateWatch, Callable[[], None]]:
    """Wrap `append_review_state` of the review tool. Returns the watch and an undo function."""
    if module is None:
        from pr_agent.tools import pr_reviewer as module
    found: Any = getattr(module, _FUNCTION, None)
    if not callable(found):
        raise WatchError(f"{_FUNCTION} does not exist in the review tool")
    original: Callable[..., Any] = found
    parameters = list(inspect.signature(original).parameters)
    if parameters != _EXPECTED_PARAMETERS:
        raise WatchError(
            f"{_FUNCTION} has different parameters: expected {_EXPECTED_PARAMETERS}, "
            f"found {parameters}"
        )

    watch = ReviewStateWatch()

    def append_review_state(review_body: str, state: Any, max_chars: int | None = None) -> str:
        try:
            result = str(original(review_body, state, max_chars))
        except ValueError:
            # An invalid state raises the same error; only a state that fits without a limit was
            # refused for its size.
            if max_chars is not None and _fits_without_limit(original, review_body, state):
                watch.state_did_not_fit = True
            raise
        if max_chars is not None:
            whole = _without_limit(original, review_body, state)
            if whole is not None and len(whole) > len(result):
                watch.text_cut = True
        return result

    setattr(module, _FUNCTION, append_review_state)

    def undo() -> None:
        setattr(module, _FUNCTION, original)

    return watch, undo


def _without_limit(original: Callable[..., Any], review_body: str, state: Any) -> str | None:
    try:
        return str(original(review_body, state, None))
    except Exception:
        return None  # observing must never break the review


def _fits_without_limit(original: Callable[..., Any], review_body: str, state: Any) -> bool:
    return _without_limit(original, review_body, state) is not None
