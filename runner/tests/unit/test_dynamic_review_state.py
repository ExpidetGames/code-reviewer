# SPDX-License-Identifier: Apache-2.0

"""Pins down the persisted Dynamic Review state codec (#199).

The state is untrusted input read back from a comment: a corrupt, unknown-version or oversized state
must fail closed with a stable code, never be treated as "no state" that would silently forget the
history. The marker is base64 inside a fixed comment so no finding text can forge it.
"""

import base64
import json

import pytest

from code_reviewer_runner.dynamic_findings import Finding
from code_reviewer_runner.dynamic_review.state import (
    MARKER_PREFIX,
    MARKER_SUFFIX,
    MAX_FINDINGS,
    MAX_STATE_CHARS,
    ResolvedFinding,
    ReviewState,
    StateError,
    decode_state,
    encode_state,
    fit_state,
    parse_state_payload,
    render_previous_state,
)
from code_reviewer_runner.result import ErrorCode

SHA = "a" * 40


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


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schemaVersion": 1,
        "reviewedSha": SHA,
        "findings": [],
        "resolved": [],
    }
    base.update(overrides)
    return base


def marker_for(document: dict[str, object]) -> str:
    raw = json.dumps(document, ensure_ascii=True, separators=(",", ":"))
    return f"{MARKER_PREFIX}{base64.b64encode(raw.encode('ascii')).decode('ascii')}{MARKER_SUFFIX}"


def test_a_state_round_trips_through_the_marker() -> None:
    original = ReviewState(
        reviewed_sha=SHA,
        findings=(finding(),),
        resolved=(ResolvedFinding(finding=finding("old-1"), resolved_sha=SHA),),
    )

    decoded = decode_state(encode_state(original))

    assert decoded == original


def test_a_carried_over_finding_keeps_the_head_it_was_raised_at() -> None:
    older = "b" * 40
    original = ReviewState(
        reviewed_sha=SHA,
        findings=(finding("new"), finding("carried", reviewed_sha=older)),
        resolved=(),
    )

    decoded = decode_state(encode_state(original))

    assert decoded == original


def test_an_empty_state_encodes_to_nothing() -> None:
    assert encode_state(ReviewState(reviewed_sha="", findings=(), resolved=())) == ""


def test_there_is_no_state_without_a_marker() -> None:
    assert decode_state("## A comment without any state") is None


# #199-T09
def test_an_unknown_schema_version_fails_closed() -> None:
    with pytest.raises(StateError) as refused:
        decode_state(marker_for(payload(schemaVersion=2)))

    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #199-T09
def test_an_unknown_field_fails_closed() -> None:
    with pytest.raises(StateError):
        decode_state(marker_for(payload(command="sh")))


# #199-T09
def test_a_corrupt_payload_fails_closed() -> None:
    with pytest.raises(StateError):
        decode_state(f"{MARKER_PREFIX}AAAA{MARKER_SUFFIX}")


# #199-T05
def test_a_traversal_path_in_the_state_fails_closed() -> None:
    bad = finding(path="../../etc/passwd")
    document = payload(findings=[json.loads(json.dumps(_finding_json(bad)))])

    with pytest.raises(StateError):
        parse_state_payload(document)


def test_the_last_marker_wins() -> None:
    first = ReviewState(reviewed_sha=SHA, findings=(finding("first"),), resolved=())
    second = ReviewState(reviewed_sha=SHA, findings=(finding("second"),), resolved=())

    decoded = decode_state(f"{encode_state(first)}\n\ntext\n{encode_state(second)}")

    assert decoded is not None
    assert [item.id for item in decoded.findings] == ["second"]


# #199-T10
def test_an_oversized_state_fails_with_the_truncation_code() -> None:
    # Many resolved entries whose serialized payload crosses the state budget: it must fail closed,
    # not silently drop history to make the comment fit.
    resolved = tuple(
        ResolvedFinding(finding=finding(f"old-{index}", title="t" * 300), resolved_sha=SHA)
        for index in range(400)
    )
    oversized = ReviewState(
        reviewed_sha=SHA, findings=(finding(body="x" * 8000),), resolved=resolved
    )

    with pytest.raises(StateError) as refused:
        encode_state(oversized)

    assert refused.value.code is ErrorCode.REVIEW_STATE_TRUNCATED
    assert MAX_STATE_CHARS > 0


def test_previous_state_lists_only_the_active_findings() -> None:
    state = ReviewState(
        reviewed_sha=SHA,
        findings=(finding("f-1"),),
        resolved=(ResolvedFinding(finding=finding("old"), resolved_sha=SHA),),
    )

    text = render_previous_state(state)

    assert "f-1" in text
    assert "old" not in text


def _finding_json(finding: Finding) -> dict[str, object]:
    return {
        "id": finding.id,
        "priority": finding.priority,
        "confidence": finding.confidence,
        "title": finding.title,
        "body": finding.body,
        "path": finding.path,
        "lineStart": finding.line_start,
        "lineEnd": finding.line_end,
        "evidence": list(finding.evidence),
        "reviewedSha": finding.reviewed_sha,
    }


