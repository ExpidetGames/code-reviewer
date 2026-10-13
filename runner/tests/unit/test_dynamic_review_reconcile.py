# SPDX-License-Identifier: Apache-2.0

"""Pins down how a Dynamic run is reconciled with the earlier runs (#199).

The rules under test are the ones that make a re-review safe: resolutions happen only when the run
names the id, an omitted previous finding stays active, a moved or rephrased finding keeps its id
instead of duplicating, a regression is re-opened, and the resolved history is retained.
"""

from dataclasses import replace

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.reconcile import identity_of, reconcile, summary_counts
from code_reviewer_runner.dynamic_review.state import ResolvedFinding, ReviewState

SHA = "a" * 40
NEXT = "b" * 40


def finding(finding_id: str = "f-1", **overrides: object) -> Finding:
    base: dict[str, object] = {
        "id": finding_id,
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


def run(*findings: Finding, resolved: tuple[str, ...] = (), sha: str = SHA) -> DynamicFindings:
    return DynamicFindings(reviewed_sha=sha, findings=findings, resolved_ids=resolved)


def state(
    *findings: Finding, resolved: tuple[ResolvedFinding, ...] = (), sha: str = SHA
) -> ReviewState:
    return ReviewState(reviewed_sha=sha, findings=findings, resolved=resolved)


# #199-T02
def test_an_omitted_previous_finding_stays_active() -> None:
    prior = state(finding("f-1"))

    after = reconcile(prior, run(sha=NEXT))

    assert [item.id for item in after.findings] == ["f-1"]
    assert after.resolved == ()


# #199-T02
def test_a_named_fix_becomes_resolved_and_is_not_active_again() -> None:
    prior = state(finding("f-1"), finding("f-2", title="Another"))

    after = reconcile(prior, run(resolved=("f-1",)))

    assert [item.id for item in after.findings] == ["f-2"]
    assert [entry.finding.id for entry in after.resolved] == ["f-1"]
    assert after.resolved[0].resolved_sha == SHA


# #199-T02
def test_a_finding_that_moves_keeps_its_id() -> None:
    prior = state(finding("f-1"))
    moved = finding("f-1", line_start=50, line_end=55, reviewed_sha=NEXT)

    after = reconcile(prior, run(moved, sha=NEXT))

    assert [item.id for item in after.findings] == ["f-1"]
    assert after.findings[0].line_start == 50
    assert after.findings[0].reviewed_sha == NEXT


# #199-T02
def test_a_rephrased_finding_under_a_new_id_is_folded_into_the_known_one() -> None:
    prior = state(finding("f-1"))

    after = reconcile(prior, run(finding("other-id", line_start=50), sha=NEXT))

    assert [item.id for item in after.findings] == ["f-1"]


# #199-T02
def test_a_run_that_repeats_itself_produces_no_duplicate() -> None:
    after = reconcile(None, run(finding("f-a"), finding("f-b", line_start=9), sha=NEXT))

    assert [item.id for item in after.findings] == ["f-a"]


# #199-T02
def test_a_resolved_finding_that_comes_back_is_re_opened() -> None:
    prior = state(
        resolved=(ResolvedFinding(finding=finding("f-1"), resolved_sha=SHA),),
    )

    after = reconcile(prior, run(finding("f-1", line_start=8), sha=NEXT))

    assert [item.id for item in after.findings] == ["f-1"]
    assert after.resolved == ()


# #199-T02
def test_a_contradicted_resolution_keeps_the_finding_active() -> None:
    prior = state(finding("f-1"))

    after = reconcile(prior, run(finding("f-1"), resolved=("f-1",), sha=NEXT))

    assert [item.id for item in after.findings] == ["f-1"]
    assert after.resolved == ()


# #199-T02
def test_an_unknown_resolution_is_ignored() -> None:
    prior = state(finding("f-1"))

    after = reconcile(prior, run(resolved=("never-existed",), sha=NEXT))

    assert [item.id for item in after.findings] == ["f-1"]
    assert after.resolved == ()


def test_identity_ignores_case_whitespace_and_line_position() -> None:
    assert identity_of(finding(title="  A   Finding ")) == identity_of(
        finding(title="a finding", line_start=9)
    )


def test_summary_counts_groups_by_priority() -> None:
    counts = summary_counts(
        (finding("a", priority="P0"), finding("b", priority="P0"), finding("c"))
    )

    assert counts == {"P0": 2, "P1": 1, "P2": 0, "P3": 0}


# #199-T10
def test_the_count_of_dropped_findings_is_carried_forward() -> None:
    prior = replace(state(finding("f-1")), omitted_findings=4)

    result = reconcile(prior, run(finding("f-2", title="Other"), sha=NEXT))

    assert result.omitted_findings == 4
