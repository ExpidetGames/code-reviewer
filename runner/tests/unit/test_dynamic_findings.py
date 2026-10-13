# SPDX-License-Identifier: Apache-2.0

"""Pins down the typed parser of the neutral Dynamic Review findings (#195).

It covers the ordered line range and the membership in the verified export, which the JSON Schema
cannot express, plus the safe path, and that resolutions live on the run envelope so a zero-finding
run can report them.
"""

import json
from typing import Any

import pytest

from code_reviewer_runner.dynamic_findings import (
    FindingsError,
    location_problem,
    parse_dynamic_findings,
)
from code_reviewer_runner.result import ErrorCode

SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"


def document(**overrides: Any) -> dict[str, Any]:
    finding = {
        "id": "f-1",
        "priority": "P1",
        "confidence": 0.5,
        "title": "A finding",
        "body": "body",
        "path": "src/api/handler.ts",
        "lineStart": 4,
        "lineEnd": 9,
        "evidence": ["src/api/handler.ts:4"],
        "reviewedSha": SHA,
    }
    base: dict[str, Any] = {
        "schemaVersion": 1,
        "reviewedSha": SHA,
        "resolvedIds": [],
        "findings": [finding],
    }
    base.update(overrides)
    return base


# #195 finding 5
def test_a_run_that_resolves_every_previous_finding_has_no_current_finding() -> None:
    parsed = parse_dynamic_findings(document(findings=[], resolvedIds=["old-1", "old-2"]))

    assert parsed.findings == ()
    assert parsed.resolved_ids == ("old-1", "old-2")


def test_it_refuses_resolutions_inside_a_finding() -> None:
    finding = document()["findings"][0]
    with pytest.raises(FindingsError) as refused:
        parse_dynamic_findings(document(findings=[{**finding, "resolvedIds": ["old"]}]))

    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #195 finding 6
def test_the_ordered_line_range_and_the_export_membership_are_semantic_checks() -> None:
    finding = document()["findings"][0]

    with pytest.raises(FindingsError) as refused:
        parse_dynamic_findings(document(findings=[{**finding, "lineStart": 9, "lineEnd": 1}]))
    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
    assert "lineStart" in refused.value.detail

    # A path outside the prepared export is not a review: it must not be rendered.
    with pytest.raises(FindingsError) as outside:
        parse_dynamic_findings(document(), exported_paths={"src/other.ts"})
    assert outside.value.code is ErrorCode.CHECKOUT_INCOMPLETE

    parsed = parse_dynamic_findings(document(), exported_paths={"src/api/handler.ts"})
    assert parsed.findings[0].path == "src/api/handler.ts"


def test_location_problem_is_none_for_a_safe_ordered_location() -> None:
    assert location_problem("src/a.ts", 1, 1, None) is None
    assert location_problem("src/a.ts", 3, 2, None) is not None
    assert location_problem("../a.ts", 1, 1, None) is not None


def test_it_refuses_an_unsafe_path_or_an_unknown_field() -> None:
    finding = document()["findings"][0]
    for path in ("../../outside.txt", "/etc/passwd", "C:\\secret", "a/../b"):
        with pytest.raises(FindingsError):
            parse_dynamic_findings(document(findings=[{**finding, "path": path}]))

    with pytest.raises(FindingsError) as refused:
        parse_dynamic_findings(document(findings=[{**finding, "command": "sh"}]))
    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


def test_it_parses_a_json_string_and_never_echoes_a_value() -> None:
    raw = json.dumps(document())
    assert parse_dynamic_findings(raw).findings[0].id == "f-1"

    secret = "super-secret-value"
    with pytest.raises(FindingsError) as refused:
        parse_dynamic_findings(
            document(findings=[{**document()["findings"][0], "title": ""}], reviewedSha=secret)
        )
    assert secret not in refused.value.detail
