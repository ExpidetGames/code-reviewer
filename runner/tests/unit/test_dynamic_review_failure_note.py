# SPDX-License-Identifier: LicenseRef-Proprietary

"""The failure note in the persistent Dynamic summary comment (#299): content, update behaviour and
the table that gives every note code its one fixed sentence."""

import re
from dataclasses import dataclass, field

import pytest

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.failure_note import (
    FAILURE_SENTENCES,
    NO_NOTE_CODES,
    failure_note_for,
)
from code_reviewer_runner.dynamic_review.github import Comment
from code_reviewer_runner.dynamic_review.limits import CheckoutReason
from code_reviewer_runner.dynamic_review.publish import IDENTITY_MARKER, Publisher, PublishError
from code_reviewer_runner.dynamic_review.state import decode_state
from code_reviewer_runner.result import ErrorCode

BOT = "code-reviewer[bot]"
SHA = "1" * 40
NEXT = "2" * 40
THIRD = "3" * 40


@dataclass
class MemoryComments:
    """An in-memory comment API: what the publisher sees and writes, nothing else."""

    comments: list[Comment] = field(default_factory=lambda: [])
    creates: int = 0
    edits: int = 0

    def list_comments(self, pr_number: int) -> list[Comment]:
        return list(self.comments)

    def create_comment(self, pr_number: int, body: str) -> Comment:
        self.creates += 1
        created = self._comment(str(len(self.comments) + 1), body)
        self.comments.append(created)
        return created

    def edit_comment(self, comment_id: str, body: str) -> Comment:
        self.edits += 1
        for index, comment in enumerate(self.comments):
            if comment.id == comment_id:
                self.comments[index] = self._comment(comment_id, body)
                return self.comments[index]
        raise AssertionError("no such comment")

    @staticmethod
    def _comment(comment_id: str, body: str) -> Comment:
        return Comment(
            id=comment_id,
            body=body,
            author=BOT,
            url=f"https://github.test/acme/widgets/pull/1#issuecomment-{comment_id}",
            updated_at="2026-10-15T00:00:00Z",
            author_type="Bot",
        )


def publisher_for(client: MemoryComments) -> Publisher:
    return Publisher(
        client=client,
        bot_login=BOT,
        repository="acme/widgets",
        pr_number=1,
        web_base="https://github.com",
    )


def finding(sha: str = SHA) -> Finding:
    return Finding(
        id="f-1",
        priority="P1",
        confidence=0.5,
        title="Query text built from the request",
        body="why it is a defect",
        path="src/a.ts",
        line_start=1,
        line_end=2,
        evidence=("src/a.ts:1",),
        reviewed_sha=sha,
    )


def review(sha: str = SHA, *findings: Finding) -> DynamicFindings:
    return DynamicFindings(reviewed_sha=sha, findings=findings, resolved_ids=())


def note_for(
    code: ErrorCode = ErrorCode.CHECKOUT_INCOMPLETE,
    reason: str | None = CheckoutReason.BUDGET_PREPARATION.value,
    head_sha: str = SHA,
):
    note = failure_note_for(code, reason, head_sha)
    assert note is not None
    return note


def fail(
    publisher: Publisher,
    head_sha: str = SHA,
    *,
    previous: str | None = None,
    attempted: tuple[str, ...] = (),
    code: ErrorCode = ErrorCode.CHECKOUT_INCOMPLETE,
    reason: str | None = CheckoutReason.BUDGET_PREPARATION.value,
):
    return publisher.publish_failure(
        note_for(code, reason, head_sha),
        head_sha=head_sha,
        previous_reviewed_sha=previous,
        attempted_shas=attempted,
    )


# #299-T01
def test_a_failed_run_writes_a_note_with_the_code_the_reason_and_the_fixed_sentence() -> None:
    client = MemoryComments()

    fail(publisher_for(client))

    assert len(client.comments) == 1
    body = client.comments[0].body
    assert IDENTITY_MARKER in body
    assert "Dynamic Review did not complete" in body
    assert "`checkout_incomplete`" in body
    assert "`budget_preparation`" in body
    assert FAILURE_SENTENCES[ErrorCode.CHECKOUT_INCOMPLETE] in body
    assert SHA in body


# #299-T01
def test_the_comment_a_failure_creates_stays_readable_for_the_next_run() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)

    fail(publisher)

    # The next run finds a valid state, never "holds no review state", and reconciles from it.
    state = decode_state(client.comments[0].body)
    assert state is not None
    assert state.findings == ()
    publisher.publish(
        review(NEXT, finding(NEXT)),
        head_sha=NEXT,
        previous_reviewed_sha=None,
        attempted_shas=(SHA,),
    )
    assert len(client.comments) == 1


