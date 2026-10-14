# SPDX-License-Identifier: Apache-2.0

"""A force-push the previous review cannot be compared with (#201-T10).

The head the earlier review looked at is no longer available from the server, so the runner declares
a full review. The declaration must reach the prompt, the prior findings must reach the prompt as
active, and a model that does not name them cannot make them disappear: an omitted finding stays
active in the published summary. Only a finding the model names in `resolvedIds` is resolved. Real
local Git, the real preparation, the real context read and publisher against a loopback GitHub, a
scripted engine and a fake provider: no real model or network.
"""

import sys
from pathlib import Path
from typing import Any

import pytest
from test_dynamic_review_context_read import (
    HEAD,
    REPO,
    job_for,
    publish_review,
    publisher,
)
from test_dynamic_review_context_read import server as server  # fixture
from test_dynamic_review_engine import HEAD as RUN_HEAD
from test_dynamic_review_engine import FakeUpstream, Fixture, asks, findings, tool_call

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fake_github_comments import FakeGithubComments
from fakes.dynamic_git.fixtures import GitFixture
from test_dynamic_review_context_read import finding

from code_reviewer_runner.dynamic_review.checkout import prepare_content
from code_reviewer_runner.dynamic_review.inputs import review_inputs
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.pr_context import load_context
from code_reviewer_runner.dynamic_review.transport import LocalTransport
from code_reviewer_runner.job import ClaimBase
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode


def review_after_force_push(
    server: FakeGithubComments, tmp_path: Path, previous: str | None, answer: dict[str, Any]
) -> tuple[str, str]:
    """The prompt of the second review and the summary it publishes for a model giving `answer`."""
    publish_review(server, finding("f-1", HEAD, title="Null deref"))
    git_repo = GitFixture(tmp_path / "base.git")
    job = job_for(server, head=git_repo.head, previous=previous)
    context = load_context(job)
    prepared = prepare_content(
        ClaimBase(REPO, "main", git_repo.head, previous, "incremental" if previous else "full"),
        196,  # the pull request ref the Git fixture serves
        LocalTransport(git_repo.path),
        tmp_path / "job",
        Redactor(()),
        metadata=context.metadata,
        prior_state=context.prior_state,
    )
    # The earlier head is gone from the server: a declared full review, whatever the claim said.
    assert prepared.comparison == "full" and prepared.previous_diff == ""

    fixture = Fixture(tmp_path, {"proxy_calls": 1, "answer": "structured", "findings": answer})
    fixture.inputs = review_inputs(job.pr_url, prepared)
    with FakeUpstream([asks(tool_call("c1", "StructuredOutput", answer))]) as upstream:
        result = fixture.run(upstream)
    assert result.ok and result.findings is not None, result.error
    prompt = next(e["message_request"] for e in fixture.traces() if "message_request" in e)[
        "parts"
    ][0]["text"]
    publisher(server).publish(result.findings, head_sha=RUN_HEAD, previous_reviewed_sha=previous)
    return prompt, server.comments[0]["body"]


# The earlier head is a commit the server no longer has (the previous review's head, "a" * 40).
def test_a_full_review_after_a_force_push_keeps_findings_it_did_not_examine_active(
    server: FakeGithubComments, tmp_path: Path
) -> None:
    silent_model: dict[str, Any] = {**findings(), "findings": [], "resolvedIds": []}

    prompt, summary = review_after_force_push(server, tmp_path, HEAD, silent_model)

    assert "review mode: full" in prompt
    assert "id=f-1" in prompt and "Null deref" in prompt
    # Not mentioned is not fixed: the finding is still active and nothing is resolved by absence.
    assert "Null deref" in summary
    assert "Resolved findings" not in summary
    assert len(server.comments) == 1


def test_only_a_finding_the_model_names_is_resolved_after_a_force_push(
    server: FakeGithubComments, tmp_path: Path
) -> None:
    naming_model: dict[str, Any] = {**findings(), "findings": [], "resolvedIds": ["f-1"]}

    _, summary = review_after_force_push(server, tmp_path, HEAD, naming_model)

    resolved = summary[summary.index("### Resolved findings (1)") :]
    assert "Null deref" in resolved
    assert "Null deref" not in summary[: summary.index("### Resolved findings (1)")]


def test_a_summary_the_job_cannot_account_for_is_a_stable_failure_not_a_silent_full_review(
    server: FakeGithubComments,
) -> None:
    # The app knows no earlier head for the pull request, but the bot's summary exists: the prior
    # state cannot be placed, so the job fails closed instead of reviewing from scratch beside it.
    publish_review(server, finding("f-1", HEAD, title="Null deref"))

    with pytest.raises(CheckoutError) as caught:
        load_context(job_for(server, head="b" * 40, previous=None))

    assert caught.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
