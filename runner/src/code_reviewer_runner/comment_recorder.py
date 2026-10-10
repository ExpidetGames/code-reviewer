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
_REVIEW_IDENTITIES = (
    "<!-- pr-agent:review:full -->",
    "<!-- pr-agent:review:incremental -->",
    "## PR Reviewer Guide",
    "## Incremental PR Reviewer Guide",
)
_IMPROVE_IDENTITIES = (
    "<!-- pr-agent:improve:summary -->",
    "## PR Code Suggestions",
)
# The tools publish these when a command fails but they still return normally.
_FAILURE_PREFIXES = ("Failed to ",)
# The small "updated to latest commit" comment next to an edited review; never the result.
_STATUS_PREFIXES = ("**[Persistent",)


@dataclass(frozen=True)
class CommentEvent:
    kind: Literal["created", "edited"]
    url: str
    body_head: str
    temporary: bool


@dataclass
class CommentRecorder:
    events: list[CommentEvent] = field(default_factory=lambda: [])

    def add(self, *, kind: str, url: str, body: str, temporary: bool) -> None:
        self.events.append(
            CommentEvent(
                kind="edited" if kind == "edited" else "created",
                url=url,
                body_head=body[:BODY_HEAD_CHARS],
                temporary=temporary,
            )
        )

    def failure_comment_posted(self) -> bool:
        return any(
            event.body_head.startswith(_FAILURE_PREFIXES)
            for event in self.events
            if not event.temporary
        )

    def comment_url(self, command: Command) -> str | None:
        """URL of the comment that holds the result of `command`, or None."""
        candidates = [
            event
            for event in self.events
            if not event.temporary
            and not event.body_head.startswith(_FAILURE_PREFIXES + _STATUS_PREFIXES)
        ]
        if command is Command.DESCRIBE:
            return None
        if command is Command.ASK:
            return candidates[-1].url if candidates else None
        identities = _REVIEW_IDENTITIES if command is Command.REVIEW else _IMPROVE_IDENTITIES
        for event in reversed(candidates):
            if any(identity in event.body_head for identity in identities):
                return event.url
        return None


def _url_of(comment: Any) -> str | None:
    url = getattr(comment, "html_url", None)
    return url if isinstance(url, str) and url else None


def _record(recorder: CommentRecorder, kind: str, comment: Any, body: Any, temporary: bool) -> None:
    """Record one write. Observing must never break the write itself, so errors are swallowed."""
    try:
        url = _url_of(comment)
        if url is not None:
            recorder.add(kind=kind, url=url, body=str(body), temporary=bool(temporary))
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
        _record(recorder, "created", result, pr_comment, is_temporary)
        return result

    def edit_comment(self: Any, comment: Any, body: str) -> Any:
        result = original_edit(self, comment, body)
        # edit_comment returns None on success and False on failure.
        if result is not False:
            _record(
                recorder, "edited", comment, body, bool(getattr(comment, "is_temporary", False))
            )
        return result

    provider_class.publish_comment = publish_comment
    provider_class.edit_comment = edit_comment

    def uninstall() -> None:
        provider_class.publish_comment = original_publish
        provider_class.edit_comment = original_edit

    return recorder, uninstall