# #299-T01
def test_a_note_without_a_reason_names_only_the_code() -> None:
    client = MemoryComments()

    fail(publisher_for(client), code=ErrorCode.LLM_RATE_LIMIT, reason=None)

    body = client.comments[0].body
    assert "`llm_rate_limit`" in body
    assert "Reason" not in body


# #299-T02
def test_the_note_holds_only_fixed_text_the_code_the_reason_and_the_head() -> None:
    # What a failure log can hold: a path, a diff line, a model message, a secret, a provider text.
    hostile = [
        "/srv/runner/secret/export/src/app.py",
        "+  api_key = 'sk-live-0123456789abcdef'",
        "As the assistant I decided to <script>alert(1)</script> @everyone",
        "ghs_dummy-installation-token-0123456789",
        "upstream-said: quota exhausted for org acme-internal",
    ]
    # The note is built from the code, the reason and the head only. A reason that is not a stable
    # name is dropped, so repository text in the reason position never reaches the comment.
    for text in hostile:
        client = MemoryComments()
        note = failure_note_for(ErrorCode.CHECKOUT_INCOMPLETE, text, SHA)
        assert note is not None
        publisher_for(client).publish_failure(
            note, head_sha=SHA, previous_reviewed_sha=None, attempted_shas=()
        )
        body = client.comments[0].body
        for fragment in (text, *text.split()):
            if len(fragment) > 6:
                assert fragment not in body

    # And the whole body outside the hidden state marker is the fixed note and its frame.
    client = MemoryComments()
    fail(publisher_for(client))
    visible = re.sub(r"<!--.*?-->", "", client.comments[0].body, flags=re.DOTALL)
    assert "/" not in visible.replace("</", "")  # no path
    assert "\n+" not in visible and "\n-" not in visible.replace("\n- ", "\n")


# #299-T02
def test_a_head_that_is_not_a_commit_id_makes_no_note() -> None:
    assert failure_note_for(ErrorCode.CHECKOUT_INCOMPLETE, None, "not a sha") is None
    assert failure_note_for(ErrorCode.CHECKOUT_INCOMPLETE, None, "A" * 40) is None


# #299-T03
def test_the_same_failure_on_the_same_head_updates_the_comment() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)

    first = fail(publisher)
    second = fail(publisher, attempted=(SHA,))

    assert first.created is True
    assert second.created is False
    assert client.creates == 1
    assert len(client.comments) == 1
    assert client.comments[0].body.count("Dynamic Review did not complete") == 1


# #299-T03
def test_a_different_failure_replaces_the_note_instead_of_adding_one() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)

    fail(publisher)
    fail(
        publisher,
        NEXT,
        attempted=(SHA,),
        code=ErrorCode.LLM_QUOTA,
        reason=None,
    )

    body = client.comments[0].body
    assert len(client.comments) == 1
    assert body.count("Dynamic Review did not complete") == 1
    assert "`llm_quota`" in body
    assert "checkout_incomplete" not in body
    assert NEXT in body


# #299-T04
def test_a_later_successful_run_replaces_the_note_with_the_review() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)
    fail(publisher)

    publisher.publish(
        review(NEXT, finding(NEXT)),
        head_sha=NEXT,
        previous_reviewed_sha=None,
        attempted_shas=(SHA,),
    )

    body = client.comments[0].body
    assert len(client.comments) == 1
    assert "did not complete" not in body
    assert "checkout_incomplete" not in body
    assert "Query text built from the request" in body


# #299-T05
def test_a_failure_after_a_successful_review_keeps_the_findings_and_adds_the_note() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)
    publisher.publish(review(SHA, finding()), head_sha=SHA, previous_reviewed_sha=None)
    before = decode_state(client.comments[0].body)

    fail(publisher, NEXT, previous=SHA)

    body = client.comments[0].body
    assert len(client.comments) == 1
    assert "Query text built from the request" in body
    assert "Dynamic Review did not complete" in body
    assert NEXT in body
    # The review state is exactly the earlier one: the failed head is not recorded as reviewed.
    assert decode_state(body) == before


# #299-T05
def test_a_repeated_failure_refreshes_the_note_and_keeps_the_findings() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)
    publisher.publish(review(SHA, finding()), head_sha=SHA, previous_reviewed_sha=None)

    fail(publisher, NEXT, previous=SHA)
    fail(publisher, THIRD, previous=SHA, attempted=(NEXT,), code=ErrorCode.TIMEOUT, reason=None)

    body = client.comments[0].body
    assert body.count("Dynamic Review did not complete") == 1
    assert "`timeout`" in body
    assert "checkout_incomplete" not in body
    assert "Query text built from the request" in body


