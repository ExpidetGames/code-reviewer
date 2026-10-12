# SPDX-License-Identifier: Apache-2.0

"""Pins down what happens when a review is as long as GitHub allows a comment to be (65,536
characters; the fake refuses longer ones with a 422 like GitHub does).

PR-Agent cuts a comment at 65,000 characters and keeps a hidden record of every finding in it. A
review that fits with its record is posted and later edited in place. When the record grows past
the limit PR-Agent does not fail: it cuts the visible review, or stops advancing the record, or
posts a standalone copy without its marker. The runner must not call that a success: it reports
`review_state_truncated` (the record did not fit) or `review_text_truncated` (the visible review
was cut), keeps the link to the review comment when there is one, and the other runs go on editing
it."""

import canned
from fake_github import MAX_COMMENT_CHARS, FakeGithub
from fake_llm import FakeLlm
from harness import Engine, visible_text

REVIEW_MARKER = "<!-- pr-agent:review:full -->"
PADDING_PLACEHOLDER = "The helper formats the name without checking it ({marker})."
DID_NOT_FIT = "Persistent review state did not fit the provider comment limit"


def review_of_size(marker: str, characters: int) -> str:
    text = canned.review(marker)
    return text.replace(PADDING_PLACEHOLDER.format(marker=marker), "x" * characters)


# CR-49-T03
def test_a_review_with_room_to_spare_is_posted_and_edited_in_place(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.replies["review"] = review_of_size("first run", 15_000)
    first = engine.run("review")
    posted = github.comments[0]
    llm.replies["review"] = review_of_size("second run", 15_000)

    second = engine.run("review")

    assert first.result["ok"] is True
    assert second.result["ok"] is True
    assert first.result["errorCode"] is None
    assert [comment.id for comment in github.comments] == [posted.id]
    assert REVIEW_MARKER in github.comments[0].body
    assert len(github.comments[0].body) <= MAX_COMMENT_CHARS
    assert github.refused_too_long == 0
    assert second.result["commentUrl"] == first.result["commentUrl"]


# CR-49-T05
def test_a_review_that_only_fits_because_the_visible_text_is_cut_to_almost_nothing_is_reported(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    # The record carries the whole finding (64,000 characters) and takes nearly all of the comment;
    # PR-Agent keeps it and shrinks the visible review to a few hundred characters, without a word.
    llm.replies["review"] = review_of_size("first run", 64_000)

    outcome = engine.run("review")

    assert outcome.returncode != 0
    assert outcome.result["ok"] is False
    assert outcome.result["errorCode"] == "review_text_truncated"
    assert len(github.comments) == 1
    assert REVIEW_MARKER in github.comments[0].body
    assert outcome.result["commentUrl"] == github.comment_url(github.comments[0])
    assert len(visible_text(github.comments[0].body)) < 1_000


# CR-49-T05
def test_a_review_whose_record_cannot_fit_is_reported_as_truncated_state_on_every_run(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    # One finding of 70,000 characters: the record alone is beyond the comment limit, and there is
    # no earlier record to keep, so PR-Agent posts a standalone copy without the marker each time.
    llm.replies["review"] = review_of_size("first run", 70_000)

    first = engine.run("review")
    second = engine.run("review")

    for outcome in (first, second):
        assert outcome.returncode != 0
        assert outcome.result["ok"] is False
        assert outcome.result["errorCode"] == "review_state_truncated"
        assert outcome.result["commentUrl"] is None
        assert DID_NOT_FIT in outcome.result["logTail"]
    # A cut copy on the pull request after each run, none of them found again by the next run.
    assert len(github.comments) == 2
    assert all(len(comment.body) <= MAX_COMMENT_CHARS for comment in github.comments)
    assert all(REVIEW_MARKER not in comment.body for comment in github.comments)
    assert github.refused_too_long == 0


# CR-49-T05
def test_a_record_that_outgrows_the_comment_over_several_runs_is_reported_from_that_run_on(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    # The record of findings is the sum of all runs, 15 new findings each. Runs 1 and 2 fit (run 2
    # only by cutting the visible review); in run 3 the record alone is beyond the limit, PR-Agent
    # keeps the record of run 2 and ends the run as if all was well.
    llm.replies["review"] = canned.review_with_findings("a", 15, 1500)
    first = engine.run("review")
    posted = github.comments[0]
    llm.replies["review"] = canned.review_with_findings("b", 15, 1500)
    second = engine.run("review")
    llm.replies["review"] = canned.review_with_findings("c", 15, 1500)

    third = engine.run("review")
    fourth = engine.run("review")

    assert first.result["ok"] is True
    assert second.result["errorCode"] == "review_text_truncated"
    for outcome in (third, fourth):
        assert outcome.returncode != 0
        assert outcome.result["ok"] is False
        assert outcome.result["errorCode"] == "review_state_truncated"
        # The review comment is still the one comment on the pull request, and the result says so.
        assert outcome.result["commentUrl"] == first.result["commentUrl"]
        assert DID_NOT_FIT in outcome.result["logTail"]
    assert [comment.id for comment in github.comments] == [posted.id]
    assert REVIEW_MARKER in github.comments[0].body
    assert github.refused_too_long == 0


# CR-49-T05
def test_a_visible_review_that_is_cut_to_make_room_for_the_record_is_reported(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    # The record still fits after run 2, so PR-Agent logs nothing; the room left for the visible
    # review is a few thousand characters of the 30,000 it would take.
    llm.replies["review"] = canned.review_with_findings("a", 10, 2800)
    first = engine.run("review")
    llm.replies["review"] = canned.review_with_findings("b", 10, 2800)

    second = engine.run("review")

    assert first.result["ok"] is True
    assert second.returncode != 0
    assert second.result["ok"] is False
    assert second.result["errorCode"] == "review_text_truncated"
    assert second.result["commentUrl"] == first.result["commentUrl"]
    assert DID_NOT_FIT not in second.result["logTail"]
    assert len(github.comments) == 1
    assert REVIEW_MARKER in github.comments[0].body
