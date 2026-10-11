# SPDX-License-Identifier: Apache-2.0

"""Documents how PR-Agent 0.47.0 lets the hidden record of findings grow, because that decides why
the runner reports a full comment instead of bounding the record (see "The review comment size
limit" in the README). If an upgrade changes the retention, these tests fail and the decision is due
again."""

from typing import Any

from pr_agent.algo import review_finding_state
from pr_agent.algo.review_finding_state import reconcile_review_findings


def findings(prefix: str, count: int) -> list[dict[str, Any]]:
    return [
        {"path": "greeting.py", "body": f"{prefix} finding {index} " + "x" * 600}
        for index in range(count)
    ]


def run(
    previous: dict[str, Any] | None, current: list[dict[str, Any]], head: str, resolve: bool
) -> dict[str, Any]:
    result = reconcile_review_findings(
        previous, current, allow_resolution=resolve, head_sha=head, run_id=head
    )
    return result.state


def test_findings_the_review_no_longer_reports_stay_active_when_the_run_cannot_resolve_them() -> (
    None
):
    state = run(None, findings("first", 30), "a", resolve=False)

    state = run(state, findings("second", 30), "b", resolve=False)

    assert [f["state"] for f in state["findings"]].count("ACTIVE") == 60


def test_pr_agent_keeps_at_most_twenty_resolved_findings_and_every_active_one() -> None:
    assert review_finding_state.DEFAULT_MAX_RESOLVED_FINDINGS == 20
    state = run(None, findings("first", 50), "a", resolve=False)

    state = run(state, findings("second", 40), "b", resolve=True)

    states = [f["state"] for f in state["findings"]]
    assert states.count("RESOLVED") == 20
    assert states.count("ACTIVE") == 40


def test_the_record_grows_with_every_new_finding_in_the_size_of_its_text() -> None:
    state = run(None, findings("first", 30), "a", resolve=False)
    small = len(review_finding_state.serialize_review_state(state))

    state = run(state, findings("second", 30), "b", resolve=False)
    large = len(review_finding_state.serialize_review_state(state))

    assert large > small * 1.9
