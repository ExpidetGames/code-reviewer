# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the identity patch against the real GitHub provider of PR-Agent: a second review of
the same pull request edits the first comment of the bot instead of posting a duplicate, although
`GET /user` is forbidden for an installation token. And pins down that the suite notices when the
patch does not take effect, because the result would then be wrong in a way that looks fine."""

import canned
from fake_github import BOT_LOGIN, FakeGithub
from fake_llm import FakeLlm
from harness import Engine, visible_text

REVIEW_MARKER = "<!-- pr-agent:review:full -->"


# CR-41-T05, CR-30-T08
def test_a_second_review_edits_the_first_comment_instead_of_posting_another(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    first = engine.run("review")
    first_comment = github.comments[0]
    llm.replies["review"] = canned.review("second run")

    second = engine.run("review")

    assert first.result["ok"] is True
    assert second.returncode == 0
    assert [comment.id for comment in github.comments] == [first_comment.id]
    edited = github.comments[0]
    assert REVIEW_MARKER in edited.body
    # The first finding stays in the hidden review state, so only the visible text is compared.
    assert "second run" in visible_text(edited.body)
    assert "first run" not in visible_text(edited.body)
    posts = github.requests_to("POST", r"/repos/octo/widgets/issues/7/comments")
    patches = github.requests_to(
        "PATCH", rf"/repos/octo/widgets/issues/comments/{first_comment.id}"
    )
    assert (len(posts), len(patches)) == (1, 1)
    assert github.requests_to("GET", "/user") == []
    result = second.result
    assert result["ok"] is True
    assert result["commentUrl"] == first.result["commentUrl"] == github.comment_url(edited)
    assert not any(comment.body.startswith("Failed to") for comment in github.comments)


# CR-41-T06
def test_a_second_review_without_the_identity_patch_is_reported_as_not_published(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    # PR-Agent's own answer to "I cannot tell which comment is mine" is to post a standalone copy
    # and return normally, so `handle_request` says True. The result must still say that the review
    # was not published, and must not name the standalone copy as the review.
    engine.run("review")
    existing = github.comments[0]
    body_before = existing.body
    llm.replies["review"] = canned.review("second run")

    outcome = engine.run("review", identity_patch=False)

    assert outcome.returncode != 0
    result = outcome.result
    assert result["ok"] is False
    assert result["errorCode"] == "review_not_published"
    assert result["commentUrl"] is None
    assert github.requests_to("GET", "/user") != []
    assert github.comments[0].id == existing.id
    assert github.comments[0].body == body_before
    assert all(comment.login == BOT_LOGIN for comment in github.comments)
