# SPDX-License-Identifier: Apache-2.0

"""The lease check right before a Dynamic run publishes (#260).

A zombie run (its lease was lost or its job cancelled while the process lived on) must not write
the summary comment. The seam `lease_check` stands in for the loop's answer; nothing here is a real
model or network call.
"""

import dataclasses
from pathlib import Path

import pytest
from test_dynamic_review_job import (
    Preparer,
    RecordingPublisher,
    environment,
    fake_engine_needs_no_ripgrep,
    job_for,
    reading_upstream,
    structured_script,
)

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.result import ErrorCode

# The shared setup names a ripgrep for the fake engine; it is used by name so it stays imported.
pytestmark = pytest.mark.usefixtures(fake_engine_needs_no_ripgrep.__name__)


class RecordingLease:
    """The `lease_check` seam: answers `state` and records when it was asked."""

    def __init__(self, state: LeaseState, preparer: Preparer) -> None:
        self.state = state
        self.preparer = preparer

    def __call__(self) -> LeaseState:
        self.preparer.events.append("lease checked")
        return self.state


def run(
    tmp_path: Path, state: LeaseState, *, truncated: bool = False
) -> tuple[runner.JobResult, RecordingPublisher, Preparer]:
    preparer = Preparer(tmp_path / "export", structured_script())
    publisher = RecordingPublisher(preparer)
    with reading_upstream() as upstream:
        job = job_for(f"{upstream.url}/v1")
        if truncated:
            job = dataclasses.replace(
                job, base=dataclasses.replace(job.base, attempted_shas_truncated=True)
            )
        result = runner.run_dynamic_job(
            job,
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
            lease_check=RecordingLease(state, preparer),
        )
    return result, publisher, preparer


# #260-T01
@pytest.mark.parametrize("truncated", [False, True])
def test_a_run_that_lost_its_lease_writes_nothing_and_ends_with_the_lost_lease_code(
    tmp_path: Path, truncated: bool
) -> None:
    result, publisher, _ = run(tmp_path, LeaseState.LOST, truncated=truncated)

    assert publisher.calls == []
    assert not result.ok
    assert result.error_code is ErrorCode.LEASE_LOST
    assert result.comment_url is None


# #260-T03
def test_a_holder_with_a_valid_lease_publishes_as_before_and_is_asked_right_before_publishing(
    tmp_path: Path,
) -> None:
    result, publisher, preparer = run(tmp_path, LeaseState.HELD)

    assert result.ok, result.log_tail
    assert result.comment_url == RecordingPublisher.URL
    assert len(publisher.calls) == 1
    # After the engine and its export are gone, immediately before the write.
    assert preparer.events == ["prepared", "released", "lease checked", "published"]


# #260-T04
def test_the_check_applies_to_a_claim_that_is_not_truncated(tmp_path: Path) -> None:
    result, publisher, preparer = run(tmp_path, LeaseState.LOST, truncated=False)

    assert "lease checked" in preparer.events
    assert publisher.calls == []
    assert result.error_code is ErrorCode.LEASE_LOST


# Not an issue case: a lease that cannot be confirmed (the app does not answer) is no permission to
# write either.
def test_a_lease_that_cannot_be_confirmed_writes_nothing(tmp_path: Path) -> None:
    result, publisher, _ = run(tmp_path, LeaseState.UNCONFIRMED)

    assert publisher.calls == []
    assert not result.ok
    assert result.error_code is ErrorCode.LEASE_LOST


# Not an issue case: a failed engine never reaches the check, the previous comment stays as it is.
def test_the_lease_is_only_checked_for_a_run_that_has_something_to_publish(
    tmp_path: Path,
) -> None:
    preparer = Preparer(tmp_path / "export", {"proxy_calls": 0, "answer": "structured"})
    lease = RecordingLease(LeaseState.HELD, preparer)
    with reading_upstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            {},
            engines=ALL_ENGINES,
            prepare=preparer,
            lease_check=lease,
        )

    assert not result.ok
    assert "lease checked" not in preparer.events
