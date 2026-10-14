# SPDX-License-Identifier: Apache-2.0

"""Pins down the publisher's secret redaction and its pure selection rules (#199).

The loopback publisher tests cover the API behaviour; this one keeps the redaction close to the
publisher: a secret the model echoed must not reach the comment or the state.
"""

import json

import pytest

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.github import Comment
from code_reviewer_runner.dynamic_review.publish import (
    IDENTITY_MARKER,
    Publisher,
    PublishError,
    publisher_for,
)
from code_reviewer_runner.dynamic_review.state import decode_state
from code_reviewer_runner.job import parse_job
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode

SECRET = "ghs_secret-value-0123456789abcdef"
SHA = "a" * 40


class RecordingClient:
    def __init__(self) -> None:
        self.comments: list[Comment] = []
        self._next = 1

    def list_comments(self, pr_number: int) -> list[Comment]:
        return list(self.comments)

    def create_comment(self, pr_number: int, body: str) -> Comment:
        comment = Comment(
            id=str(self._next),
            body=body,
            author="code-reviewer[bot]",
            url=f"https://example.test/comment/{self._next}",
            updated_at="",
        )
        self._next += 1
        self.comments.append(comment)
        return comment

    def edit_comment(self, comment_id: str, body: str) -> Comment:
        for index, comment in enumerate(self.comments):
            if comment.id == comment_id:
                edited = Comment(
                    id=comment.id, body=body, author=comment.author, url=comment.url, updated_at=""
                )
                self.comments[index] = edited
                return edited
        raise AssertionError("unknown comment")


def finding(**overrides: object) -> Finding:
    base: dict[str, object] = {
        "id": "f-1",
        "priority": "P1",
        "confidence": 0.5,
        "title": "A finding",
        "body": "why it is a defect",
        "path": "src/a.ts",
        "line_start": 1,
        "line_end": 2,
        "evidence": ("src/a.ts:1",),
        "reviewed_sha": SHA,
    }
    base.update(overrides)
    return Finding(**base)  # type: ignore[arg-type]


# #199-T05
def test_a_secret_in_a_finding_never_reaches_the_comment_or_the_state() -> None:
    client = RecordingClient()
    publisher = Publisher(
        client=client,
        bot_login="code-reviewer[bot]",
        repository="acme/repo",
        pr_number=1,
        redactor=Redactor([SECRET]),
    )
    run = DynamicFindings(
        reviewed_sha=SHA,
        findings=(finding(title=f"leak {SECRET}", body=f"token {SECRET}"),),
        resolved_ids=(),
    )

    publisher.publish(run, head_sha=SHA, previous_reviewed_sha=None)

    written = client.comments[0].body
    assert SECRET not in written
    assert IDENTITY_MARKER in written
    state = decode_state(written)
    assert state is not None
    assert SECRET not in state.findings[0].title


def dynamic_job(**overrides: object) -> dict[str, object]:
    job: dict[str, object] = {
        "prUrl": "https://github.com/acme/repo/pull/7",
        "command": "review",
        "reviewKind": "dynamic",
        "dynamic": {"model": "vendor/model", "skill": "", "limits": {"maxFindings": 10}},
        "base": {
            "repository": "acme/repo",
            "baseRef": "main",
            "headSha": SHA,
            "previousReviewedSha": None,
            "comparison": "full",
        },
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": "ghs_installation-token-0123456789",
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {"provider": "openrouter", "model": "vendor/model", "apiKey": "sk-test-key"},
    }
    job.update(overrides)
    return job


# #199-T01 (the engine seam)
def test_publisher_for_builds_from_the_dynamic_job() -> None:
    publisher = publisher_for(parse_job(json.dumps(dynamic_job())))

    assert publisher.repository == "acme/repo"
    assert publisher.pr_number == 7
    assert publisher.bot_login == "code-reviewer[bot]"
    assert publisher.web_base == "https://github.com"


def test_publisher_for_refuses_a_job_without_checkout_facts() -> None:
    job = dynamic_job(reviewKind="diff")
    del job["dynamic"]
    del job["base"]

    with pytest.raises(PublishError) as refused:
        publisher_for(parse_job(json.dumps(job)))

    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
