# SPDX-License-Identifier: Apache-2.0

"""Records the comments PR-Agent writes, to find the URL of the result.

`PRAgent.handle_request` only returns True or False and no tool returns what it posted. All comment
writes of the GitHub provider go through two methods, `publish_comment` (create) and `edit_comment`
(update, which is what a second review of the same pull request does). The recorder wraps both on
the class, so it also covers the provider instances PR-Agent creates on its own (the `ask` tool).
It observes only: the original result is always returned unchanged, and a recording problem never
turns into a failed write.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from code_reviewer_runner.job import Command

BODY_HEAD_CHARS = 600
# Only the hidden marker identifies a comment, as PR-Agent itself does (`comment_matches_identity`):
# an exact line within the first lines. The visible heading is configurable, and the "Standalone PR
# Review" comment that PR-Agent posts when it cannot verify its identity keeps the heading but drops
# the marker, so a heading would turn a non-authoritative comment into the result.
_REVIEW_MARKERS = (
    "<!-- pr-agent:review:full -->",
    "<!-- pr-agent:review:incremental -->",
)
_IMPROVE_MARKERS = ("<!-- pr-agent:improve:summary -->",)
_MARKER_LINES = 5
# The tools publish these when a command fails but they still return normally.
_FAILURE_PREFIXES = ("Failed to ",)


@dataclass(frozen=True)
class CommentEvent:
    kind: Literal["created", "edited"]
    url: str
    body_head: str
    temporary: bool
    # The body was longer than the provider accepts, so the provider cut it when it wrote it.
    over_limit: bool = False


@dataclass
class CommentRecorder:
    events: list[CommentEvent] = field(default_factory=lambda: [])

    def add(
        self, *, kind: str, url: str, body: str, temporary: bool, limit: int | None = None
    ) -> None:
        self.events.append(
            CommentEvent(
                kind="edited" if kind == "edited" else "created",
                url=url,
                body_head=body[:BODY_HEAD_CHARS],
                temporary=temporary,
                over_limit=limit is not None and len(body) > limit,
            )
        )

    def failure_comment_posted(self) -> bool:
        return any(
            event.body_head.startswith(_FAILURE_PREFIXES)
            for event in self.events
            if not event.temporary
        )

    def failure_comment_texts(self) -> list[str]:
        """The failure comments PR-Agent posted, for classification only (never printed)."""
        return [
            event.body_head
            for event in self.events
            if not event.temporary and event.body_head.startswith(_FAILURE_PREFIXES)
        ]

    def cut_comment_posted(self) -> bool:
        """A comment (not a failure notice) was longer than the provider takes and was cut."""
        return any(
            event.over_limit
            for event in self.events
            if not event.temporary and not event.body_head.startswith(_FAILURE_PREFIXES)
        )

    def comment_url(self, command: Command) -> str | None:
        """URL of the comment that holds the result of `command`, or None."""
        candidates = [
            event
            for event in self.events
            if not event.temporary and not event.body_head.startswith(_FAILURE_PREFIXES)
        ]
        if command is Command.DESCRIBE:
            return None
        if command is Command.ASK:
            return candidates[-1].url if candidates else None
        markers = _REVIEW_MARKERS if command is Command.REVIEW else _IMPROVE_MARKERS
        for event in reversed(candidates):
            if _carries_marker(event.body_head, markers):
                return event.url
        return None


def _carries_marker(body: str, markers: tuple[str, ...]) -> bool:
    """True if one of the first lines is exactly a marker or its link-reference form."""
    from pr_agent.algo.comment_identity import hidden_marker_forms  # loaded by now, see runner.py

    forms = {form for marker in markers for form in hidden_marker_forms(marker)}
    return any(line.strip() in forms for line in body.splitlines()[:_MARKER_LINES])


def _url_of(comment: Any) -> str | None:
    url = getattr(comment, "html_url", None)
    return url if isinstance(url, str) and url else None


def _limit_of(provider: Any) -> int | None:
    limit = getattr(provider, "max_comment_chars", None)
    return limit if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0 else None


def _record(
    recorder: CommentRecorder,
    kind: str,
    comment: Any,
    body: Any,
    temporary: bool,
    limit: int | None = None,
) -> None:
    """Record one write. Observing must never break the write itself, so errors are swallowed."""
    try:
        url = _url_of(comment)
        if url is not None:
            recorder.add(kind=kind, url=url, body=str(body), temporary=bool(temporary), limit=limit)
    except Exception:
        return


def install_comment_recorder(
    provider_class: type[Any] | None = None,
) -> tuple[CommentRecorder, Callable[[], None]]:
    """Wrap the write paths of the GitHub provider; Returns the recorder and an undo function."""
    if provider_class is None:
        from pr_agent.git_providers.github_provider import GithubProvider

        provider_class = GithubProvider
    recorder = CommentRecorder()
    original_publish = provider_class.publish_comment
    original_edit = provider_class.edit_comment

    def publish_comment(self: Any, pr_comment: str, is_temporary: bool = False) -> Any:
        result = original_publish(self, pr_comment, is_temporary)
        _record(recorder, "created", result, pr_comment, is_temporary, _limit_of(self))
        return result

    def edit_comment(self: Any, comment: Any, body: str) -> Any:
        result = original_edit(self, comment, body)
        # edit_comment returns None on success and False on failure.
        if result is not False:
            _record(
                recorder,
                "edited",
                comment,
                body,
                bool(getattr(comment, "is_temporary", False)),
                _limit_of(self),
            )
        return result

    provider_class.publish_comment = publish_comment
    provider_class.edit_comment = edit_comment

    def uninstall() -> None:
        provider_class.publish_comment = original_publish
        provider_class.edit_comment = original_edit

    return recorder, uninstall