def many(count: int, prefix: str, **overrides: object) -> tuple[Finding, ...]:
    return tuple(
        finding(f"{prefix}-{index}", title=f"{prefix} {index}", **overrides)
        for index in range(count)
    )


# #199-T10
def test_the_encoder_refuses_what_the_decoder_would_reject() -> None:
    too_many = ReviewState(reviewed_sha=SHA, findings=many(MAX_FINDINGS + 1, "f"), resolved=())

    with pytest.raises(StateError):
        encode_state(too_many)


# #199-T10
def test_exceeding_the_active_cap_keeps_the_highest_priority_then_the_most_recent() -> None:
    # The list is newest first (this run's findings, then the carried-over ones).
    newest = many(20, "new", priority="P2")
    carried = many(20, "old", priority="P2")
    urgent = finding("urgent", title="urgent", priority="P0")
    fitted = fit_state(
        ReviewState(reviewed_sha=SHA, findings=(*newest, *carried, urgent), resolved=())
    )

    ids = [item.id for item in fitted.findings]
    # Everything P2 at the front of the list is newer, so the oldest P2 findings are the ones cut.
    assert ids == [*(f"new-{i}" for i in range(20)), *(f"old-{i}" for i in range(9)), "urgent"]
    assert fitted.omitted_findings == 11
    assert decode_state(encode_state(fitted)) == fitted


# #199-T10
def test_dropped_findings_are_never_recorded_as_resolved() -> None:
    state = ReviewState(
        reviewed_sha=SHA,
        findings=many(MAX_FINDINGS + 5, "f"),
        resolved=(ResolvedFinding(finding=finding("done"), resolved_sha=SHA),),
    )

    fitted = fit_state(state)

    assert [entry.finding.id for entry in fitted.resolved] == ["done"]
    assert fitted.omitted_findings == 5


# #199-T10
def test_the_omitted_count_accumulates_across_writes_and_round_trips() -> None:
    first = fit_state(ReviewState(reviewed_sha=SHA, findings=many(33, "a"), resolved=()))
    second = fit_state(
        ReviewState(
            reviewed_sha=SHA,
            findings=(*first.findings, *many(4, "b")),
            resolved=(),
            omitted_findings=first.omitted_findings,
        )
    )

    assert first.omitted_findings == 3
    assert second.omitted_findings == 7
    assert decode_state(encode_state(second)) == second


# #199-T10
def test_a_state_within_the_caps_and_budget_is_returned_unchanged() -> None:
    state = ReviewState(reviewed_sha=SHA, findings=many(MAX_FINDINGS, "f"), resolved=())

    assert fit_state(state) == state


# #199-T10
def test_over_the_budget_the_oldest_resolved_history_goes_first() -> None:
    resolved = tuple(
        ResolvedFinding(
            finding=finding(f"old-{index}", title="t" * 300, body="b" * 400), resolved_sha=SHA
        )
        for index in range(450)
    )
    active = many(10, "live")
    state = ReviewState(reviewed_sha=SHA, findings=active, resolved=resolved)
    with pytest.raises(StateError):
        encode_state(state)

    fitted = fit_state(state)

    assert fitted.findings == active
    assert fitted.omitted_findings == 0
    assert 0 < len(fitted.resolved) < len(resolved)
    # The newest history stays, the oldest is trimmed.
    assert fitted.resolved == resolved[len(resolved) - len(fitted.resolved) :]
    assert len(encode_state(fitted)) <= MAX_STATE_CHARS
    assert decode_state(encode_state(fitted)) == fitted


# #199-T10
def test_when_the_active_findings_alone_exceed_the_budget_the_lowest_priority_go() -> None:
    big = {"body": "x" * 8000, "evidence": ("e" * 1000,) * 5}
    findings = (
        *many(15, "low", priority="P3", **big),
        finding("urgent", title="urgent", priority="P0", **big),
        *many(14, "mid", priority="P1", **big),
    )
    state = ReviewState(reviewed_sha=SHA, findings=findings, resolved=())
    with pytest.raises(StateError):
        encode_state(state)

    fitted = fit_state(state)

    ids = [item.id for item in fitted.findings]
    assert 1 < len(ids) < len(findings)
    assert ids == ["urgent", *(f"mid-{index}" for index in range(len(ids) - 1))]
    assert fitted.omitted_findings == len(findings) - len(ids)
    assert fitted.resolved == ()
    assert len(encode_state(fitted)) <= MAX_STATE_CHARS
    assert decode_state(encode_state(fitted)) == fitted


# #199-T09
@pytest.mark.parametrize("value", [-1, True, "3", 1_000_001])
def test_an_invalid_omitted_count_fails_closed(value: object) -> None:
    with pytest.raises(StateError) as refused:
        decode_state(marker_for(payload(omittedFindings=value)))

    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
