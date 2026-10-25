# SPDX-License-Identifier: LicenseRef-Proprietary

"""When the runner writes the failure note of a Dynamic run, and what a failed write cannot change
(#299)."""

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import pytest
from test_dynamic_review_run import CAPABILITIES, HEAD, dynamic_job

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.limits import CheckoutError, CheckoutReason
from code_reviewer_runner.dynamic_review.publish import Published, PublishError
from code_reviewer_runner.job import Job
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.result import ErrorCode, JobResult


class Writer:
    """A `publish_failure` double that records the calls and can be told to fail."""

    def __init__(self, fail: Exception | None = None) -> None:
        self.calls: list[tuple[Job, ErrorCode, str | None]] = []
        self.fail = fail

    def __call__(self, job: Job, code: ErrorCode, reason: str | None) -> Published | None:
        self.calls.append((job, code, reason))
        if self.fail is not None:
            raise self.fail
        return Published(comment_url="https://github.test/comment/1", created=True)


def refusing(error: CheckoutError):
    @contextmanager
    def prepare(job: Job) -> Generator[PreparedContent]:
        raise error
        yield  # pragma: no cover

    return prepare


def run(
    prepare: Any, writer: Writer, *, lease_state: LeaseState | None = LeaseState.HELD
) -> JobResult:
    return runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
        },
        engines=ALL_ENGINES,
        prepare=prepare,
        publish_failure=writer,
        lease_check=None if lease_state is None else (lambda: lease_state),
    )


# #299-T01
def test_a_failed_checkout_writes_the_note_with_its_code_and_reason() -> None:
    writer = Writer()

    result = run(refusing(CheckoutError(CheckoutReason.BUDGET_PREPARATION)), writer)

    assert [(code, reason) for _, code, reason in writer.calls] == [
        (ErrorCode.CHECKOUT_INCOMPLETE, "budget_preparation")
    ]
    assert writer.calls[0][0].base is not None
    assert writer.calls[0][0].base.head_sha == HEAD
    assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
    assert result.error_reason == "budget_preparation"
    assert "failure note: written" in result.log_tail


# #299-T01
def test_a_failure_before_the_checkout_writes_the_note_too() -> None:
    writer = Writer()

    # A model that cannot serve the run fails before anything is prepared.
    result = runner.run_dynamic_job(
        dynamic_job(),
        None,
        0.0,
        {
            runner.OPENCODE_COMMAND_VARIABLE: "opencode",
            runner.DYNAMIC_CAPABILITIES_VARIABLE: '{"tool_choice_required": false}',
        },
        engines=ALL_ENGINES,
        prepare=refusing(CheckoutError(CheckoutReason.CONTEXT)),
        publish_failure=writer,
        lease_check=lambda: LeaseState.HELD,
    )

    assert result.error_code is ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED
    assert [code for _, code, _ in writer.calls] == [ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED]


# #299-T06
@pytest.mark.parametrize("code", [ErrorCode.GIT_AUTH, ErrorCode.GIT_FORBIDDEN])
def test_a_failure_the_runner_cannot_write_safely_writes_nothing(code: ErrorCode) -> None:
    writer = Writer()

    result = run(refusing(CheckoutError(CheckoutReason.TRANSPORT, code)), writer)

    assert writer.calls == []
    assert result.error_code is code
    assert "failure note" not in result.log_tail


# #299-T06
@pytest.mark.parametrize("state", [LeaseState.LOST, LeaseState.UNCONFIRMED])
def test_a_job_that_is_no_longer_ours_writes_no_note(state: LeaseState) -> None:
    writer = Writer()

    result = run(
        refusing(CheckoutError(CheckoutReason.BUDGET_PREPARATION)), writer, lease_state=state
    )

    assert writer.calls == []
    assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
    assert "failure note" not in result.log_tail


# #299-T07
@pytest.mark.parametrize(
    "failure",
    [
        PublishError(ErrorCode.GIT_FORBIDDEN, "the comment could not be written"),
        PublishError(ErrorCode.REVIEW_NOT_PUBLISHED, "a newer review is already published"),
        RuntimeError("anything at all, even with a secret " + "ghs_dummy"),
    ],
)
def test_a_note_that_cannot_be_written_leaves_the_original_failure(failure: Exception) -> None:
    writer = Writer(fail=failure)

    result = run(refusing(CheckoutError(CheckoutReason.BUDGET_PREPARATION)), writer)

    assert len(writer.calls) == 1
    assert result.ok is False
    assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
    assert result.error_reason == "budget_preparation"
    assert "failure note: not written" in result.log_tail
    # Not the text of the failure, which could carry anything.
    assert "ghs_dummy" not in result.log_tail
    assert "anything at all" not in result.log_tail


# #299-T07
def test_a_stable_code_of_a_failed_write_is_named_in_the_log() -> None:
    writer = Writer(fail=PublishError(ErrorCode.GIT_RATE_LIMIT, "the comment could not be written"))

    result = run(refusing(CheckoutError(CheckoutReason.BUDGET_PREPARATION)), writer)

    assert "failure note: not written (git_rate_limit)" in result.log_tail
