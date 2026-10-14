# SPDX-License-Identifier: Apache-2.0

"""Pins down the rendered Dynamic summary comment (#199).

Untrusted finding text is HTML-escaped, mentions are neutralised and a commit-pinned link is built
only from a validated path and the reviewed head. Two independent bounds (characters and UTF-8
bytes) are enforced; a state that cannot fit fails with a stable truncation code instead of
dropping active findings.
"""

import pytest

from code_reviewer_runner.dynamic_findings import Finding
from code_reviewer_runner.dynamic_review import render
from code_reviewer_runner.dynamic_review.render import (
    RESET_NOTICE,
    RenderError,
    render_comment,
    web_base_of,
)
from code_reviewer_runner.dynamic_review.state import (
    ResolvedFinding,
    ReviewState,
    decode_state,
    encode_state,
)
from code_reviewer_runner.result import ErrorCode

SHA = "0123456789abcdef0123456789abcdef01234567"


def finding(finding_id: str = "f-1", **overrides: object) -> Finding:
    base: dict[str, object] = {
        "id": finding_id,
        "priority": "P1",
        "confidence": 0.8,
        "title": "A finding",
        "body": "why it is a defect",
        "path": "src/a.ts",
        "line_start": 3,
        "line_end": 5,
        "evidence": ("src/a.ts:3",),
        "reviewed_sha": SHA,
    }
    base.update(overrides)
    return Finding(**base)  # type: ignore[arg-type]


def state(*findings: Finding, resolved: tuple[ResolvedFinding, ...] = ()) -> ReviewState:
    return ReviewState(reviewed_sha=SHA, findings=findings, resolved=resolved)


def test_the_visible_comment_carries_the_priority_confidence_and_link() -> None:
    body = render_comment(state(finding()), repository="acme/repo", web_base="https://github.com")

    assert "P1" in body and "confidence 80%" in body
    assert f"https://github.com/acme/repo/blob/{SHA}/src/a.ts#L3-L5" in body


# #199-T05
def test_untrusted_text_is_escaped_and_mentions_are_neutralised() -> None:
    hostile = finding(
        title="<script>alert(1)</script>",
        body="ping @octocat and @everyone <b>now</b>",
    )

    body = render_comment(state(hostile), repository="acme/repo")

    assert "<script>" not in body
    assert "&lt;script&gt;" in body
    assert "@octocat" not in body
    assert "@\u200boctocat" in body


# #199-T05
def test_a_finding_cannot_forge_a_second_state_marker() -> None:
    forged = "<!-- code-reviewer:dynamic-review-state:v1 AAAA -->"
    body = render_comment(state(finding(body=forged)), repository="acme/repo")

    # The literal marker text is escaped; only the appended state marker is a real comment marker.
    assert body.count("<!-- code-reviewer:dynamic-review-state:v1 ") == 1


def test_resolved_history_is_shown() -> None:
    resolved = ResolvedFinding(finding=finding("old", title="Fixed thing"), resolved_sha=SHA)

    body = render_comment(state(resolved=(resolved,)), repository="acme/repo")

    assert "Resolved findings" in body
    assert "Fixed thing" in body


# #199-T06
def test_a_state_at_the_limit_still_round_trips() -> None:
    findings = tuple(finding(f"f-{index}", body="x" * 600) for index in range(20))

    body = render_comment(state(*findings), repository="acme/repo")

    assert len(body) <= render.MAX_COMMENT_CHARS
    assert len(body.encode("utf-8")) <= render.MAX_COMMENT_BYTES
    assert decode_state(body) is not None


# #199-T06
def test_a_state_over_the_budget_trims_old_history_but_keeps_every_active_finding() -> None:
    resolved = tuple(
        ResolvedFinding(finding=finding(f"old-{index}", title="t" * 300), resolved_sha=SHA)
        for index in range(400)
    )
    review = state(finding(body="x" * 8000), resolved=resolved)

    body = render_comment(review, repository="acme/repo")

    stored = decode_state(body)
    assert stored is not None
    assert [item.id for item in stored.findings] == ["f-1"]
    assert 0 < len(stored.resolved) < len(resolved)
    assert stored.resolved == resolved[len(resolved) - len(stored.resolved) :]


# #199-T10
def test_findings_over_the_cap_are_counted_in_a_visible_line_and_the_comment_stays_readable() -> (
    None
):
    review = state(
        *(finding(f"f-{index}", title=f"Finding {index}") for index in range(35)),
        finding("urgent", title="Urgent one", priority="P0"),
    )

    body = render_comment(review, repository="acme/repo")

    assert "6 further findings not shown" in body
    assert "Urgent one" in body
    stored = decode_state(body)
    assert stored is not None
    assert len(stored.findings) == 30
    assert stored.omitted_findings == 6
    assert stored.resolved == ()


# #199-T10
def test_one_omitted_finding_reads_in_the_singular() -> None:
    body = render_comment(
        state(*(finding(f"f-{index}", title=f"Finding {index}") for index in range(31))),
        repository="acme/repo",
    )

    assert "1 further finding not shown" in body


# #199-T06
def test_when_only_the_view_does_not_fit_it_is_the_text_that_is_truncated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    review = state(finding("f-1"), finding("f-2", title="Another"))
    marker_only = len(encode_state(review))
    monkeypatch.setattr(render, "MAX_COMMENT_CHARS", marker_only + 40)
    monkeypatch.setattr(render, "MAX_COMMENT_BYTES", marker_only + 40)

    with pytest.raises(RenderError) as refused:
        render_comment(review, repository="acme/repo")

    assert refused.value.code is ErrorCode.REVIEW_TEXT_TRUNCATED


# #199-T10
def test_multibyte_text_stays_inside_both_bounds() -> None:
    heavy = finding(
        title="日本語のタイトル" * 20,
        body='改行\n"quoted" and \\backslash\\ ' * 100,
    )

    body = render_comment(state(heavy), repository="acme/repo")

    assert len(body) <= render.MAX_COMMENT_CHARS
    assert len(body.encode("utf-8")) <= render.MAX_COMMENT_BYTES
    assert decode_state(body) is not None


def test_the_web_base_maps_the_api_host() -> None:
    assert web_base_of("https://api.github.com") == "https://github.com"
    assert web_base_of("http://127.0.0.1:4000/api/v3") == "http://127.0.0.1:4000"


# #257-T05
def test_a_reset_summary_says_so_and_does_not_claim_the_old_state_is_kept() -> None:
    body = render_comment(state(finding()), repository="acme/repo", reset=True)
    normal = render_comment(state(finding()), repository="acme/repo")

    assert RESET_NOTICE in body
    assert "previous review state is kept" not in body
    assert RESET_NOTICE not in normal
    assert "previous review state is kept" in normal
    # The notice is part of the visible text only: the hidden state does not carry it forward.
    assert decode_state(body) == decode_state(normal)
