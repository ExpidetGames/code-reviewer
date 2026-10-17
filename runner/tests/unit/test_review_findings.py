# SPDX-License-Identifier: Apache-2.0

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


@pytest.fixture
def watch() -> Iterator[ReviewStateWatch]:
    watch, undo = install_review_state_watch()
    try:
        yield watch
    finally:
        undo()


def _state(*findings: tuple[str, str]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "findings": [
            {"finding_id": identifier, "state": state, "path": "a.py", "body": identifier}
            for identifier, state in findings
        ],
        "last_run": {"complete": True, "excluded_files": [], "head_sha": "a", "run_id": ""},
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
