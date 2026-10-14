# SPDX-License-Identifier: Apache-2.0

"""Pins down the comment recorder: PR-Agent returns no URL of what it posted, so the runner wraps
the two write paths of the GitHub provider (create and edit a comment) and picks the review comment
from what was recorded, by the hidden marker PR-Agent puts into its own comments. `/review` is the
only command (the product removed `/ask`, `/improve` and `/describe`)."""

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from pr_agent.git_providers.github_provider import GithubProvider

from code_reviewer_runner.comment_recorder import (
    CommentRecorder,
    install_comment_recorder,
)

REVIEW_MARKER = "<!-- pr-agent:review:full -->"


@dataclass
class StubComment:
    html_url: str
    body: str = ""
    is_temporary: bool = False


class StubPull:
    """The PyGithub pull request: creating an issue comment returns a comment with a URL."""

    def __init__(self) -> None:
        self.created = 0

    def create_issue_comment(self, body: str) -> StubComment:
        self.created += 1
        return StubComment(html_url=f"https://github.com/o/r/pull/1#issuecomment-{self.created}")


class FailingEdit(StubComment):
    def edit(self, body: str) -> None:
        raise OSError("not used: edit_comment is replaced in this test")


@pytest.fixture
def recorder() -> Iterator[CommentRecorder]:
    recorder, uninstall = install_comment_recorder()
    try:
        yield recorder
    finally:
        uninstall()


def provider_with_pull() -> Any:  # Any: PR-Agent's provider methods are untyped
    instance = object.__new__(GithubProvider)
    instance.pr = StubPull()  # type: ignore[assignment]
    instance.issue_main = None
    instance.max_comment_chars = 65000
    return instance


def test_a_created_comment_is_recorded_with_its_url_and_the_start_of_its_body(
    recorder: CommentRecorder,
) -> None:
    provider = provider_with_pull()

    created = provider.publish_comment(f"## PR Reviewer Guide\n\n{REVIEW_MARKER}\n\nbody")

    assert created is not None
    assert len(recorder.events) == 1
    event = recorder.events[0]
    assert event.kind == "created"
    assert event.url == "https://github.com/o/r/pull/1#issuecomment-1"
    assert REVIEW_MARKER in event.body_head
    assert event.temporary is False


def test_the_original_return_value_of_publish_comment_is_unchanged(
    recorder: CommentRecorder,
) -> None:
    provider = provider_with_pull()

    created = provider.publish_comment("hello")

    assert isinstance(created, StubComment)
    assert recorder.events[0].url == created.html_url


def test_an_edited_comment_is_recorded_with_the_url_of_the_edited_comment(
    recorder: CommentRecorder,
) -> None:
    class Editable(StubComment):
        def edit(self, body: str) -> None:
            self.body = body

    comment = Editable(html_url="https://github.com/o/r/pull/1#issuecomment-99")
    provider = provider_with_pull()

    result = provider.edit_comment(comment, f"## PR Reviewer Guide\n\n{REVIEW_MARKER}\n\nnew")

    assert result is None
    assert comment.body.endswith("new")
    assert recorder.events[0].kind == "edited"
    assert recorder.events[0].url == "https://github.com/o/r/pull/1#issuecomment-99"


def test_a_failed_edit_is_not_recorded_as_a_published_comment(recorder: CommentRecorder) -> None:
    from github import GithubException

    class Rejecting(StubComment):
        def edit(self, body: str) -> None:
            raise GithubException(403, {"message": "no"}, {})

    provider = provider_with_pull()

    result = provider.edit_comment(Rejecting(html_url="https://github.com/o/r/pull/1#c"), "x")

    assert result is False
    assert recorder.events == []


def test_uninstalling_restores_the_original_methods() -> None:
    provider_class: Any = GithubProvider  # Any: PR-Agent's provider methods are untyped
    original_publish = provider_class.publish_comment
    original_edit = provider_class.edit_comment

    _, uninstall = install_comment_recorder()
    assert provider_class.publish_comment is not original_publish
    uninstall()

    assert provider_class.publish_comment is original_publish
    assert provider_class.edit_comment is original_edit


def test_recording_never_breaks_the_write_it_observes(recorder: CommentRecorder) -> None:
    class NoUrl:
        pass

    class PullWithoutUrl:
        def create_issue_comment(self, body: str) -> NoUrl:
            return NoUrl()

    provider = provider_with_pull()
    provider.pr = PullWithoutUrl()  # type: ignore[assignment]

    created = provider.publish_comment("hello")

    assert isinstance(created, NoUrl)
    assert recorder.events == []


def record(
    recorder: CommentRecorder, kind: str, url: str, body: str, temporary: bool = False
) -> None:
    recorder.add(kind=kind, url=url, body=body, temporary=temporary)


