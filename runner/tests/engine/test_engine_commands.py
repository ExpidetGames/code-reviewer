# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down what the real PR-Agent posts for `/review` through the real job entry point against the
fake GitHub and the fake LLM: who posts, where, and what the result JSON says. The removed commands
(`/ask`, `/improve`, `/describe`, #203) no longer run. The canned model answers are not judged, only
the shape and the place of the output."""

from fake_github import BOT_LOGIN, FakeGithub
from harness import Engine


# CR-41-T01
def test_a_review_is_posted_as_the_bot_and_reported_with_its_url(
    engine: Engine, github: FakeGithub
) -> None:
    outcome = engine.run("review")

    assert outcome.returncode == 0
    assert len(github.comments) == 1
    comment = github.comments[0]
    assert comment.login == BOT_LOGIN
    assert "<!-- pr-agent:review:full -->" in comment.body
    assert github.requests_to("GET", "/user") == []
    result = outcome.result
    assert result["ok"] is True
    assert result["errorCode"] is None
    assert result["commentUrl"] == github.comment_url(comment)
