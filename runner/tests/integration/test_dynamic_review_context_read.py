# SPDX-License-Identifier: Apache-2.0

"""The pull request text and prior review state the Dynamic engine is given (#201).

The preparer reads them with the job's narrowed token from the job's own pull request on GitHub,
through the real narrow client against a loopback GitHub. The persisted summary of the bot (#199)
is the only source of prior state; a corrupt or unaccountable state fails closed.
"""

import json
from collections.abc import Iterator

import pytest
from fake_github_comments import FakeGithubComments

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.github import HttpCommentsClient
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.pr_context import load_context
from code_reviewer_runner.dynamic_review.publish import Publisher
from code_reviewer_runner.dynamic_review.state import MARKER_PREFIX, MARKER_SUFFIX
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.result import ErrorCode

TOKEN = "ghs_fake-installation-token-0123456789"
BOT = "code-reviewer[bot]"
REPO = "octo/repo"
PR = 7
HEAD = "a" * 40
NEXT = "c" * 40


@pytest.fixture
def server() -> Iterator[FakeGithubComments]:
    fake = FakeGithubComments(token=TOKEN, bot_login=BOT)
    fake.pull_requests[PR] = {"title": "Add the handler", "body": "Why it is needed."}
    yield fake
    fake.stop()


def job_for(server: FakeGithubComments, *, head: str = HEAD, previous: str | None = None) -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": f"{server.url}/{REPO}/pull/{PR}",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": "deepseek-v4.1-flash",
                    "skill": "Look for real bugs.",
                    "limits": {"maxFindings": 5},
                },
                "base": {
                    "repository": REPO,
                    "baseRef": "main",
                    "headSha": head,
                    "previousReviewedSha": previous,
                    "comparison": "incremental" if previous else "full",
                },
                "git": {
                    "provider": "github",
                    "baseUrl": server.url,
                    "token": TOKEN,
                    "botLogin": BOT,
                },
                "llm": {
                    "provider": "openrouter",
                    "model": "deepseek/deepseek-v4.1-flash",
                    "apiKey": "dummy-openrouter-key-0123456789",
                },
            }
        )
    )


def finding(finding_id: str, sha: str, title: str = "Null deref") -> Finding:
    return Finding(
        id=finding_id,
        priority="P1",
        confidence=0.8,
        title=title,
        body="why it is a defect",
        path="src/a.ts",
        line_start=3,
        line_end=4,
        evidence=("src/a.ts:3",),
        reviewed_sha=sha,
    )


def publish_review(server: FakeGithubComments, *findings: Finding) -> None:
    Publisher(
        client=HttpCommentsClient(server.url, REPO, TOKEN),
        bot_login=BOT,
        repository=REPO,
        pr_number=PR,
        web_base="https://github.com",
    ).publish(
        DynamicFindings(reviewed_sha=HEAD, findings=findings, resolved_ids=()),
        head_sha=HEAD,
        previous_reviewed_sha=None,
    )


# #201-T01
def test_the_real_title_and_body_of_the_jobs_own_pull_request_are_read(
    server: FakeGithubComments,
) -> None:
    context = load_context(job_for(server))

    assert json.loads(context.metadata) == {
        "title": "Add the handler",
        "body": "Why it is needed.",
    }
    assert context.prior_state == ""
    # Only reads, and only of this repository's pull request and its comments.
    assert {method for method, _ in server.requests} == {"GET"}
    assert all(f"/repos/{REPO}/" in path for _, path in server.requests)
    assert any(path == f"/repos/{REPO}/pulls/{PR}" for _, path in server.requests)
    assert all(
        path.startswith((f"/repos/{REPO}/pulls/{PR}", f"/repos/{REPO}/issues/{PR}/comments"))
        for _, path in server.requests
    )


# #201-T01
def test_the_prior_state_is_the_active_findings_of_the_bots_persisted_summary(
    server: FakeGithubComments,
) -> None:
    publish_review(server, finding("f-1", HEAD))

    context = load_context(job_for(server, head=NEXT, previous=HEAD))

    assert "f-1" in context.prior_state
    assert "Null deref" in context.prior_state


# #201-T04
def test_a_human_copy_of_the_summary_marker_is_never_prior_state(
    server: FakeGithubComments,
) -> None:
    publish_review(server, finding("f-real", HEAD))
    state = server.comments[0]["body"]
    # A person copies the whole comment, state included, and edits nothing but the author.
    server.comments[0]["user"] = {"login": "mallory", "type": "User"}
    server.comments[0]["performed_via_github_app"] = None
    server.seed(state, author="someone-else")

    context = load_context(job_for(server, head=NEXT, previous=HEAD))

    assert context.prior_state == ""


# #201-T04
def test_a_corrupt_prior_state_fails_closed_instead_of_being_forgotten(
    server: FakeGithubComments,
) -> None:
    publish_review(server, finding("f-1", HEAD))
    body = server.comments[0]["body"]
    start = body.index(MARKER_PREFIX) + len(MARKER_PREFIX)
    end = body.index(MARKER_SUFFIX, start)
    server.comments[0]["body"] = body[:start] + "AAAA" + body[end:]

    with pytest.raises(CheckoutError) as caught:
        load_context(job_for(server, head=NEXT, previous=HEAD))

    assert caught.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #201-T10
def test_a_prior_state_of_a_head_the_job_cannot_account_for_fails_closed(
    server: FakeGithubComments,
) -> None:
    publish_review(server, finding("f-1", HEAD))

    with pytest.raises(CheckoutError) as caught:
        load_context(job_for(server, head=NEXT, previous="d" * 40))

    assert caught.value.code is ErrorCode.REVIEW_NOT_PUBLISHED


# #201-T04
@pytest.mark.parametrize(
    ("fault", "code"),
    [
        (401, ErrorCode.GIT_AUTH),
        (404, ErrorCode.PR_NOT_FOUND),
        (429, ErrorCode.GIT_RATE_LIMIT),
        (503, ErrorCode.GIT_UNAVAILABLE),
    ],
)
def test_a_pull_request_that_cannot_be_read_ends_in_a_stable_code(
    server: FakeGithubComments, fault: int, code: ErrorCode
) -> None:
    server.faults["GET"] = (fault, {})

    with pytest.raises(CheckoutError) as caught:
        load_context(job_for(server))

    assert caught.value.code is code


# #201-T04
def test_a_malformed_pull_request_answer_is_not_an_empty_title(
    server: FakeGithubComments,
) -> None:
    server.pull_requests[PR] = {"title": 7, "body": None}

    with pytest.raises(CheckoutError) as caught:
        load_context(job_for(server))

    assert caught.value.code is ErrorCode.GIT_UNAVAILABLE


# #201-T01
def test_a_pull_request_without_a_body_is_a_title_and_an_empty_body(
    server: FakeGithubComments,
) -> None:
    server.pull_requests[PR] = {"title": "Only a title", "body": None}

    context = load_context(job_for(server))

    assert json.loads(context.metadata) == {"title": "Only a title", "body": ""}


# #201-T01
def test_a_cancelled_job_does_not_read_the_pull_request(server: FakeGithubComments) -> None:
    with pytest.raises(CheckoutError):
        load_context(job_for(server), cancelled=lambda: True)

    assert server.requests == []
