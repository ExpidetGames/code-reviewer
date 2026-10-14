# SPDX-License-Identifier: Apache-2.0

"""A run that wrote the summary and then did not succeed no longer wedges the pull request (#255).

The whole path as the job takes it, against a loopback GitHub: run A publishes its review and ends
failed (the app records it as failed, so it never becomes `previousReviewedSha`), a push arrives,
the claim of run B names A among the `attemptedShas`, B reads A's state (the preparation of #201),
edits the same comment and leaves A's findings active unless B names them.
"""

import json
from collections.abc import Iterator

import pytest
from fake_github_comments import FakeGithubComments

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.pr_context import load_context
from code_reviewer_runner.dynamic_review.publish import PublishError, publish_run
from code_reviewer_runner.dynamic_review.render import (
    IDENTITY_MARKER,
    RESET_NOTICE,
    render_comment,
)
from code_reviewer_runner.dynamic_review.state import ReviewState, decode_state
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.result import ErrorCode

TOKEN = "ghs_fake-installation-token-0123456789"
BOT = "code-reviewer[bot]"
REPO = "octo/repo"
PR = 7
HEAD_A = "a" * 40
HEAD_B = "b" * 40
HEAD_C = "c" * 40
# Twenty heads that ran and failed after A: the window the app can name holds only these.
WINDOW = [f"{n:040x}" for n in range(1, 21)]


@pytest.fixture
def server() -> Iterator[FakeGithubComments]:
    fake = FakeGithubComments(token=TOKEN, bot_login=BOT)
    fake.pull_requests[PR] = {"title": "Add the handler", "body": "Why it is needed."}
    yield fake
    fake.stop()


