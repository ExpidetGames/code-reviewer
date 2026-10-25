# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a result says about the findings left open on the pull request (#405).

The app decides the review verdict from it, so the numbers have to be the findings that are
*open* after the run, not the ones the run found: a Dynamic run carries the earlier runs' findings
over, and PR-Agent keeps its own record of active findings. A Diff review has no severities, a
Dynamic review has P0 to P3.
"""

import importlib
from collections.abc import Iterator
from typing import Any

import pytest

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.github import Comment
from code_reviewer_runner.dynamic_review.publish import Publisher
from code_reviewer_runner.result import JobResult, ReviewFindings
from code_reviewer_runner.review_state_watch import ReviewStateWatch, install_review_state_watch

pytestmark = pytest.mark.unit

SHA = "a" * 40
pr_reviewer: Any = importlib.import_module("pr_agent.tools.pr_reviewer")


def _result(findings: ReviewFindings | None) -> JobResult:
    return JobResult(
        ok=True,
        duration_ms=1,
        comment_url="https://github.test/acme/widgets/pull/1#issuecomment-1",
        error_code=None,
        log_tail="",
        findings=findings,
    )


# #405-T30
def test_a_result_carries_the_open_findings_per_severity() -> None:
    document = _result(
        ReviewFindings(open=3, by_severity={"P0": 1, "P1": 0, "P2": 2, "P3": 0})
    ).to_json()

    assert document["findings"] == {
        "open": 3,
        "bySeverity": {"P0": 1, "P1": 0, "P2": 2, "P3": 0},
    }


# #405-T30
def test_a_review_without_severities_says_so_with_null() -> None:
    document = _result(ReviewFindings(open=2, by_severity=None)).to_json()

    assert document["findings"] == {"open": 2, "bySeverity": None}


# #405-T30
def test_a_result_without_findings_has_no_field_so_a_previous_app_reads_it_unchanged() -> None:
    assert "findings" not in _result(None).to_json()


def _finding(identifier: str, priority: str) -> Finding:
    return Finding(
        id=identifier,
        priority=priority,
        confidence=0.5,
        title=f"Finding {identifier}",
        body="why it is a defect",
        path="src/a.ts",
        line_start=1,
        line_end=2,
        evidence=("src/a.ts:1",),
        reviewed_sha=SHA,
    )


class _Client:
    """A pull request with one comment store: what a write puts in, the next read finds."""

    def __init__(self) -> None:
        self.comments: list[Comment] = []

    def list_comments(self, pr_number: int) -> list[Comment]:
        return list(self.comments)

    def create_comment(self, pr_number: int, body: str) -> Comment:
        comment = Comment(
            id="1",
            body=body,
            author="code-reviewer[bot]",
            url="https://github.test/acme/widgets/pull/1#issuecomment-1",
            updated_at="2026-10-10T00:00:00Z",
            author_type="Bot",
        )
        self.comments = [comment]
        return comment

    def edit_comment(self, comment_id: str, body: str) -> Comment:
        comment = Comment(
            id=comment_id,
            body=body,
            author="code-reviewer[bot]",
            url="https://github.test/acme/widgets/pull/1#issuecomment-1",
            updated_at="2026-10-10T00:01:00Z",
            author_type="Bot",
        )
        self.comments = [comment]
        return comment


def _publisher(client: _Client) -> Publisher:
    return Publisher(
        client=client,
        bot_login="code-reviewer[bot]",
        repository="acme/widgets",
        pr_number=1,
    )


def _run(*findings: Finding, resolved: tuple[str, ...] = ()) -> DynamicFindings:
    return DynamicFindings(reviewed_sha=SHA, findings=findings, resolved_ids=resolved)


# #405-T31
def test_a_dynamic_run_reports_the_findings_open_after_it_per_priority() -> None:
    client = _Client()
    publisher = _publisher(client)

    published = publisher.publish(
        _run(_finding("a", "P0"), _finding("b", "P2"), _finding("c", "P2")),
        head_sha=SHA,
        previous_reviewed_sha=None,
    )

    assert published.findings == ReviewFindings(
        open=3, by_severity={"P0": 1, "P1": 0, "P2": 2, "P3": 0}
    )


# #405-T31
def test_a_dynamic_re_review_counts_the_findings_it_carried_over_and_not_the_resolved_ones() -> (
    None
):
    client = _Client()
    publisher = _publisher(client)
    publisher.publish(
        _run(_finding("a", "P0"), _finding("b", "P3")), head_sha=SHA, previous_reviewed_sha=None
    )

    # The second run finds nothing new and names the P0 as fixed: the P3 is still open.
    published = publisher.publish(_run(resolved=("a",)), head_sha=SHA, previous_reviewed_sha=SHA)

    assert published.findings == ReviewFindings(
        open=1, by_severity={"P0": 0, "P1": 0, "P2": 0, "P3": 1}
    )


# #405-T31
def test_a_dynamic_run_that_leaves_nothing_open_reports_zero_and_not_unknown() -> None:
    published = _publisher(_Client()).publish(_run(), head_sha=SHA, previous_reviewed_sha=None)

    assert published.findings == ReviewFindings(
        open=0, by_severity={"P0": 0, "P1": 0, "P2": 0, "P3": 0}
    )


# #405-T31 (review P1-3): a finding the validation threw away may have been the blocker.
def test_a_dynamic_run_that_dropped_an_invalid_finding_reports_the_review_as_incomplete() -> None:
    run = DynamicFindings(
        reviewed_sha=SHA,
        findings=(_finding("a", "P2"),),
        resolved_ids=(),
        dropped_invalid=1,
        dropped_invalid_reasons=("finding.priority must be one of P0, P1, P2, P3",),
    )

    published = _publisher(_Client()).publish(run, head_sha=SHA, previous_reviewed_sha=None)

    assert published.findings == ReviewFindings(
        open=1, by_severity={"P0": 0, "P1": 0, "P2": 1, "P3": 0}, incomplete=True
    )


# #405-T31 (review P1-3)
def test_a_dynamic_run_that_dropped_a_finding_outside_the_export_is_incomplete() -> None:
    run = DynamicFindings(reviewed_sha=SHA, findings=(), resolved_ids=(), dropped_outside_export=2)

    published = _publisher(_Client()).publish(run, head_sha=SHA, previous_reviewed_sha=None)

    assert published.findings is not None
    assert published.findings.incomplete is True
    assert published.findings.open == 0


# #405-T31 (review P1-3)
def test_a_dynamic_run_that_dropped_nothing_does_not_say_incomplete() -> None:
    published = _publisher(_Client()).publish(_run(), head_sha=SHA, previous_reviewed_sha=None)

    assert published.findings is not None
    assert published.findings.incomplete is False
    assert "incomplete" not in published.findings.to_json()


# #405-T30 (review P1-3)
def test_an_incomplete_review_says_so_in_the_result_and_a_whole_one_leaves_the_field_out() -> None:
    incomplete = ReviewFindings(open=0, by_severity=None, incomplete=True).to_json()

    assert incomplete == {"open": 0, "bySeverity": None, "incomplete": True}


@pytest.fixture
def watch() -> Iterator[ReviewStateWatch]:
    watch, undo = install_review_state_watch()
    try:
        yield watch
    finally:
        undo()


def _state(
    *findings: tuple[str, str], complete: bool = True, excluded: tuple[str, ...] = ()
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "findings": [
            {"finding_id": identifier, "state": state, "path": "a.py", "body": identifier}
            for identifier, state in findings
        ],
        "last_run": {
            "complete": complete,
            "excluded_files": list(excluded),
            "head_sha": "a",
            "run_id": "",
        },
    }


# #405-T31
def test_a_diff_review_counts_the_findings_pr_agent_records_as_active(
    watch: ReviewStateWatch,
) -> None:
    pr_reviewer.append_review_state(
        "review", _state(("f1", "ACTIVE"), ("f2", "RESOLVED"), ("f3", "ACTIVE")), 4000
    )

    assert watch.active_findings == 2


# #405-T31
def test_a_diff_review_that_never_wrote_a_state_has_no_count(watch: ReviewStateWatch) -> None:
    assert watch.active_findings is None


# #405-T31
def test_the_last_state_a_diff_review_wrote_counts(watch: ReviewStateWatch) -> None:
    pr_reviewer.append_review_state("review", _state(("f1", "ACTIVE")), 4000)
    pr_reviewer.append_review_state("review", _state(), 4000)

    assert watch.active_findings == 0


# #405-T31 (review P1-3): PR-Agent says in its record whether the run covered the whole diff.
def test_a_diff_review_whose_run_was_not_complete_is_incomplete(watch: ReviewStateWatch) -> None:
    pr_reviewer.append_review_state("review", _state(complete=False), 4000)

    assert watch.active_findings == 0
    assert watch.coverage_complete is False


# #405-T31 (review P1-3)
def test_a_diff_review_with_files_left_out_is_incomplete_even_when_the_run_says_complete(
    watch: ReviewStateWatch,
) -> None:
    pr_reviewer.append_review_state("review", _state(excluded=("big.py",)), 4000)

    assert watch.coverage_complete is False


# #405-T31 (review P1-3)
def test_a_diff_review_that_covered_everything_is_complete(watch: ReviewStateWatch) -> None:
    pr_reviewer.append_review_state("review", _state(("f1", "ACTIVE")), 4000)

    assert watch.coverage_complete is True


# #405-T31 (review P1-3): a record without the run's coverage cannot be trusted to be whole.
@pytest.mark.parametrize("state", [{}, {"last_run": None}, {"last_run": {"complete": True}}, "x"])
def test_a_record_without_coverage_is_not_complete(state: Any) -> None:
    from code_reviewer_runner.review_state_watch import (
        _coverage_complete,  # pyright: ignore[reportPrivateUsage]
    )

    assert _coverage_complete(state) is False


# #405-T31 (review P1-3)
@pytest.mark.parametrize(
    ("coverage_complete", "expected_incomplete"), [(True, False), (False, True), (None, True)]
)
def test_the_diff_findings_of_a_result_carry_the_coverage(
    coverage_complete: bool | None, expected_incomplete: bool
) -> None:
    from code_reviewer_runner.job import Command
    from code_reviewer_runner.runner import _diff_findings  # pyright: ignore[reportPrivateUsage]

    watch = ReviewStateWatch(active_findings=0, coverage_complete=coverage_complete)

    findings = _diff_findings(True, Command.REVIEW, watch)

    assert findings == ReviewFindings(open=0, by_severity=None, incomplete=expected_incomplete)
