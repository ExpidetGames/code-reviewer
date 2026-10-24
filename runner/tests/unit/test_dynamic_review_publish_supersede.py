# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Dynamic summary is not written once the run was superseded, checked right before the write
(#396). The window between the decision and the write is as small as the one call allows; what
stays open is a signal that arrives after the check (the README says so)."""

import pytest

from code_reviewer_runner.dynamic_review.failure_note import failure_note_for
from code_reviewer_runner.dynamic_review.github import Comment
from code_reviewer_runner.dynamic_review.publish import Publisher, PublishError
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.unit

HEAD = "a" * 40


class Client:
    """Reads nothing, records every write. `on_read` runs while the comments are read."""

    def __init__(self, on_read: object = None) -> None:
        self.writes: list[str] = []
        self._on_read = on_read

    def list_comments(self, pr_number: int) -> list[Comment]:
        if callable(self._on_read):
            self._on_read()
        return []

    def create_comment(self, pr_number: int, body: str) -> Comment:
        self.writes.append("create")
        return Comment(
            id="1",
            body=body,
            author="code-reviewer[bot]",
            url="https://github.test/acme/widgets/pull/1#issuecomment-1",
            updated_at="2026-10-10T00:00:00Z",
            author_type="Bot",
        )

    def edit_comment(self, comment_id: str, body: str) -> Comment:
        self.writes.append("edit")
        raise AssertionError("no edit expected")


def _publish_note(client: Client, may_write: object) -> None:
    note = failure_note_for(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, None, HEAD)
    assert note is not None
    publisher = Publisher(
        client=client,
        bot_login="code-reviewer[bot]",
        repository="acme/widgets",
        pr_number=1,
        may_write=may_write,  # type: ignore[arg-type]
    )
    publisher.publish_failure(note, head_sha=HEAD, previous_reviewed_sha=None)


# #396-T10
def test_a_run_superseded_while_the_comments_are_read_writes_nothing() -> None:
    superseded = False

    def hear_of_the_push() -> None:
        nonlocal superseded
        superseded = True

    client = Client(on_read=hear_of_the_push)

    with pytest.raises(PublishError) as refused:
        _publish_note(client, lambda: not superseded)

    assert refused.value.code is ErrorCode.SUPERSEDED
    assert client.writes == []


# #396-T10
def test_a_run_that_is_still_ours_writes_once() -> None:
    client = Client()

    _publish_note(client, lambda: True)

    assert client.writes == ["create"]