def claim(
    server: FakeGithubComments,
    head: str,
    *,
    previous: str | None = None,
    attempted: list[str] | None = None,
    truncated: bool | None = None,
) -> Job:
    """The job as the claim hands it out; `attemptedShas` is the wire name of the app's list."""
    base: dict[str, object] = {
        "repository": REPO,
        "baseRef": "main",
        "headSha": head,
        "previousReviewedSha": previous,
        "comparison": "incremental" if previous else "full",
    }
    if attempted is not None:
        base["attemptedShas"] = attempted
    if truncated is not None:
        base["attemptedShasTruncated"] = truncated
    return parse_job(
        json.dumps(
            {
                "prUrl": f"{server.url}/{REPO}/pull/{PR}",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": "deepseek/deepseek-v4.1-flash",
                    "skill": "Look for real bugs.",
                    "limits": {"maxFindings": 5},
                },
                "base": base,
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


def finding(finding_id: str, sha: str, path: str) -> Finding:
    return Finding(
        id=finding_id,
        priority="P1",
        confidence=0.8,
        title=f"Defect in {path}",
        body="why it is a defect",
        path=path,
        line_start=3,
        line_end=4,
        evidence=(f"{path}:3",),
        reviewed_sha=sha,
    )


def review(sha: str, *findings: Finding, resolved: tuple[str, ...] = ()) -> DynamicFindings:
    return DynamicFindings(reviewed_sha=sha, findings=findings, resolved_ids=resolved)


# #255-T01
def test_a_push_after_a_run_that_published_and_failed_publishes_a_correct_summary(
    server: FakeGithubComments,
) -> None:
    # 1. Run A publishes (its comment is created) and then ends failed.
    publish_run(claim(server, HEAD_A), review(HEAD_A, finding("f-a", HEAD_A, "src/a.ts")))
    assert len(server.comments) == 1
    url = server.comments[0]["html_url"]

    # 2. A push: the claim of B has no succeeded review but names A as attempted.
    job_b = claim(server, HEAD_B, attempted=[HEAD_A])
    context = load_context(job_b)
    assert "f-a" in context.prior_state

    # 3. B succeeds: same comment, no duplicate, A's finding stays active (B did not name it) and
    # B's own is added.
    published = publish_run(job_b, review(HEAD_B, finding("f-b", HEAD_B, "src/b.ts")))

    assert published.created is False
    assert published.comment_url == url
    assert len(server.comments) == 1
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert state.reviewed_sha == HEAD_B
    assert {item.id for item in state.findings} == {"f-a", "f-b"}
    assert state.resolved == ()

    # 4. The next push recovers on its own: B succeeded, so it is the previous review.
    publish_run(
        claim(server, HEAD_C, previous=HEAD_B, attempted=[]),
        review(HEAD_C, resolved=("f-a",)),
    )
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert state.reviewed_sha == HEAD_C
    assert [entry.finding.id for entry in state.resolved] == ["f-a"]


# #255-T02
def test_without_the_attempted_head_the_same_push_still_fails_closed(
    server: FakeGithubComments,
) -> None:
    publish_run(claim(server, HEAD_A), review(HEAD_A, finding("f-a", HEAD_A, "src/a.ts")))
    before = server.comments[0]["body"]

    # An older app, or a head the app never attempted: the state cannot be accounted for.
    for attempted in (None, [], [HEAD_C]):
        job = claim(server, HEAD_B, attempted=attempted)
        with pytest.raises(CheckoutError) as refused_read:
            load_context(job)
        assert refused_read.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
        with pytest.raises(PublishError) as refused_write:
            publish_run(job, review(HEAD_B))
        assert refused_write.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert server.comments[0]["body"] == before


def seed_state(
    server: FakeGithubComments,
    sha: str,
    *findings: Finding,
    author: str,
    user_type: str | None = None,
    app_slug: str | None = None,
) -> str:
    """A summary comment as the publisher writes it (marker, state, head), by any author."""
    state = ReviewState(reviewed_sha=sha, findings=findings, resolved=())
    body = render_comment(state, repository=REPO, web_base="")
    assert IDENTITY_MARKER in body
    seeded = server.seed(body, author=author, user_type=user_type, app_slug=app_slug)
    return str(seeded["id"])


def bodies(server: FakeGithubComments) -> dict[str, str]:
    return {str(item["id"]): str(item["body"]) for item in server.comments}


# #257-T01
def test_a_truncated_claim_recovers_an_unaccountable_state_head_with_a_full_review(
    server: FakeGithubComments,
) -> None:
    # Run A publishes and fails, then 20 other heads ran and failed: A fell out of the window.
    publish_run(claim(server, HEAD_A), review(HEAD_A, finding("f-a", HEAD_A, "src/a.ts")))
    url = server.comments[0]["html_url"]
    job = claim(server, HEAD_B, attempted=WINDOW, truncated=True)

    # The preparation shows the engine no prior findings: it is a full review.
    assert "f-a" not in load_context(job).prior_state

    # Without the flag the very same window wedges (the state of #255).
    wedged = claim(server, HEAD_B, attempted=WINDOW)
    with pytest.raises(PublishError) as refused:
        publish_run(wedged, review(HEAD_B))
    assert refused.value.code is ErrorCode.REVIEW_NOT_PUBLISHED

    # The recovery rewrites the same comment: no duplicate, and nothing is carried over from A,
    # neither as active nor as resolved (a resolution by inference would be a guess).
    published = publish_run(
        job, review(HEAD_B, finding("f-b", HEAD_B, "src/b.ts"), resolved=("f-a",))
    )
    assert published.created is False
    assert published.comment_url == url
    assert len(server.comments) == 1
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert state.reviewed_sha == HEAD_B
    assert [item.id for item in state.findings] == ["f-b"]
    assert state.resolved == ()
    assert published.reset is True

    # #257-T05: the summary says it is a reset and no longer claims the old state is kept.
    body = server.comments[0]["body"]
    assert RESET_NOTICE in body
    assert "previous review state is kept" not in body

    # And the pull request keeps going: the next push reconciles from B as usual.
    publish_run(
        claim(server, HEAD_C, previous=HEAD_B, attempted=[]),
        review(HEAD_C, resolved=("f-b",)),
    )
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert [entry.finding.id for entry in state.resolved] == ["f-b"]
    # #257-T05: the notice is one-shot; the next normal run does not repeat it.
    assert RESET_NOTICE not in server.comments[0]["body"]


# #257-T01
def test_a_truncated_claim_whose_state_head_is_accounted_for_reconciles_as_usual(
    server: FakeGithubComments,
) -> None:
    publish_run(claim(server, HEAD_A), review(HEAD_A, finding("f-a", HEAD_A, "src/a.ts")))
    job = claim(server, HEAD_B, attempted=[HEAD_A, *WINDOW[:-1]], truncated=True)

    assert "f-a" in load_context(job).prior_state
    published = publish_run(job, review(HEAD_B, finding("f-b", HEAD_B, "src/b.ts")))

    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert {item.id for item in state.findings} == {"f-a", "f-b"}
    # #257-T05: nothing was reset, so nothing says so.
    assert published.reset is False
    assert RESET_NOTICE not in server.comments[0]["body"]


# #257-T02
@pytest.mark.parametrize("truncated", [None, False])
def test_the_same_comment_on_a_claim_that_is_not_truncated_fails_closed(
    server: FakeGithubComments, truncated: bool | None
) -> None:
    publish_run(claim(server, HEAD_A), review(HEAD_A, finding("f-a", HEAD_A, "src/a.ts")))
    before = server.comments[0]["body"]
    job = claim(server, HEAD_B, attempted=WINDOW, truncated=truncated)

    with pytest.raises(CheckoutError) as refused_read:
        load_context(job)
    assert refused_read.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
    with pytest.raises(PublishError) as refused_write:
        publish_run(job, review(HEAD_B))
    assert refused_write.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert server.comments[0]["body"] == before


# #257-T03
@pytest.mark.parametrize("truncated", [True, False])
@pytest.mark.parametrize(
    "identity",
    [
        {"author": "alice"},
        {"author": "other-bot[bot]"},
        {"author": BOT, "user_type": "User"},
        {"author": BOT, "user_type": "Bot", "app_slug": "some-other-app"},
    ],
)
def test_a_comment_that_is_not_the_bots_is_never_rewritten(
    server: FakeGithubComments, truncated: bool, identity: dict[str, str]
) -> None:
    forged = seed_state(server, HEAD_A, finding("f-a", HEAD_A, "src/a.ts"), **identity)
    before = bodies(server)
    job = claim(server, HEAD_B, attempted=WINDOW, truncated=truncated)

    publish_run(job, review(HEAD_B, finding("f-b", HEAD_B, "src/b.ts")))

    # The forged comment is untouched; the bot writes its own summary next to it.
    assert bodies(server)[forged] == before[forged]
    assert len(server.comments) == 2


# #257-T03
def test_a_truncated_claim_never_rewrites_a_corrupt_or_stateless_bot_comment(
    server: FakeGithubComments,
) -> None:
    server.seed(IDENTITY_MARKER + "\nno state in here", author=BOT)
    before = bodies(server)
    job = claim(server, HEAD_B, attempted=WINDOW, truncated=True)

    with pytest.raises(PublishError) as refused:
        publish_run(job, review(HEAD_B))
    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
    assert bodies(server) == before