# CR-10-T12 (the URL that goes into the result)
def test_the_review_comment_is_picked_by_its_marker_and_the_status_comment_is_ignored(
    recorder: CommentRecorder,
) -> None:
    record(recorder, "created", "https://x/review", f"## PR Reviewer Guide 🔍\n\n{REVIEW_MARKER}\n")
    record(
        recorder, "created", "https://x/status", "**[Persistent review](https://x/review)** updated"
    )

    assert recorder.comment_url() == "https://x/review"


def test_the_last_edit_of_the_review_wins(recorder: CommentRecorder) -> None:
    record(recorder, "created", "https://x/first", f"{REVIEW_MARKER}\nold")
    record(recorder, "edited", "https://x/second", f"{REVIEW_MARKER}\nnew")

    assert recorder.comment_url() == "https://x/second"


# CR-12 review finding: the heading alone is no identity (it is configurable, and PR-Agent keeps it
# in a standalone comment that does not replace the canonical review).
def test_a_review_heading_without_the_hidden_marker_is_not_the_result(
    recorder: CommentRecorder,
) -> None:
    record(recorder, "created", "https://x/review", "## PR Reviewer Guide 🔍\n\ntext")
    record(recorder, "created", "https://x/incremental", "## Incremental PR Reviewer Guide 🔍\n\nx")

    assert recorder.comment_url() is None


def test_the_standalone_review_of_pr_agent_is_not_the_result_but_the_canonical_review_is(
    recorder: CommentRecorder,
) -> None:
    from pr_agent.tools.pr_reviewer import PRReviewer

    canonical = f"## PR Reviewer Guide 🔍\n\n{REVIEW_MARKER}\n\nHere are some key observations"
    standalone = PRReviewer._as_non_authoritative_review(canonical)  # pyright: ignore[reportPrivateUsage]
    assert standalone.startswith("## Standalone PR Review")

    record(recorder, "created", "https://x/standalone", standalone)
    assert recorder.comment_url() is None

    record(recorder, "edited", "https://x/canonical", canonical)
    assert recorder.comment_url() == "https://x/canonical"


def test_the_marker_counts_only_as_an_exact_line_near_the_top(recorder: CommentRecorder) -> None:
    far_down = "intro\n\n\n\n\n\n" + REVIEW_MARKER
    record(recorder, "created", "https://x/quoted", f"text quoting {REVIEW_MARKER} inline")
    record(recorder, "created", "https://x/far", far_down)

    assert recorder.comment_url() is None


def test_the_link_reference_form_of_the_marker_is_accepted(recorder: CommentRecorder) -> None:
    from pr_agent.algo.comment_identity import hidden_marker_forms

    reference = hidden_marker_forms(REVIEW_MARKER)[-1]
    assert reference != REVIEW_MARKER
    record(recorder, "created", "https://x/review", f"## PR Reviewer Guide 🔍\n\n{reference}\n\nx")

    assert recorder.comment_url() == "https://x/review"


def test_no_comment_url_when_nothing_matching_was_posted(recorder: CommentRecorder) -> None:
    assert recorder.comment_url() is None

    record(recorder, "created", "https://x/other", "unrelated")
    assert recorder.comment_url() is None


def test_a_failure_comment_is_detected_and_never_chosen_as_the_result(
    recorder: CommentRecorder,
) -> None:
    record(recorder, "created", "https://x/failed", "Failed to review PR: boom")

    assert recorder.failure_comment_posted() is True
    assert recorder.comment_url() is None


def test_no_failure_comment_in_a_healthy_run(recorder: CommentRecorder) -> None:
    record(recorder, "created", "https://x/review", f"{REVIEW_MARKER}\nbody")

    assert recorder.failure_comment_posted() is False


# CR-49-T02 (a comment longer than GitHub takes is cut by the provider when it is written)
def test_a_comment_longer_than_the_provider_limit_is_recorded_as_cut(
    recorder: CommentRecorder,
) -> None:
    provider = provider_with_pull()

    provider.publish_comment(f"{REVIEW_MARKER}\n" + "x" * 70_000)

    assert recorder.cut_comment_posted() is True


def test_a_comment_that_fits_the_provider_limit_is_not_recorded_as_cut(
    recorder: CommentRecorder,
) -> None:
    provider = provider_with_pull()

    provider.publish_comment(f"{REVIEW_MARKER}\n" + "x" * 64_000)

    assert recorder.cut_comment_posted() is False


def test_an_edit_beyond_the_provider_limit_is_recorded_as_cut(recorder: CommentRecorder) -> None:
    class Editable(StubComment):
        def edit(self, body: str) -> None:
            self.body = body

    provider = provider_with_pull()

    provider.edit_comment(
        Editable(html_url="https://x/review"), f"{REVIEW_MARKER}\n" + "x" * 66_000
    )

    assert recorder.cut_comment_posted() is True


def test_a_failure_comment_beyond_the_limit_is_not_a_cut_review(recorder: CommentRecorder) -> None:
    provider = provider_with_pull()

    provider.publish_comment("Failed to review PR: " + "x" * 70_000)

    assert recorder.cut_comment_posted() is False
