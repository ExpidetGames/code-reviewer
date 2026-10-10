"""Pins down what happens when a review is as long as GitHub allows a comment to be (65,536
characters; the fake refuses longer ones with a 422 like GitHub does).

PR-Agent cuts a comment at 65,000 characters. A review that fits with its hidden review state is
posted and later edited in place. A review so long that the state no longer fits is posted without
its marker: PR-Agent cannot find it again, so every run posts another copy, and the job reports
`review_not_published` although a (cut) review is on the pull request. The second test documents
that behaviour as it is today; it is the groundwork for the ticket that changes it, and that
ticket changes the test with it.

The second test pins a bug, not a wish: it is expected to change in CR-49."""

import canned
from fake_github import MAX_COMMENT_CHARS, FakeGithub
from fake_llm import FakeLlm
from harness import Engine

REVIEW_MARKER = "<!-- pr-agent:review:full -->"
PADDING_PLACEHOLDER = "The helper formats the name without checking it ({marker})."


def review_of_size(marker: str, characters: int) -> str:
    text = canned.review(marker)
    return text.replace(PADDING_PLACEHOLDER.format(marker=marker), "x" * characters)


# CR-49-T05
def test_a_review_near_the_comment_limit_is_posted_and_edited_in_place(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.replies["review"] = review_of_size("first run", 64_000)
    first = engine.run("review")
    posted = github.comments[0]
    llm.replies["review"] = review_of_size("second run", 64_000)

    second = engine.run("review")

    assert first.result["ok"] is True
    assert second.result["ok"] is True
    assert [comment.id for comment in github.comments] == [posted.id]
    assert REVIEW_MARKER in github.comments[0].body
    assert len(github.comments[0].body) <= MAX_COMMENT_CHARS
    assert github.refused_too_long == 0
    assert second.result["commentUrl"] == first.result["commentUrl"]


# CR-49-T05 (EXPECTED TO CHANGE IN CR-49: it asserts today's behaviour, which CR-49 replaces)
def test_today_a_review_beyond_the_comment_limit_is_cut_posted_without_its_marker_and_not_reported(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.replies["review"] = review_of_size("first run", 70_000)

    first = engine.run("review")
    second = engine.run("review")

    # CR-49: expected to change. After the fix a review of this size is published and found again.
    for outcome in (first, second):
        assert outcome.returncode != 0
        assert outcome.result["ok"] is False
        assert outcome.result["errorCode"] == "review_not_published"
        assert outcome.result["commentUrl"] is None
    # A cut copy on the pull request after each run, none of them recognised as the review.
    assert len(github.comments) == 2
    assert all(len(comment.body) <= MAX_COMMENT_CHARS for comment in github.comments)
    assert all(REVIEW_MARKER not in comment.body for comment in github.comments)
    assert github.refused_too_long == 0