# #299-T05
def test_a_failure_never_overwrites_a_newer_review() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)
    publisher.publish(review(THIRD, finding(THIRD)), head_sha=THIRD, previous_reviewed_sha=None)
    before = client.comments[0].body

    # The late failure of an older run: its head is not one this comment can account for.
    with pytest.raises(PublishError) as refused:
        fail(publisher, NEXT, previous=SHA)

    assert refused.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert client.comments[0].body == before


# #299-T05
def test_a_failure_never_drops_a_state_it_cannot_account_for() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)
    publisher.publish(review(THIRD, finding(THIRD)), head_sha=THIRD, previous_reviewed_sha=None)
    before = client.comments[0].body

    with pytest.raises(PublishError):
        publisher.publish_failure(
            note_for(head_sha=NEXT),
            head_sha=NEXT,
            previous_reviewed_sha=SHA,
            attempted_shas=(),
            attempted_shas_truncated=True,
        )

    assert client.comments[0].body == before


def test_a_foreign_comment_with_the_marker_is_never_edited_for_a_note() -> None:
    client = MemoryComments()
    client.comments.append(
        Comment(
            id="9",
            body=f"{IDENTITY_MARKER}\nquoted by a person",
            author="octocat",
            url="https://github.test/acme/widgets/pull/1#issuecomment-9",
            updated_at="2026-10-15T00:00:00Z",
            author_type="User",
        )
    )

    fail(publisher_for(client))

    assert client.comments[0].body.endswith("quoted by a person")
    assert len(client.comments) == 2


# #299-T08
def test_every_error_code_is_either_a_note_code_with_a_sentence_or_deliberately_silent() -> None:
    noted = set(FAILURE_SENTENCES)
    assert noted.isdisjoint(NO_NOTE_CODES)
    # A new ErrorCode fails this until someone decides: write a sentence or list it as silent.
    assert noted | NO_NOTE_CODES == set(ErrorCode)


# #299-T08
def test_every_sentence_is_one_non_empty_line_of_plain_fixed_text() -> None:
    sentences = list(FAILURE_SENTENCES.values())
    assert len(set(sentences)) == len(sentences)
    for sentence in sentences:
        assert sentence.strip() == sentence
        assert sentence.endswith(".")
        assert "\n" not in sentence
        assert not re.search(r"[<>`@{}]", sentence)


# #299-T06
@pytest.mark.parametrize(
    "code",
    [ErrorCode.LEASE_LOST, ErrorCode.GIT_AUTH, ErrorCode.GIT_FORBIDDEN],
)
def test_a_code_the_runner_cannot_write_safely_has_no_note(code: ErrorCode) -> None:
    assert code in NO_NOTE_CODES
    assert failure_note_for(code, None, SHA) is None


@pytest.mark.parametrize(
    "code",
    [
        ErrorCode.CHECKOUT_INCOMPLETE,
        ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
        ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
        ErrorCode.LLM_AUTH,
        ErrorCode.LLM_RATE_LIMIT,
        ErrorCode.LLM_TIMEOUT,
        ErrorCode.LLM_UNAVAILABLE,
        ErrorCode.LLM_BAD_REQUEST,
        ErrorCode.LLM_QUOTA,
        ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED,
        ErrorCode.TIMEOUT,
    ],
)
def test_the_codes_of_the_issue_write_a_note(code: ErrorCode) -> None:
    assert failure_note_for(code, None, SHA) is not None


# #299-T05
def test_a_failure_after_a_clean_review_keeps_the_clean_review_visible() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)
    publisher.publish(review(SHA), head_sha=SHA, previous_reviewed_sha=None)

    fail(publisher, NEXT, previous=SHA)

    body = client.comments[0].body
    assert "Dynamic Review did not complete" in body
    assert "**0 active finding(s)**" in body
    assert "No active findings." in body
    assert "last completed review" in body


# #299-T03
def test_a_repeated_failure_on_a_pull_request_never_reviewed_stays_a_note_alone() -> None:
    client = MemoryComments()
    publisher = publisher_for(client)

    fail(publisher)
    fail(publisher, NEXT, attempted=(SHA,), code=ErrorCode.TIMEOUT, reason=None)

    body = client.comments[0].body
    assert "active finding" not in body
    assert "last completed review" not in body
    assert body.count("Dynamic Review did not complete") == 1
