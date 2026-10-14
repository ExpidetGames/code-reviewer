# SPDX-License-Identifier: Apache-2.0

"""The re-read after an ambiguous edit recognises only the bot's own byte-for-byte write (#255)."""

import pytest

from code_reviewer_runner.dynamic_review.github import Comment, GitHubError
from code_reviewer_runner.dynamic_review.publish import Published, Publisher, PublishError
from code_reviewer_runner.result import ErrorCode

BOT = "code-reviewer[bot]"
BODY = "<!-- code-reviewer:dynamic -->\nthe body we sent"


class LostEditClient:
    """An edit that raises as if the answer were lost, and a re-read that lists `comments`."""

    def __init__(self, comments: list[Comment]) -> None:
        self.comments = comments

    def list_comments(self, pr_number: int) -> list[Comment]:
        return self.comments

    def create_comment(self, pr_number: int, body: str) -> Comment:
        raise AssertionError("no create expected")

    def edit_comment(self, comment_id: str, body: str) -> Comment:
        raise GitHubError(ErrorCode.GIT_UNAVAILABLE, "edit comment")


def _comment(*, author: str, author_type: str, body: str = BODY) -> Comment:
    return Comment(
        id="7",
        body=body,
        author=author,
        url="https://github.test/acme/widgets/pull/1#issuecomment-7",
        updated_at="2026-10-10T00:00:00Z",
        author_type=author_type,
    )


def _edit(comments: list[Comment]) -> Published:
    # The re-read is private to the publisher and only reached through a lost edit; the unit test
    # drives the edit step directly with a client that loses the answer.
    return _publisher(comments)._edit("7", BODY)  # pyright: ignore[reportPrivateUsage]


def _publisher(comments: list[Comment]) -> Publisher:
    return Publisher(
        client=LostEditClient(comments),
        bot_login=BOT,
        repository="acme/widgets",
        pr_number=1,
    )


def test_the_bot_comment_holding_exactly_the_sent_body_counts_as_landed() -> None:
    found = _edit([_comment(author=BOT, author_type="Bot")])

    assert found.created is False


@pytest.mark.parametrize(
    "comment",
    [
        # Same id and same body, but not the bot's: never recognised as our own write.
        _comment(author="mallory", author_type="User"),
        _comment(author=BOT, author_type="User"),
        # The bot's, but not exactly what we sent.
        _comment(author=BOT, author_type="Bot", body=BODY + "\nedited"),
    ],
)
def test_a_comment_that_is_not_the_bots_exact_write_is_a_failure(comment: Comment) -> None:
    with pytest.raises(PublishError) as refused:
        _edit([comment])

    assert refused.value.code is ErrorCode.GIT_UNAVAILABLE
